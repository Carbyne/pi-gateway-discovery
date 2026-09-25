#!/usr/bin/env node
/**
 * Import `src/config.ts` bound to a throwaway agent dir, and PROVE it.
 *
 * Why this exists: a selftest once set PI_CODING_AGENT_DIR and then called
 * `import("../src/config.ts")` — but config.ts had already been loaded earlier
 * in the same process, so the module came from cache with its path constants
 * baked in from the REAL `~/.pi/agent`. The test then called `saveConfig()` and
 * overwrote a live gateway config, with nothing failing loudly.
 *
 * Two mechanisms make that impossible rather than merely unlikely:
 *   1. a cache-busting query string, so the module is genuinely re-evaluated
 *      and recomputes its constants from the current environment;
 *   2. an assertion that every path the module exposes resolves inside the
 *      temp dir. If the trick ever stops working — a Node change, a different
 *      loader, or simply an `import` added above this one — the test throws
 *      instead of writing into someone's home directory.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Every module-level path constant a test could accidentally write through. */
const GUARDED = ["CONFIG_PATH", "AUTH_PATH", "MODELS_STORE_PATH", "DISCOVERY_META_PATH"];

let instanceSeq = 0;

export async function withTempAgentDir(tag = "gw") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${tag}-`)));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  let config;
  try {
    // Unique query per call: without it Node hands back the cached instance,
    // whose constants still point at whichever dir was active first.
    config = await import(`../src/config.ts?agentDir=${encodeURIComponent(dir)}#${instanceSeq++}`);
  } catch (error) {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    throw error;
  }

  for (const name of GUARDED) {
    const value = config[name];
    if (typeof value !== "string") {
      throw new Error(`isolation guard: ${name} is not a string path (got ${typeof value})`);
    }
    if (!resolve(value).startsWith(`${dir}/`)) {
      throw new Error(
        `ISOLATION GUARD: ${name} resolves to ${resolve(value)}, outside ${dir}. ` +
          `Refusing to run: this test would write outside its sandbox.`,
      );
    }
  }

  let disposed = false;
  return {
    dir,
    config,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
