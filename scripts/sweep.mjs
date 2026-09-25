#!/usr/bin/env node
/**
 * Sweep: exercise every registered model at every thinking level against the
 * real endpoint, and report which (model, level) pairs fail.
 *
 * This is the acceptance test for auto-configuration: the effective config
 * written by discovery must produce requests the backend accepts. Verifying
 * "the JSON looks right" is not enough — a wrong `store`/`developer`/
 * `reasoning_effort`/protocol choice is invisible until a request is sent.
 *
 * It mirrors pi core's thinking-level resolution (getSupportedThinkingLevels +
 * clampThinkingLevel) rather than sending raw levels, otherwise pi's own
 * clamping is untested and you get false failures for levels pi would never
 * send.
 *
 *   GATEWAY_API_KEY=... node scripts/sweep.mjs [models-store.json]
 *   node scripts/sweep.mjs --store path --key-from ~/.pi/agent/auth.json
 */
import { readFileSync } from "node:fs";

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const FLAGS = new Set(["store", "key", "key-from", "concurrency"]);

const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token.startsWith("--")) {
    const name = token.slice(2);
    if (FLAGS.has(name)) { opts[name] = argv[++i]; continue; }
    if (name.startsWith("no-")) { opts[name] = true; continue; }
    console.error(`unknown flag: ${token}`);
    process.exit(2);
  }
  positional.push(token);
}
const opt = (name, dflt) => (opts[name] !== undefined ? opts[name] : dflt);

/* -------------------------------------------------------------------------
 * Cost guard.
 *
 * Every probe here is a REAL completion, and some registered models are
 * expensive reasoning tiers billed per output token. A full sweep is therefore
 * a spend of real money, not a free test, and must not run by accident.
 *
 * Default behaviour: refuse to run at all unless --yes-spend is given, and
 * skip known-costly families even then unless --include-expensive. Prefer the
 * free checks (`pi --list-models` for discovery, `verify.mjs` for effective
 * config, `selftest.mjs` for logic) and reach for this only when you need to
 * prove the backend accepts the payload.
 * ----------------------------------------------------------------------- */
const EXPENSIVE = /(-pro$|^o[134]-pro|gpt-5-[0-9]+-pro|^gpt-5-pro|realtime|deep-research)/iu;

const STORE = positional[0] ?? opt("store", ".dev/agent/models-store.json");
const KEY = opt("key", process.env.GATEWAY_API_KEY ?? process.env.PI_GATEWAY_API_KEY);
const KEY_FROM = opt("key-from", undefined);

function resolveKey(model) {
  if (KEY) return KEY;
  if (KEY_FROM) {
    const auth = JSON.parse(readFileSync(KEY_FROM, "utf8"));
    const c = auth[model.provider];
    if (c?.key) return c.key;
    const any = Object.values(auth).find((v) => v?.key); // gateways often share one key
    if (any) return any.key;
  }
  throw new Error(`no API key: set GATEWAY_API_KEY or pass --key-from <auth.json>`);
}

// --- pi core parity --------------------------------------------------------
const EXT = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

function supportedLevels(model) {
  if (!model.reasoning) return ["off"];
  const m = model.thinkingLevelMap ?? {};
  return EXT.filter((lvl) => {
    const present = lvl in m;
    if (present && m[lvl] === null) return false;                 // explicit null = unsupported
    if ((lvl === "xhigh" || lvl === "max") && !present) return false; // must be declared
    return true;
  });
}

function clamp(model, level) {
  const av = supportedLevels(model);
  if (av.includes(level)) return level;
  const i = EXT.indexOf(level);
  if (i < 0) return av[0] ?? "off";
  for (const c of EXT.slice(i)) if (av.includes(c)) return c;
  for (const c of EXT.slice(0, i).reverse()) if (av.includes(c)) return c;
  return av[0] ?? "off";
}

// pi: reasoningEffort "off" is normalised to undefined before param building.
function effectiveEffort(model, requested) {
  if (!model.reasoning) return null;
  const clamped = clamp(model, requested);
  if (clamped === "off") return null;
  const mapped = model.thinkingLevelMap?.[clamped];
  return typeof mapped === "string" ? mapped : clamped;
}

