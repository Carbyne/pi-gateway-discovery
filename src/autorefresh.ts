/**
 * Automatic catalog refresh.
 *
 * pi refreshes model catalogs in the background for interactive and RPC
 * sessions, but `pi --list-models` and `pi -p` (print mode) never touch the
 * network — they serve the models-store.json cache as-is. This module closes
 * that gap:
 *
 * - `refreshStaleGateways()` runs inside the (awaited) extension factory,
 *   before pi's offline cache restore. When a gateway's cached catalog is
 *   older than the TTL, it is re-discovered and written to the store, so
 *   every pi mode starts with a fresh catalog. Fresh cache → zero delay.
 * - `startStoreWatcher()` propagates store writes from *other* pi sessions
 *   into this session's in-memory registry via an offline refresh (pi's
 *   FileModelsStore re-reads the file when its revision changes).
 * - The periodic check (wired in index.ts) keeps long-running sessions
 *   current past the TTL.
 *
 * The in-process TTL gate in fetchModels (index.ts) prevents a duplicate
 * network fetch when pi's own background refresh follows a factory refresh.
 */

import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { AUTH_PATH, MODELS_STORE_PATH, type GatewayConfig, type GatewayConfigFile } from "./config.ts";
import { discoverGateway } from "./discovery.ts";

export const AUTO_REFRESH_DEFAULT_TTL_HOURS = 1;
/** Matches pi's own catalog-refresh timeout (RPC / interactive startup). */
export const AUTO_REFRESH_TIMEOUT_MS = 15_000;
/** How often long-running sessions re-check the TTL. */
export const PERIODIC_CHECK_INTERVAL_MS = 5 * 60_000;

let selfWriteUntil = 0;

/** Mark the next store mutation as ours so the watcher ignores it. */
export function markSelfWrite(windowMs = 5_000): void {
  selfWriteUntil = Date.now() + windowMs;
}

export function isSelfWrite(): boolean {
  return Date.now() < selfWriteUntil;
}

export function ttlMsFromConfig(config: GatewayConfigFile): number {
  const hours = config.autoRefreshTtlHours ?? AUTO_REFRESH_DEFAULT_TTL_HOURS;
  return Math.max(0, hours) * 3_600_000;
}

export function isOffline(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

/**
 * Resolve a gateway's API key: ambient env var (gateway.apiKeyEnv) first,
 * then the credential pi's /login stored in auth.json. The key is never
 * logged or returned to the AI.
 */
export function resolveGatewayKey(gateway: GatewayConfig): string | undefined {
  if (gateway.apiKeyEnv) {
    const envKey = process.env[gateway.apiKeyEnv];
    if (envKey) return envKey;
  }
  try {
    const data = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >;
    const entry = data[gateway.id];
    if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0) {
      return entry.key;
    }
  } catch {
    // No auth file (or unreadable) — fall through.
  }
  return undefined;
}

/** Last successful remote-check timestamp for a provider, from pi's store. */
export function readStoreCheckedAt(providerId: string): number | undefined {
  try {
    const store = JSON.parse(readFileSync(MODELS_STORE_PATH, "utf8")) as Record<
      string,
      { checkedAt?: number }
    >;
    return typeof store[providerId]?.checkedAt === "number" ? store[providerId].checkedAt : undefined;
  } catch {
    return undefined;
  }
}

/** Gateway ids whose cached catalog is missing or older than the TTL. */
export function staleGatewayIds(config: GatewayConfigFile, ttlMs: number): string[] {
  if (ttlMs <= 0 || isOffline()) return [];
  return config.gateways
    .map((gateway) => ({ id: gateway.id, checkedAt: readStoreCheckedAt(gateway.id) }))
    .filter((entry) => entry.checkedAt === undefined || Date.now() - entry.checkedAt > ttlMs)
    .map((entry) => entry.id);
}

/**
 * Atomically merge one provider entry into pi's models-store.json,
 * preserving entries of all other providers (built-ins included).
 */
