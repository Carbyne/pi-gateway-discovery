#!/usr/bin/env node
/**
 * Deterministic tests for the knowledge layer: the quirk table, the unusable /
 * retired filters, and config diffing. No network, no pi runtime.
 *
 * These encode mistakes that were actually made while building the table, each
 * of which presented as an unrelated runtime error rather than a table bug:
 *   - a bare `-pro$` suffix re-routing another vendor's model
 *   - first-match-wins hiding a narrow rule behind a broad one
 *   - a blanket `off: null` breaking models that accept `none`
 *   - rules silently not firing on `vendor/`-namespaced ids
 *   - an over-broad filter excluding `llama-3-8b-instruct`, a real chat model
 *
 *   node --experimental-strip-types scripts/selftest.mjs
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import {
  declaredThinkingLevelMap,
  resolveQuirk,
  retiredModelReason,
  unusableModelReason,
} from "../src/quirks.ts";
import { diffGatewayConfigs, fingerprintConfig, mergeGatewayConfigs, parseGatewayConfig } from "../src/config.ts";
import { withTempAgentDir } from "./with-temp-agent-dir.mjs";

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => { tests.push({ name, fn }); };
const runTests = async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (error) { failures.push(`${name}\n    ${error.message.split("\n").slice(0, 3).join("\n    ")}`); }
  }
};
const api = (id) => resolveQuirk(id)?.api;

console.log("\nquirk table");

test("does not leak across vendors: gemini-2.5-pro stays on its lane protocol", () => {
  assert.equal(api("gemini-2.5-pro"), undefined);
  assert.equal(api("acme/gemini-2.5-pro"), undefined);
});

test("does not leak across vendors: mistral-medium-3-pro is not an OpenAI pro", () => {
  assert.equal(api("mistral-medium-3-pro"), undefined);
});

test("routes gpt-5.4+ / gpt-6 to /responses", () => {
  for (const id of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-terra", "gpt-6-astra", "gpt-5.3-codex"])
    assert.equal(api(id), "openai-responses", id);
});

test("does NOT route older models that work on /chat/completions", () => {
  for (const id of ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5-mini", "o1", "o3", "o3-mini", "o4-mini", "gpt-4o"])
    assert.equal(api(id), undefined, id);
});

test("narrow rule survives the broad rule: gpt-5-pro keeps a high-only vocabulary", () => {
  const m = resolveQuirk("gpt-5-pro");
  assert.equal(m.api, "openai-responses");
  assert.equal(m.thinkingLevelMap.low, null);
  assert.equal(m.thinkingLevelMap.medium, null);
  assert.equal(m.thinkingLevelMap.high, "high");
});

test("gpt-5.x-pro accepts medium/high/xhigh and rejects low", () => {
  const m = resolveQuirk("gpt-5.5-pro").thinkingLevelMap;
  assert.equal(m.low, null);
  assert.equal(m.medium, "medium");
  assert.equal(m.xhigh, "xhigh");
});

test("o-series pro rejects both 'none' and 'minimal'", () => {
  const m = resolveQuirk("o1-pro").thinkingLevelMap;
  assert.equal(m.off, null);
  assert.equal(m.minimal, null);
  assert.equal(m.low, "low");
});

test("gpt-5.4+/gpt-6 keep 'off' usable, because they accept an explicit none", () => {
  // Regression: a blanket off:null here makes pi clamp "off" up to `minimal`,
  // which these models reject.
  const m = resolveQuirk("gpt-5.6-terra").thinkingLevelMap;
  assert.notEqual(m?.off, null);
});

test("rules fire through vendor id namespaces", () => {
  assert.deepEqual(resolveQuirk("acme/mistral-medium-3.5").thinkingLevelMap.low, null);
  assert.deepEqual(resolveQuirk("vendor/gpt-5.5-pro").api, "openai-responses");
});

test("mistral medium/small family speaks only none|high", () => {
  for (const id of ["mistral-medium-3.5", "magistral-small-latest", "mistral-vibe-cli-latest"]) {
    const m = resolveQuirk(id).thinkingLevelMap;
    assert.equal(m.off, "none", id);
    assert.equal(m.low, null, id);
    assert.equal(m.high, "high", id);
  }
});

test("zai-glm speaks low|high|max and can omit the field", () => {
  const m = resolveQuirk("zai-glm-latest").thinkingLevelMap;
  assert.equal(m.medium, null);
  assert.equal(m.max, "max");
  assert.equal("off" in m, false);
});

test("gemma-4 cannot switch thinking off", () => {
  const m = resolveQuirk("gemma-4-31b-it").thinkingLevelMap;
  assert.equal(m.off, null);
  assert.equal(m.high, "high");
});

console.log("unusable / retired filters");

test("excludes non-chat and capability-less families", () => {
  for (const id of ["gpt-realtime-2", "computer-use-preview", "gpt-4o-search-preview", "o3-deep-research",
                    "gpt-3.5-turbo-instruct", "voxtral-mini-latest", "gemini-omni-1.1-flash",
                    "antigravity-preview-latest", "aqa", "text-embedding-3-large",
                    "bge-reranker-v2", "whisper-1", "dall-e-3", "nomic-embed-text"])
    assert.ok(unusableModelReason(id), `${id} should be excluded`);
});

test("does NOT exclude real chat models whose names merely look similar", () => {
  // `instruct` is the trap: llama-*-instruct models are ordinary chat models,
  // and only the legacy turbo-instruct completions-only pair are not.
  for (const id of ["llama-3.3-70b-instruct", "mistral-7b-instruct", "qwen2.5-coder-instruct",
                    "gpt-5.1-codex", "phi-4-reasoning", "deepseek-r1"])
    assert.equal(unusableModelReason(id), undefined, `${id} must stay registered`);
});

test("excludes through a vendor namespace too", () => {
  assert.ok(unusableModelReason("acme/gpt-realtime-mini"));
});

test("retiredModelReason uses the date, not the presence of a date", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  assert.ok(retiredModelReason({ shutdown_date: "2026-07-23" }, now));
  assert.equal(retiredModelReason({ shutdown_date: "2026-10-23" }, now), undefined);
  assert.equal(retiredModelReason({ shutdown_date: null }, now), undefined);
  assert.equal(retiredModelReason({}, now), undefined);
  assert.equal(retiredModelReason({ shutdown_date: "not-a-date" }, now), undefined);
});

test("declared supported_efforts become the vocabulary, and beat name guessing", () => {
  const m = declaredThinkingLevelMap({ reasoning: { supported_efforts: ["xhigh", "medium", "low", "none"] } });
  assert.deepEqual(m, { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null });
  assert.equal(declaredThinkingLevelMap({ reasoning: null }), undefined);
  assert.equal(declaredThinkingLevelMap({ reasoning: { supported_efforts: [] } }), undefined);
});

console.log("config diffing (hot reload)");

const gw = (id, extra = {}) => ({ id, name: "X", baseUrl: "https://e/x", ...extra });
const cfg = (gateways, ttl) => ({ version: 1, ...(ttl ? { autoRefreshTtlHours: ttl } : {}), gateways });

test("no change is not reported as a change", () => {
  const a = cfg([gw("g1"), gw("g2")]);
  assert.equal(diffGatewayConfigs(a, a).changed, false);
  assert.equal(diffGatewayConfigs(cfg([gw("g1")]), cfg([gw("g1")])).changed, false);
});

test("key order inside a gateway is not a change", () => {
  const k1 = { id: "g1", name: "X", baseUrl: "https://e/x", compat: { supportsStore: false } };
  const k2 = { compat: { supportsStore: false }, baseUrl: "https://e/x", name: "X", id: "g1" };
  assert.equal(diffGatewayConfigs(cfg([k1]), cfg([k2])).changed, false);
});

test("added, removed and modified are classified", () => {
  const before = cfg([gw("keep"), gw("edit"), gw("gone")]);
  const after = cfg([gw("keep"), gw("edit", { api: "anthropic-messages" }), gw("new")]);
  const d = diffGatewayConfigs(before, after);
  assert.deepEqual(d.added, ["new"]);
  assert.deepEqual(d.removed, ["gone"]);
  assert.deepEqual(d.modified, ["edit"]);
  assert.equal(d.changed, true);
});

test("nested thinkingLevelMap edits count as modifications", () => {
  const o = { "m1": { thinkingLevelMap: { low: "low" } } };
  const d = diffGatewayConfigs(cfg([gw("g", { modelOverrides: o })]),
    cfg([gw("g", { modelOverrides: { "m1": { thinkingLevelMap: { low: null } } } })]));
  assert.deepEqual(d.modified, ["g"]);
});

test("a TTL-only change is flagged without touching providers", () => {
  const d = diffGatewayConfigs(cfg([gw("g")], 1), cfg([gw("g")], 24));
  assert.equal(d.ttlChanged, true);
  assert.equal(d.changed, true);
  assert.equal(d.modified.length, 0);
});

test("fingerprint ignores key order but not content", () => {
  const one = { version: 1, gateways: [{ id: "g", name: "X", baseUrl: "https://e/x" }] };
  const two = { gateways: [{ baseUrl: "https://e/x", name: "X", id: "g" }], version: 1 };
  assert.equal(fingerprintConfig(one), fingerprintConfig(two));
  assert.notEqual(fingerprintConfig(cfg([gw("a")])),
    fingerprintConfig(cfg([gw("a", { api: "openai-responses" })])));
});

test("diffing is insensitive to gateway order (reordering causes no re-registration)", () => {
  assert.equal(diffGatewayConfigs(cfg([gw("a"), gw("b")]), cfg([gw("b"), gw("a")])).changed, false);
});

console.log("portable bundles (export / import)");

const gcfg = (id, extra = {}) => ({ id, name: "X", baseUrl: `https://e/${id}`, ...extra });

test("merge upserts by id and keeps gateways the bundle does not mention", () => {
  const current = cfg([gcfg("a"), gcfg("b")]);
  const incoming = cfg([gcfg("b", { api: "anthropic-messages" }), gcfg("c")]);
  const merged = mergeGatewayConfigs(current, incoming, "merge");
  assert.deepEqual(merged.gateways.map((g) => g.id), ["a", "b", "c"]);
  assert.equal(merged.gateways.find((g) => g.id === "b").api, "anthropic-messages");
  assert.equal(merged.gateways.find((g) => g.id === "a").baseUrl, "https://e/a");
});

test("replace adopts the bundle verbatim, dropping local-only gateways", () => {
  const merged = mergeGatewayConfigs(cfg([gcfg("a"), gcfg("b")]), cfg([gcfg("z")]), "replace");
  assert.deepEqual(merged.gateways.map((g) => g.id), ["z"]);
});

test("merge takes the bundle's TTL when set, otherwise keeps the local one", () => {
  assert.equal(mergeGatewayConfigs(cfg([gcfg("a")], 1), cfg([], 24), "merge").autoRefreshTtlHours, 24);
  assert.equal(mergeGatewayConfigs(cfg([gcfg("a")], 1), cfg([]), "merge").autoRefreshTtlHours, 1);
});

test("an exported bundle round-trips through the loader's validator", () => {
  const original = {
    version: 1,
    autoRefreshTtlHours: 24,
    gateways: [
      { id: "lane-a", name: "A", baseUrl: "https://e/a", api: "anthropic-messages", compat: { supportsStore: false } },
      { id: "lane-b", name: "B", baseUrl: "https://e/b", modelOverrides: { "m1": { thinkingLevelMap: { low: null, high: "high" } } } },
    ],
  };
  const bundle = { bundleVersion: 1, generatedBy: "pi-gateway-discovery", generatedAt: "x", config: original };
  const parsed = parseGatewayConfig(bundle.config);
  assert.equal(fingerprintConfig(parsed), fingerprintConfig(original));
});

test("the validator rejects a malformed bundle rather than half-loading it", () => {
  assert.throws(() => parseGatewayConfig({ version: 2, gateways: [] }));
  assert.throws(() => parseGatewayConfig({ version: 1, gateways: [{ id: "ok", name: "N" }] })); // no baseUrl
  assert.throws(() => parseGatewayConfig({ version: 1, gateways: [{ id: "ok", name: "N", baseUrl: "ftp://x" }] }));
  assert.throws(() =>
    parseGatewayConfig({ version: 1, gateways: [{ id: "ok", name: "N", baseUrl: "https://e", api: "nonsense" }] }));
});

test("normalizeBaseUrl trims the trailing slash that would double up in paths", () => {
  const parsed = parseGatewayConfig({ version: 1, gateways: [{ id: "g", name: "G", baseUrl: "https://e/v1/" }] });
  assert.equal(parsed.gateways[0].baseUrl, "https://e/v1");
});

console.log("concurrent persistence (race regression)");

// These encode two defects that a sequential test cannot see, both of which
// shipped once: a temp path built from `${pid}.${Date.now()}` that two
// concurrent saves computed identically (the loser's rename then hit ENOENT),
// and an unserialized whole-file read-modify-write where the last writer
// silently deleted the other's key. Only the first throws; the second just
// loses data, which is why both are asserted here.
{
  // withTempAgentDir() re-imports config.ts against a throwaway dir and throws
  // if any of its path constants still resolve outside it. Do not replace this
  // with a bare `import("../src/config.ts")`: an earlier version of this test
  // did, and because config.ts was already loaded it wrote straight into the
  // developer's real ~/.pi/agent.
  const sandbox = await withTempAgentDir("gw-selftest");
  const { saveDiscoveryMeta, loadDiscoveryMeta, saveConfig, loadConfig } = sandbox.config;

  const lanes = 10;
  await Promise.all(
    Array.from({ length: lanes }, (_, i) =>
      saveDiscoveryMeta(`lane-${i}`, { syncedAt: 1, modelCount: i })),
  );
  const many = Array.from({ length: 6 }, (_, i) => cfg([gw(`g${i}`)]));
  await Promise.all(many.map((c) => saveConfig(c)));

  // Observe everything BEFORE dispose(): test() bodies run lazily at the end,
  // so anything touching the filesystem must be captured while it exists.
  const saved = await loadDiscoveryMeta();
  const strays = readdirSync(sandbox.dir).filter((f) => f.endsWith(".tmp"));
  let reloaded;
  let reloadError;
  try {
    reloaded = await loadConfig();
  } catch (error) {
    reloadError = String(error?.message ?? error);
  }
  const rawConfig = (() => {
    try { return readFileSync(join(sandbox.dir, "gateway-discovery.json"), "utf8"); }
    catch { return undefined; }
  })();

  test("concurrent saveDiscoveryMeta keeps every lane", () => {
    assert.equal(Object.keys(saved).length, lanes, `got ${Object.keys(saved).length}`);
    for (let i = 0; i < lanes; i++) assert.equal(saved[`lane-${i}`].modelCount, i);
  });

  test("concurrent saves leave no stray temp files", () => {
    assert.deepEqual(strays, []);
  });

  // saveConfig is whole-file replacement, NOT a read-modify-write, so the
  // correct invariant is not "all six merged" but "exactly one coherent writer
  // won" — a torn or interleaved result would be the bug. Contrast with
  // saveDiscoveryMeta above, which must merge and must not lose lanes.
  test("concurrent saveConfig resolves to exactly one coherent writer", () => {
    assert.equal(reloadError, undefined, `loadConfig threw: ${reloadError}`);
    assert.equal(reloaded.gateways.length, 1, `got ${reloaded.gateways.length}`);
    const winner = reloaded.gateways[0].id;
    assert.ok(many.some((c) => c.gateways.length === 1 && c.gateways[0].id === winner),
      `result ${winner} is not one of the six complete inputs (torn write?)`);
  });

  test("concurrent saveConfig never leaves a truncated or unparseable file", () => {
    // The temp-file + rename dance exists precisely so a reader never observes
    // a half-written file. Assert the bytes on disk parse as a full document.
    assert.ok(rawConfig, "config file missing");
    assert.doesNotThrow(() => JSON.parse(rawConfig));
    const parsed = JSON.parse(rawConfig);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.gateways.length, 1);
  });

  sandbox.dispose();
}

// --- report ---------------------------------------------------------------
await runTests();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
