#!/usr/bin/env node
/**
 * Acceptance check: does discovery's *effective* configuration do what it
 * promises?
 *
 *   node scripts/verify.mjs [models-store.json] [--expectations file.json]
 *
 * Two kinds of check live here:
 *
 * 1. Universal invariants — true of every gateway, so they need no
 *    configuration and run even with no expectations file:
 *      - strict-by-default compat is stamped on every model
 *      - no model that is not an OpenAI-family id is routed to /responses
 *      - families that can never serve a chat request are not registered
 *
 * 2. Deployment expectations — per-lane protocol and per-family effort
 *    vocabularies are properties of a specific backend, so they come from an
 *    expectations JSON rather than being hardcoded here. That keeps one
 *    company's gateway topology out of a general-purpose tool, and lets a
 *    deployment assert *its* contract without forking this file.
 *
 * Exit code is the number of failures, so it composes as a CI gate.
 */
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--expectations");

const STORE = positional[0] ?? ".dev/agent/models-store.json";
const EXPECT_PATH = opt("expectations", ".dev/agent/expectations.json");

const store = JSON.parse(readFileSync(STORE, "utf8"));
const models = Object.entries(store).flatMap(([gw, blob]) =>
  (blob.models ?? []).map((m) => ({ gw: m.provider ?? gw, ...m })));

const expectations = existsSync(EXPECT_PATH)
  ? JSON.parse(readFileSync(EXPECT_PATH, "utf8"))
  : undefined;

const pass = [];
const fail = [];
const check = (name, ok, detail = "") => (ok ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ""}`);
const of = (gw) => models.filter((m) => m.gw === gw);

console.log(`\nEffective-config acceptance check`);
console.log(`  catalog     : ${STORE}  (${models.length} models, ${Object.keys(store).length} gateways)`);
console.log(`  expectations: ${expectations ? EXPECT_PATH : "(none — universal invariants only)"}`);
console.log();

// --- 1. universal invariants ----------------------------------------------
{
  const missing = models.filter((m) => m.compat?.supportsStore !== false);
  check("supportsStore=false on every discovered model",
    models.length > 0 && missing.length === 0, `${models.length - missing.length}/${models.length}`);
}
{
  const missing = models.filter((m) => m.compat?.supportsDeveloperRole !== false);
  check("supportsDeveloperRole=false on every discovered model",
    models.length > 0 && missing.length === 0, `${models.length - missing.length}/${models.length}`);
}
{
  // A name-keyed rule that leaks across vendors is the failure mode this project
  // actually hit: it re-routes another vendor's model to a surface it does not
  // have, and the symptom is a 404 that looks like a backend bug.
  const openAiFamily = /^(gpt-|o\d[\d.]*(-|$))/u;
  const leaked = models.filter((m) => m.api === "openai-responses" && !openAiFamily.test(m.id));
  check("no non-OpenAI model routed to openai-responses",
    leaked.length === 0, leaked.length ? leaked.slice(0, 6).map((m) => `${m.gw}/${m.id}`).join(", ") : "");
}
{
  const banned = /(^|[/:._-])(realtime|computer-use|turbo-instruct|search-preview|search-api|deep-research|voxtral|omni|antigravity|embed|embedding|rerank|tts|whisper|moderation|dall-e|sora|veo|lyria)([/:._-]|$)/u;
  const leaked = models.filter((m) => banned.test(m.id.toLowerCase()));
  check("no non-chat / capability-less family registered",
    leaked.length === 0, leaked.length ? leaked.slice(0, 8).map((m) => m.id).join(", ") : "");
}

// --- 2. deployment expectations -------------------------------------------
if (expectations) {
  for (const [laneId, want] of Object.entries(expectations.lanes ?? {})) {
    const lane = of(laneId);
    if (!lane.length) {
      check(`lane ${laneId} registered`, false, "no models — discovery may have failed");
      continue;
    }
    if (want.api) {
      const wrong = lane.filter((m) => m.api !== want.api);
      check(`lane ${laneId}: all models on ${want.api}`, wrong.length === 0,
        `${lane.length - wrong.length}/${lane.length}${wrong.length ? ` e.g. ${wrong[0].id}` : ""}`);
    }
    if (want.apiNot) {
      const wrong = lane.filter((m) => m.api === want.apiNot);
      check(`lane ${laneId}: no model forced onto ${want.apiNot}`, wrong.length === 0, `${wrong.length}`);
    }
    if (want.minModels !== undefined) {
      check(`lane ${laneId}: at least ${want.minModels} models`, lane.length >= want.minModels, `${lane.length}`);
    }
  }

  for (const rule of expectations.vocab ?? []) {
    const re = new RegExp(rule.match, "u");
    const ms = of(rule.gateway).filter((m) => re.test(m.id));
    if (!ms.length) { check(`vocab ${rule.match} has models on ${rule.gateway}`, false, "none registered"); continue; }
    const bad = ms.filter((m) =>
      Object.entries(rule.expect).some(([lvl, val]) => m.thinkingLevelMap?.[lvl] !== val));
    check(`vocab ${rule.gateway} /${rule.match}/`, bad.length === 0,
      `${ms.length - bad.length}/${ms.length}${bad.length ? ` e.g. ${bad[0].id} got ${JSON.stringify(bad[0].thinkingLevelMap?.[Object.keys(rule.expect)[0]])}` : ""}`);
  }

  for (const rule of expectations.responsesFor ?? []) {
    const re = new RegExp(rule.match, "u");
    const ms = of(rule.gateway).filter((m) => re.test(m.id));
    const wrong = ms.filter((m) => m.api !== "openai-responses");
    check(`${rule.gateway} /${rule.match}/ routed to /responses`, ms.length > 0 && wrong.length === 0,
      `${ms.length - wrong.length}/${ms.length}`);
  }

  for (const rule of expectations.staysOnCompletions ?? []) {
    const re = new RegExp(rule.match, "u");
    const ms = of(rule.gateway).filter((m) => re.test(m.id));
    const wrong = ms.filter((m) => m.api !== "openai-completions");
    check(`${rule.gateway} /${rule.match}/ stays on /chat/completions`, ms.length > 0 && wrong.length === 0,
      `${ms.length - wrong.length}/${ms.length}${wrong.length ? ` e.g. ${wrong[0].id}` : ""}`);
  }
}

// --- 3. alias consistency --------------------------------------------------
// One model listed under several ids must be configured identically. A rule
// keyed only on the id can disagree with itself across aliases, and the more
// restrictive variant wins.
for (const rule of expectations?.aliasConsistency ?? []) {
  const ms = rule.ids.map((id) => of(rule.gateway).find((m) => m.id === id)).filter(Boolean);
  if (ms.length < 2) continue;
  const maps = new Set(ms.map((m) => JSON.stringify(m.thinkingLevelMap ?? null)));
  check(`aliases agree: ${rule.gateway} ${rule.ids.join(" = ")}`, maps.size === 1,
    maps.size === 1 ? `${ms.length}/${ms.length} identical` : [...maps].join(" vs ").slice(0, 120));
}

// --- report ---------------------------------------------------------------
for (const p of pass) console.log(`  PASS  ${p}`);
for (const f of fail) console.log(`  FAIL  ${f}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length === 0 ? 0 : 1);
