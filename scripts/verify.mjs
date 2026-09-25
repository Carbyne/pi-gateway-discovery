#!/usr/bin/env node
/**
 * Acceptance verifier for gateway auto-configuration.
 *
 * Reads a models-store.json produced by discovery and checks that discovery
 * alone reproduces the per-lane / per-family tuning that was originally
 * hand-authored in gateway-discovery.json.
 *
 *   node scripts/verify.mjs [.dev/agent/models-store.json]
 *
 * Exit code 0 = every expectation met. Non-zero = number of failures, so this
 * is usable as a CI gate.
 */
import { readFileSync } from "node:fs";

const STORE = process.argv[2] ?? ".dev/agent/models-store.json";
const store = JSON.parse(readFileSync(STORE, "utf8"));

const models = [];
for (const [gwId, blob] of Object.entries(store))
  for (const m of blob.models ?? []) models.push({ gw: gwId, ...m });

const pass = [];
const fail = [];
const check = (name, ok, detail = "") => (ok ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ""}`);

const of = (gw) => models.filter((m) => m.gw === gw);
const withId = (gw, re) => of(gw).filter((m) => re.test(m.id));
const compatIs = (m, key, val) => m.compat?.[key] === val;

// --- R1: lane protocol is negotiated, not defaulted -----------------------
check("R1 yoda-claude registered (discovery succeeded at all)", of("yoda-claude").length > 0,
  `${of("yoda-claude").length} models`);
{
  const wrong = of("yoda-claude").filter((m) => m.api !== "anthropic-messages");
  check("R1 claude lane uses anthropic-messages", of("yoda-claude").length > 0 && wrong.length === 0,
    `${of("yoda-claude").length - wrong.length}/${of("yoda-claude").length}`);
}
{
  // Negotiation must not touch OpenAI-shaped lanes; only the quirk table may
  // move individual models to /responses. So: models outside the
  // responses-required families stay on openai-completions, and the ones inside
  // them are switched. Both directions are asserted.
  const responsesFamilies = /^gpt-5\.(3-codex|4|5|6)|^gpt-6|^o[13]-pro$|-pro(?:-20\d{2}-\d{2}-\d{2})?$/u;
  const lane = of("yoda-openai");
  const shouldStay = lane.filter((m) => !responsesFamilies.test(m.id));
  const shouldSwitch = lane.filter((m) => responsesFamilies.test(m.id));
  const wrongStay = shouldStay.filter((m) => m.api !== "openai-completions");
  const wrongSwitch = shouldSwitch.filter((m) => m.api !== "openai-responses");
  check("R1 non-responses families stay on openai-completions",
    wrongStay.length === 0, `${shouldStay.length - wrongStay.length}/${shouldStay.length}`);
  check("R1 -pro / gpt-5.4+ families routed to openai-responses",
    shouldSwitch.length > 0 && wrongSwitch.length === 0,
    `${shouldSwitch.length - wrongSwitch.length}/${shouldSwitch.length}`);
}

// --- R2: strict-by-default compat ----------------------------------------
for (const gw of ["yoda-gemini", "yoda-mistral", "yoda-openai", "yoda-kyber", "yoda-claude"]) {
  const ms = of(gw);
  if (!ms.length) continue;
  check(`R2 ${gw}: supportsStore=false on all models`, ms.every((m) => compatIs(m, "supportsStore", false)),
    `${ms.filter((m) => compatIs(m, "supportsStore", false)).length}/${ms.length}`);
  check(`R2 ${gw}: supportsDeveloperRole=false on all models`,
    ms.every((m) => compatIs(m, "supportsDeveloperRole", false)),
    `${ms.filter((m) => compatIs(m, "supportsDeveloperRole", false)).length}/${ms.length}`);
}

// --- R4: non-chat / unavailable families are not registered --------------
{
  const banned = /realtime|computer-use|turbo-instruct|search-preview|deep-research|voxtral|omni|antigravity|\/aqa$|^aqa$/u;
  const leaked = models.filter((m) => banned.test(m.id));
  check("R4 non-chat/unavailable families excluded", leaked.length === 0,
    leaked.length ? `leaked: ${leaked.map((m) => m.id).join(", ")}` : "");
}

// --- R5: per-family reasoning-effort vocabulary --------------------------
const VOCAB = [
  // [gateway, pattern, level -> expected wire value (null = unsupported)]
  ["yoda-mistral", /^(mistral-medium|magistral-|mistral-small|mistral-vibe-cli)/u,
    { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null }],
  ["yoda-mistral", /^zai-glm/u, { minimal: null, low: "low", medium: null, high: "high", max: "max" }],
  ["yoda-gemini", /^gemma-4/u, { off: null, low: null, medium: null, high: "high", max: null }],
];
for (const [gw, re, expect] of VOCAB) {
  const ms = withId(gw, re);
  if (!ms.length) { check(`R5 ${gw} ${re.source} has models`, false, "none registered"); continue; }
  const bad = ms.filter((m) =>
    Object.entries(expect).some(([lvl, val]) => m.thinkingLevelMap?.[lvl] !== val));
  check(`R5 ${gw}: effort vocab for ${re.source.slice(0, 28)}…`,
    bad.length === 0, `${ms.length - bad.length}/${ms.length}${bad.length ? ` e.g. ${bad[0].id}` : ""}`);
}

// --- R6: quirk rules must not leak across vendors ------------------------
// A name-keyed table is only safe if a rule cannot fire on another vendor's
// model. `gemini-2.5-pro` matching a bare `-pro$` rule 404s it on a lane that
// has no /responses surface at all.
{
  const openAiFamily = /^(gpt-|o\d[\d.]*(-|$))/u;
  const leaked = models.filter((m) => m.api === "openai-responses" && !openAiFamily.test(m.id));
  check("R6 no non-OpenAI model routed to openai-responses", leaked.length === 0,
    leaked.length ? `leaked: ${leaked.map((m) => `${m.gw}/${m.id}`).join(", ")}` : "");
}

// --- R7: "off" must be handled per family, never blanket-stamped ---------
// pi core's /responses client emits `reasoning: {effort:"none"}` unless
// thinkingLevelMap.off is explicitly null. Some models reject "none" (o-series
// pro) and need off:null; others *accept* "none" and are broken by off:null,
// because pi then clamps a user's "off" up to `minimal`, which they reject.
// Both directions are asserted so neither default can silently regress.
{
  const acceptsNone = of("yoda-openai").filter((m) =>
    /^(gpt-5\.[4-9]|gpt-6)/u.test(m.id) && !/-pro/u.test(m.id) && m.api === "openai-responses");
  const wronglyNull = acceptsNone.filter((m) => m.thinkingLevelMap?.off === null);
  check("R7 gpt-5.4+/gpt-6 keep off usable (they accept effort 'none')",
    acceptsNone.length > 0 && wronglyNull.length === 0,
    `${acceptsNone.length - wronglyNull.length}/${acceptsNone.length}${wronglyNull.length ? ` e.g. ${wronglyNull[0].id}` : ""}`);

  const oPro = of("yoda-openai").filter((m) => /^o\d[\d.]*-pro/u.test(m.id));
  const badOPro = oPro.filter((m) => m.thinkingLevelMap?.off !== null || m.thinkingLevelMap?.minimal !== null);
  check("R7 o-series pro set off:null and minimal:null (they reject 'none' and 'minimal')",
    oPro.length > 0 && badOPro.length === 0,
    `${oPro.length - badOPro.length}/${oPro.length}`);
}

// --- R8: narrow rules must survive the broad rule (merge, not first-match) ---
{
  const p5 = of("yoda-openai").filter((m) => /^gpt-5-pro/u.test(m.id));
  check("R8 gpt-5-pro keeps its 'high'-only vocabulary despite NEEDS_RESPONSES",
    p5.length > 0 && p5.every((m) => m.thinkingLevelMap?.low === null && m.thinkingLevelMap?.high === "high"),
    `${p5.filter((m) => m.thinkingLevelMap?.low === null).length}/${p5.length}`);
  const p52 = of("yoda-openai").filter((m) => /^gpt-5\.[2-9]-pro/u.test(m.id));
  check("R8 gpt-5.x-pro keeps medium/high/xhigh",
    p52.length > 0 && p52.every((m) => m.thinkingLevelMap?.low === null && m.thinkingLevelMap?.medium === "medium"),
    `${p52.filter((m) => m.thinkingLevelMap?.medium === "medium").length}/${p52.length}`);
}

// --- R9: upstream-declared vocabulary must beat a name guess -------------
// `yoda/qwen3.8-flash` publishes supported_efforts [xhigh, medium, low, none].
// Nothing in the quirk table matches that id, so a correct map here can only
// come from reading the field — and it proves declared > quirk precedence.
{
  const q = of("yoda-kyber").find((m) => /qwen/u.test(m.id));
  const tlm = q?.thinkingLevelMap;
  const ok = !!tlm && tlm.low === "low" && tlm.medium === "medium" && tlm.xhigh === "xhigh"
    && tlm.high === null && tlm.max === null && tlm.off === "none";
  check("R9 declared supported_efforts honoured (kyber qwen)", ok,
    tlm ? JSON.stringify(tlm) : "no thinkingLevelMap");
}

// --- R10: rules must fire on vendor-namespaced ids -----------------------
// `yoda/mistral-medium-3.5` is the same model as bare `mistral-medium-3.5`;
// anchoring on the bare name makes the rule silently no-op on namespaced lanes.
{
  const m = of("yoda-kyber").find((x) => /mistral-medium/u.test(x.id));
  const ok = !!m?.thinkingLevelMap && m.thinkingLevelMap.low === null
    && m.thinkingLevelMap.high === "high" && m.thinkingLevelMap.off === "none";
  check("R10 quirk fires through a 'yoda/' id prefix", ok,
    m ? JSON.stringify(m.thinkingLevelMap) : "model not registered");
}

// --- report ---------------------------------------------------------------
const width = Math.max(...[...pass, ...fail].map((s) => s.length), 10);
console.log(`\nEffective-config acceptance check (${STORE})`);
console.log(`${models.length} models across ${Object.keys(store).length} gateways\n`);
for (const p of pass) console.log(`  PASS  ${p}`);
for (const f of fail) console.log(`  FAIL  ${f}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length === 0 ? 0 : 1);