export function writeStoreEntry(providerId: string, models: unknown[]): void {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(MODELS_STORE_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    // Store does not exist yet — create it.
  }
  current[providerId] = { models, checkedAt: Date.now() };
  const tempPath = `${MODELS_STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  markSelfWrite();
  writeFileSync(tempPath, JSON.stringify(current, null, 2), { mode: 0o600 });
  renameSync(tempPath, MODELS_STORE_PATH);
}

export interface AutoRefreshOutcome {
  refreshed: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

/**
 * Re-discover stale gateways and write their catalogs to pi's model store.
 * Called from the extension factory (pi awaits it), bounded by
 * AUTO_REFRESH_TIMEOUT_MS. Failures never throw — startup stays resilient
 * and falls back to the (stale) cached catalog.
 */
export async function refreshStaleGateways(
  config: GatewayConfigFile,
  onResult?: (
    gatewayId: string,
    info: {
      ok: boolean;
      modelCount?: number;
      matchedCount?: number;
      unmatchedCount?: number;
      inferenceBaseUrl?: string;
      litellmEnriched?: boolean;
      maxTokensCappedCount?: number;
      error?: string;
    },
  ) => void,
): Promise<AutoRefreshOutcome> {
  const outcome: AutoRefreshOutcome = { refreshed: [], skipped: [], failed: [] };
  const stale = staleGatewayIds(config, ttlMsFromConfig(config));
  if (stale.length === 0) return outcome;

  const signal = AbortSignal.timeout(AUTO_REFRESH_TIMEOUT_MS);
  await Promise.all(
    stale.map(async (id) => {
      const gateway = config.gateways.find((g) => g.id === id);
      if (!gateway) return;
      const key = resolveGatewayKey(gateway);
      if (!key) {
        outcome.skipped.push({ id, reason: "no API key (run /login " + id + ")" });
        onResult?.(id, { ok: false, error: "auto-refresh skipped: no API key" });
        return;
      }
      try {
        const discovered = await discoverGateway(gateway, key, signal);
        writeStoreEntry(id, discovered.models);
        outcome.refreshed.push(id);
        onResult?.(id, {
          ok: true,
          modelCount: discovered.models.length,
          matchedCount: discovered.status.matched.length,
          unmatchedCount: discovered.status.unmatched.length,
          inferenceBaseUrl: discovered.status.inferenceBaseUrl,
          litellmEnriched: discovered.status.litellmEnriched,
          ...(discovered.status.maxTokensCapped
            ? { maxTokensCappedCount: discovered.status.maxTokensCapped.length }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome.failed.push({ id, error: message });
        onResult?.(id, { ok: false, error: `auto-refresh failed: ${message}` });
      }
    }),
  );
  return outcome;
}

/**
 * Watch pi's models-store.json for writes from other pi sessions.
 * Watches the containing directory (not the file): pi writes the store
 * in-place, but atomic rename replacements (this extension's own writes,
 * other tools) swap the inode and would silently kill a file-level
 * inotify watch. Returns a stop function. Best-effort.
 */
export function startStoreWatcher(opts: {
  getGatewayIds: () => string[];
  onExternalChange: (gatewayIds: string[]) => void;
}): () => void {
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  try {
    const dir = dirname(MODELS_STORE_PATH);
    const fileName = basename(MODELS_STORE_PATH);
    if (existsSync(dir)) {
      watcher = watch(dir, { persistent: false }, (_eventType, changed) => {
        if (changed && changed !== fileName) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (isSelfWrite()) return;
          const ids = opts.getGatewayIds();
          if (ids.length > 0) opts.onExternalChange(ids);
        }, 300);
        debounce.unref?.();
      });
    }
  } catch {
    // Watching is best-effort; ignore.
  }
  return () => {
    if (debounce) clearTimeout(debounce);
    try {
      watcher?.close();
    } catch {
      // Already closed.
    }
  };
}