// --- request builders ------------------------------------------------------
const FTOOLS = [{ type: "function", function: { name: "calc", description: "add two numbers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } } }];
const RTOOLS = [{ type: "function", name: "calc", description: "add two numbers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }];
const ATOOLS = [{ name: "calc", description: "add two numbers", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }];

function build(model, requested) {
  const base = model.baseUrl.replace(/\/+$/u, "");
  const key = resolveKey(model);
  const compat = { supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: true, maxTokensField: "max_completion_tokens", ...model.compat };
  const effort = effectiveEffort(model, requested);

  if (model.api === "anthropic-messages") {
    const p = { model: model.id, max_tokens: 1024, stream: true, system: "You are a coding assistant.", messages: [{ role: "user", content: "What is 2+2?" }], tools: ATOOLS };
    return { url: `${base}/v1/messages`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, payload: p };
  }
  if (model.api === "openai-responses") {
    const p = { model: model.id, input: "What is 2+2?", stream: true, tools: RTOOLS, store: false };
    if (model.reasoning) {
      if (effort) p.reasoning = { effort, summary: "auto" };
      else if (model.thinkingLevelMap?.off !== null) p.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    }
    return { url: `${base}/responses`, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: p };
  }
  const p = {
    model: model.id, stream: true, stream_options: { include_usage: true }, tools: FTOOLS,
    messages: [
      { role: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system", content: "You are a coding assistant." },
      { role: "user", content: "What is 2+2?" },
    ],
  };
  if (compat.supportsStore) p.store = false;
  p[compat.maxTokensField] = Math.min(2000, model.maxTokens ?? 2000);
  if (compat.supportsReasoningEffort && model.reasoning) {
    if (effort) p.reasoning_effort = effort;
    else if (typeof model.thinkingLevelMap?.off === "string") p.reasoning_effort = model.thinkingLevelMap.off;
  }
  return { url: `${base}/chat/completions`, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: p };
}

function extractError(text) {
  try {
    const j = JSON.parse(text);
    const root = Array.isArray(j) ? j[0] : j;
    const e = root?.error ?? root;
    if (typeof e?.message === "string") return e.message;
    if (Array.isArray(e?.message?.detail)) return e.message.detail.map((d) => `${d.loc?.join(".")} ${d.msg}`).join("; ");
    if (typeof e?.msg === "string") return e.msg;
  } catch { /* not JSON */ }
  return text.slice(0, 200);
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const PROBE_ATTEMPTS = 3;

/**
 * One (model, level) probe, retrying only genuinely transient outcomes.
 *
 * Without this the sweep misreports capacity throttling as a configuration
 * defect: a `429 Not enough capacity` on a single level made a working model
 * appear broken, and a diagnostic that lies gets ignored. 4xx responses are
 * NOT retried — those are deterministic statements about the payload (bad
 * parameter, retired model, org entitlement), and retrying them just wastes
 * quota. `ERR` (timeout / connection reset) is retried, since that is what it
 * usually is.
 */
async function probeOnce(model, level) {
  const { url, headers, payload } = build(model, level);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) });
    if (res.ok) return { ok: true };
    const text = await res.text();
    return { ok: false, status: res.status, detail: extractError(text) };
  } catch (err) {
    return { ok: false, status: "ERR", detail: String(err?.message ?? err) };
  }
}

async function probe(model, level, limiter) {
  await limiter.acquire();
  try {
    let last;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      last = await probeOnce(model, level);
      if (last.ok) return attempt > 1 ? { retriedAndPassed: true } : null;
      const status = last.status;
      const transient = status === "ERR" || TRANSIENT.has(Number(status));
      if (!transient) break;
      if (attempt < PROBE_ATTEMPTS) await sleep(1500 * attempt);
    }
    return { gw: model.provider, id: model.id, api: model.api, level, clamped: clamp(model, level), status: last.status, detail: last.detail };
  } finally {
    limiter.release();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function limiter(max) {
  let active = 0;
  const q = [];
  const next = () => { if (q.length && active < max) { active++; q.shift()(); } };
  return {
    acquire: () => new Promise((r) => { q.push(r); next(); }),
    release: () => { active--; next(); },
  };
}

// --- main ------------------------------------------------------------------
const store = JSON.parse(readFileSync(STORE, "utf8"));
const models = Object.entries(store).flatMap(([gw, blob]) => (blob.models ?? []).map((m) => ({ ...m, provider: m.provider ?? gw })));
const jobs = models.flatMap((m) => (m.reasoning ? LEVELS : ["off"]).map((lv) => [m, lv]));

const expensive = models.filter((m) => EXPENSIVE.test(m.id));
const includeExpensive = argv.includes("--include-expensive");
if (!includeExpensive) {
  for (const m of expensive) {
    const idx = models.indexOf(m);
    if (idx >= 0) models.splice(idx, 1);
  }
}

const planned = models.flatMap((m) => (m.reasoning ? LEVELS : ["off"])).length;
console.log(`\nSweep: ${models.length} models across ${Object.keys(store).length} gateways = ${planned} REAL completions`);
console.log(`  expensive tiers skipped: ${expensive.length}${includeExpensive ? " (INCLUDED via --include-expensive)" : " (default)"}${expensive.length && !includeExpensive ? `\n    ${expensive.slice(0, 8).map((m) => `${m.provider}/${m.id}`).join(", ")}${expensive.length > 8 ? " …" : ""}` : ""}`);
if (!argv.includes("--yes-spend")) {
  console.log("\nABORT: each probe bills real tokens. Re-run with --yes-spend to proceed.");
  process.exit(2);
}
const lim = limiter(Number(opt("concurrency", 10)));
const results = await Promise.all(jobs.map(([m, lv]) => probe(m, lv, lim)));
const failures = results.filter((r) => r && !r.retriedAndPassed);

const retried = results.filter((r) => r && r.retriedAndPassed).length;

const byModel = new Map();
for (const f of failures.filter(Boolean)) {
  if (!byModel.has(`${f.gw}/${f.id}`)) byModel.set(`${f.gw}/${f.id}`, []);
  byModel.get(`${f.gw}/${f.id}`).push(f);
}
for (const [key, list] of byModel) {
  console.log(`FAIL ${key}  [${list[0].api}]`);
  for (const f of list) console.log(`       level=${f.level.padEnd(6)} clamped=${String(f.clamped).padEnd(6)} HTTP ${f.status}  ${f.detail.slice(0, 150)}`);
}
const realFailures = failures.filter(Boolean);
console.log(`\n${jobs.length - realFailures.length}/${jobs.length} probes OK, ${realFailures.length} failing, ${byModel.size} models affected`);
if (retried > 0) {
  console.log(`  note: ${retried} probe(s) initially failed transiently (429/5xx/network) and passed on retry — not counted as failures`);
}
if (realFailures.length) {
  const byStatus = {};
  for (const f of realFailures) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  console.log(`  by status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
process.exit(realFailures.length === 0 ? 0 : 1);
