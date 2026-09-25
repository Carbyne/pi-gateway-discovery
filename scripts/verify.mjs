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

// --- report ---------------------------------------------------------------
const width = Math.max(...[...pass, ...fail].map((s) => s.length), 10);
console.log(`\nEffective-config acceptance check (${STORE})`);
console.log(`${models.length} models across ${Object.keys(store).length} gateways\n`);
for (const p of pass) console.log(`  PASS  ${p}`);
for (const f of fail) console.log(`  FAIL  ${f}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length === 0 ? 0 : 1);
