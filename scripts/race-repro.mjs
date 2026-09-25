#!/usr/bin/env node
/**
 * Reproduction for the concurrent-write race in the atomic-write helpers.
 *
 * Two distinct defects are checked, because only one of them logs:
 *
 *  A. Temp-path collision. `refreshStaleGateways` discovers every stale gateway
 *     concurrently in ONE process, so `${pid}.${Date.now()}` is not unique per
 *     call. Two saves in the same millisecond share a temp path; the first
 *     rename consumes it and the second throws ENOENT.
 *
 *  B. Lost updates. Each save is a whole-file read-modify-write with no
 *     serialization, so two overlapping saves can both read the pre-image and
 *     the last writer silently drops the other's gateway. A does not throw, so
 *     the file just loses a lane.
 *
 * Run: node --experimental-strip-types scripts/race-repro.mjs
 */
import { readdirSync } from "node:fs";

const { withTempAgentDir } = await import("./with-temp-agent-dir.mjs");

const ITERATIONS = Number(process.argv[2] ?? 40);
const LANES = 8;

let enoent = 0;
let otherErrors = 0;
let lostUpdates = 0;
const failures = [];

for (let round = 0; round < ITERATIONS; round++) {
  // Fresh agent dir per round: the bug depends on timing, not prior state.
  const sandbox = await withTempAgentDir("gwmeta");
  const dir = sandbox.dir;
  const mod = sandbox.config;

  const results = await Promise.allSettled(
    Array.from({ length: LANES }, (_, i) =>
      mod.saveDiscoveryMeta(`lane-${i}`, { syncedAt: Date.now(), modelCount: i }),
    ),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      const msg = String(r.reason?.message ?? r.reason);
      if (/ENOENT/.test(msg)) enoent++;
      else { otherErrors++; failures.push(msg.slice(0, 140)); }
    }
  }

  const written = Object.keys(await mod.loadDiscoveryMeta()).length;
  if (written !== LANES) lostUpdates++;

  // Leftover temp files mean a rename lost its source.
  const strays = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  if (strays.length) failures.push(`${strays.length} stray .tmp file(s) left behind`);

  sandbox.dispose();
}

console.log(`\nconcurrent saveDiscoveryMeta: ${ITERATIONS} rounds x ${LANES} lanes`);
console.log(`  A. ENOENT rename failures : ${enoent}`);
console.log(`  A. other errors           : ${otherErrors}`);
console.log(`  B. rounds losing lanes    : ${lostUpdates}/${ITERATIONS}`);
if (failures.length) console.log("  samples:", [...new Set(failures)].slice(0, 4));

const bad = enoent > 0 || otherErrors > 0 || lostUpdates > 0 || failures.length > 0;
console.log(bad ? "\nRESULT: RACE PRESENT\n" : "\nRESULT: clean\n");
process.exit(bad ? 1 : 0);
