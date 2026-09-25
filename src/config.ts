/**
 * Gateway configuration persistence and normalization.
 *
 * The config file is NON-SECRET: it holds gateway ids, names, base URLs, and
 * optional ambient env-var names. API keys never live here — they are stored
 * by pi's /login in auth.json (0600) or read from the environment at request
 * time.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type GatewayApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/** Per-model overrides (topmost layer over gateway-level settings). */
export interface ModelOverride {
  /** Route this model to a different protocol than the gateway default. */
  api?: GatewayApi;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Replace the inherited thinking-level map (null marks a level unsupported). */
  thinkingLevelMap?: Record<string, string | null>;
  /** Merged over inherited/gateway compat. */
  compat?: Record<string, unknown>;
}

export interface GatewayConfig {
  /** Stable id. Doubles as the pi provider id and the auth.json credential key. */
  id: string;
  /** Human display name. */
  name: string;
  /** Normalized gateway base URL (no trailing slash). */
  baseUrl: string;
  /** Inference protocol. Defaults to openai-completions. */
  api?: GatewayApi;
  /** Optional ambient env var holding the API key (alternative to /login). */
  apiKeyEnv?: string;
  /**
   * Per-gateway compat overrides applied to every discovered model (merged
   * over inherited catalog compat). Use for backend quirks, e.g.
   * { "supportsStore": false } for gateways fronting the strict Mistral API,
   * which rejects the `store` parameter pi sends to unknown endpoints.
   */
  compat?: Record<string, unknown>;
  /** Per-model overrides, keyed by model id (topmost layer). */
  modelOverrides?: Record<string, ModelOverride>;
  /** Model ids to never register. */
  excludedModels?: string[];
  /**
   * Drop models that can never serve a chat/completions request — realtime,
   * audio/transcription, completions-only base models, and families without
   * function calling. Default: true, because such an entry is dead weight in
   * the `/model` picker that only fails on first use. Set false to keep every
   * id the gateway lists (e.g. a gateway that reuses one of those words for a
   * genuine chat model).
   */
  excludeUnusable?: boolean;
  /**
   * Query Google's native model list for lanes that expose the OpenAI shim
   * (which returns only `id/object/owned_by/display_name`) to recover
   * `inputTokenLimit`, `outputTokenLimit`, `thinking` and
   * `supportedGenerationMethods`. Best-effort: any failure falls back to the
   * shim's data. Default true; set false to disable the extra request.
   */
  googleNativeMetadata?: boolean;
  /**
   * Route streaming inference requests through a node:http/https-backed
   * fetch instead of the global (undici) fetch. Set this for gateways that
   * only negotiate HTTP/1.1: undici can buffer the entire chunked response
   * there, so SSE token deltas arrive as one lump at the end of generation.
   * Node's core http client surfaces each network chunk immediately.
   * Proxy environment variables are not applied on this path (direct
   * gateways only). Discovery GETs always keep the global fetch.
   */
  directHttpStreaming?: boolean;
}

export interface GatewayConfigFile {
  version: 1;
  /**
   * Auto-refresh TTL in hours. When the cached catalog for a gateway is
   * older than this, pi refreshes it automatically: at extension load (all
   * modes, including `pi --list-models` and `pi -p`), on /reload, and
   * periodically in long-running sessions. 0 disables auto-refresh.
   * Default: 1.
   */
  autoRefreshTtlHours?: number;
  gateways: GatewayConfig[];
}

export const AGENT_DIR = getAgentDir();
export const CONFIG_PATH = join(AGENT_DIR, "gateway-discovery.json");
export const AUTH_PATH = join(AGENT_DIR, "auth.json");
export const MODELS_STORE_PATH = join(AGENT_DIR, "models-store.json");
export const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
/**
 * Per-gateway discovery metadata that pi's model cache does not carry: which
 * models were auto-configured and by which layer, which were suppressed, and
 * which were filtered as unusable.
 *
 * Kept in its own file rather than inside `models-store.json` so pi keeps
 * ownership of the model cache, and written next to each successful discovery.
 * Without it, `describe` and `doctor` can only answer provenance in the one
 * session that happened to run discovery — i.e. almost never.
 */
export const DISCOVERY_META_PATH = join(AGENT_DIR, "gateway-discovery-meta.json");

export function isGatewayApi(value: unknown): value is GatewayApi {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages";
}

function parseModelOverrides(value: unknown): Record<string, ModelOverride> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, ModelOverride> = {};
  for (const [modelId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid model override for ${modelId}`);
    }
    const item = raw as Record<string, unknown>;
    const override: ModelOverride = {};
    if (item.api !== undefined) {
      if (!isGatewayApi(item.api)) throw new Error(`Invalid api in override for ${modelId}`);
      override.api = item.api;
    }
    if (item.reasoning !== undefined) {
      if (typeof item.reasoning !== "boolean") throw new Error(`Invalid reasoning in override for ${modelId}`);
      override.reasoning = item.reasoning;
    }
    for (const field of ["contextWindow", "maxTokens"] as const) {
      if (item[field] !== undefined) {
        const n = asPositiveNumber(item[field]);
        if (n === undefined) throw new Error(`Invalid ${field} in override for ${modelId}`);
        override[field] = n;
      }
    }
    if (item.thinkingLevelMap !== undefined) {
      if (!item.thinkingLevelMap || typeof item.thinkingLevelMap !== "object" || Array.isArray(item.thinkingLevelMap)) {
        throw new Error(`Invalid thinkingLevelMap in override for ${modelId}`);
      }
      const map: Record<string, string | null> = {};
      for (const [level, v] of Object.entries(item.thinkingLevelMap as Record<string, unknown>)) {
        if (v !== null && typeof v !== "string") {
          throw new Error(`Invalid thinkingLevelMap value for level '${level}' in override for ${modelId}`);
        }
        map[level] = v as string | null;
      }
      override.thinkingLevelMap = map;
    }
    if (item.compat !== undefined) {
      if (!item.compat || typeof item.compat !== "object" || Array.isArray(item.compat)) {
        throw new Error(`Invalid compat in override for ${modelId}`);
      }
      override.compat = item.compat as Record<string, unknown>;
    }
    if (Object.keys(override).length > 0) out[modelId] = override;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Normalization / validation
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Base URL cannot be empty");

  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not include credentials in the Base URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

/**
 * The base URL pi should use for *inference*. For anthropic-messages we strip
 * a trailing /v1 so the SDK does not generate /v1/v1/messages.
 */
export function inferenceBaseUrlForApi(baseUrl: string, api: GatewayApi): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (api !== "anthropic-messages") return normalized;
  const parsed = new URL(normalized);
  if (parsed.pathname.endsWith("/v1")) {
    parsed.pathname = parsed.pathname.slice(0, -3) || "/";
    return parsed.toString().replace(/\/$/u, "");
  }
  return normalized;
}

export function validateGatewayId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error("Gateway ID may contain lowercase letters, numbers, dots, underscores, and hyphens");
  }
  return id;
}

/** Suggest a readable id/name from the hostname, e.g. yoda.teknologisk.dk → yoda / "Yoda". */
export function suggestGatewayIdentity(
  rawBaseUrl: string,
  existingIds: ReadonlySet<string>,
): { id: string; name: string } {
  const hostname = new URL(normalizeBaseUrl(rawBaseUrl)).hostname.toLowerCase();
  const labels = hostname.split(".").filter(Boolean);
  const generic = new Set([
    "api", "www", "gateway", "proxy", "openai", "anthropic", "ai", "v1",
    "com", "net", "org", "io", "cn", "dk", "local", "localhost",
  ]);
  const brand = labels.find((label) => !generic.has(label)) ?? labels[0] ?? "gateway";
  const baseId = validateGatewayId(brand.replace(/[^a-z0-9._-]+/gu, "-"));
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const readable = brand
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return { id, name: readable || "Gateway" };
}

// ---------------------------------------------------------------------------
// Persistence (atomic, 0600)
// ---------------------------------------------------------------------------

/**
 * Validate + normalize a parsed config object. Exported so import paths can
 * reuse exactly the rules the on-disk file is held to, rather than inventing a
 * second, laxer parser that lets a bad bundle reach the registry.
 */
export function parseGatewayConfig(value: unknown): GatewayConfigFile {
  return parseConfigFile(value);
}

function parseConfigFile(value: unknown): GatewayConfigFile {
  if (!value || typeof value !== "object") throw new Error("Configuration must be a JSON object");
  const input = value as { version?: unknown; gateways?: unknown; autoRefreshTtlHours?: unknown };
  if (input.version !== 1 || !Array.isArray(input.gateways)) {
    throw new Error("Unsupported gateway-discovery config version");
  }

  let autoRefreshTtlHours: number | undefined;
  if (input.autoRefreshTtlHours !== undefined) {
    if (typeof input.autoRefreshTtlHours !== "number" || !Number.isFinite(input.autoRefreshTtlHours) || input.autoRefreshTtlHours < 0) {
      throw new Error("autoRefreshTtlHours must be a non-negative number");
    }
    autoRefreshTtlHours = input.autoRefreshTtlHours;
  }

  const gateways = input.gateways.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid gateway entry #${index + 1}`);
    const item = entry as Partial<GatewayConfig>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.baseUrl !== "string") {
      throw new Error(`Gateway entry #${index + 1} requires id, name, and baseUrl`);
    }
    if (item.api !== undefined && !isGatewayApi(item.api)) {
      throw new Error(`Invalid api for gateway ${item.id}`);
    }
    const excludedModels = Array.isArray(item.excludedModels)
      ? [...new Set(item.excludedModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0))]
      : undefined;
    return {
      id: validateGatewayId(item.id),
      name: item.name.trim() || item.id,
      baseUrl: normalizeBaseUrl(item.baseUrl),
      ...(isGatewayApi(item.api) ? { api: item.api } : {}),
      ...(typeof item.apiKeyEnv === "string" && item.apiKeyEnv.trim() ? { apiKeyEnv: item.apiKeyEnv.trim() } : {}),
      ...(item.compat && typeof item.compat === "object" && !Array.isArray(item.compat)
        ? { compat: item.compat as Record<string, unknown> }
        : {}),
      ...(parseModelOverrides(item.modelOverrides) ? { modelOverrides: parseModelOverrides(item.modelOverrides) } : {}),
      ...(excludedModels && excludedModels.length > 0 ? { excludedModels } : {}),
      // Preserve an explicit false: the effective default is true.
      ...(item.excludeUnusable === false ? { excludeUnusable: false } : {}),
      ...(item.googleNativeMetadata === false ? { googleNativeMetadata: false } : {}),
      ...(typeof item.directHttpStreaming === "boolean" && item.directHttpStreaming ? { directHttpStreaming: true } : {}),
    };
  });

  return { version: 1, ...(autoRefreshTtlHours !== undefined ? { autoRefreshTtlHours } : {}), gateways };
}

/** Discovery metadata keyed by gateway id; absence just means "not yet recorded". */
export interface GatewayDiscoveryMeta {
  syncedAt: number;
  modelCount: number;
  /** Inference base actually used, so `describe` is right in fresh sessions too. */
  inferenceBaseUrl?: string;
  excludedUnusable?: Array<{ id: string; reason: string }>;
  quirksApplied?: Array<{ id: string; note: string; source: "declared" | "quirk" }>;
  quirksSuppressed?: Array<{ id: string; note: string }>;
}

export async function loadDiscoveryMeta(): Promise<Record<string, GatewayDiscoveryMeta>> {
  try {
    const parsed = JSON.parse(await readFile(DISCOVERY_META_PATH, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, GatewayDiscoveryMeta>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read-modify-write one gateway's metadata. A whole-file rewrite would let two
 * concurrent syncs clobber each other's entries, so the file is re-read here
 * and only the one key is replaced.
 */
export async function saveDiscoveryMeta(
  gatewayId: string,
  meta: GatewayDiscoveryMeta,
): Promise<void> {
  await mutateJsonObjectFile(DISCOVERY_META_PATH, () => readJsonObjectFile(DISCOVERY_META_PATH), (record) => {
    record[gatewayId] = meta;
  });
}

export async function deleteDiscoveryMeta(gatewayId: string): Promise<void> {
  const all = await loadDiscoveryMeta();
  if (!(gatewayId in all)) return;
  delete all[gatewayId];
  await writeFile(DISCOVERY_META_PATH, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function loadConfig(): Promise<GatewayConfigFile> {
  try {
    return parseConfigFile(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, gateways: [] };
    throw new Error(`Cannot load ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Key-order-insensitive fingerprint, so a merely reordered file is not a change. */
export function fingerprintConfig(config: GatewayConfigFile): string {
  return stableStringify(config);
}

export interface ConfigDelta {
  added: string[];
  removed: string[];
  modified: string[];
  /** Whether the refresh TTL changed (affects scheduling, not providers). */
  ttlChanged: boolean;
  changed: boolean;
}

const NO_DELTA: ConfigDelta = { added: [], removed: [], modified: [], ttlChanged: false, changed: false };

/**
 * Compare two loaded configs by gateway id.
 *
 * Exists because `configFile` is captured at extension load and every provider
 * closes over its own `GatewayConfig`. Editing the file on disk (or having
 * another session edit it) therefore leaves `sync` re-deriving models from the
 * *stale* object while still reporting `state: "ok"` with a model count —
 * indistinguishable from success. Callers diff, re-register what moved, and
 * surface the rest as drift.
 */
export function diffGatewayConfigs(before: GatewayConfigFile, after: GatewayConfigFile): ConfigDelta {
  if (before === after) return NO_DELTA;
  const beforeById = new Map(before.gateways.map((g) => [g.id, g]));
  const afterById = new Map(after.gateways.map((g) => [g.id, g]));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [id, gateway] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) added.push(id);
    else if (stableStringify(previous) !== stableStringify(gateway)) modified.push(id);
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed.push(id);
  }

  const ttlChanged = before.autoRefreshTtlHours !== after.autoRefreshTtlHours;
  return {
    added,
    removed,
    modified,
    ttlChanged,
    changed: added.length + removed.length + modified.length > 0 || ttlChanged,
  };
}

/**
 * Fold an imported set of gateways into the current config.
 *
 * `merge` upserts by gateway id and keeps everything the bundle does not
 * mention; `replace` adopts the bundle verbatim. Pure, so the semantics that
 * decide whether someone's tuned setup survives an import are testable without
 * a running pi session.
 */
export function mergeGatewayConfigs(
  current: GatewayConfigFile,
  incoming: GatewayConfigFile,
  mode: "merge" | "replace",
): GatewayConfigFile {
  if (mode === "replace") return incoming;
  const byId = new Map(current.gateways.map((g) => [g.id, g]));
  for (const gateway of incoming.gateways) byId.set(gateway.id, gateway);
  return {
    version: 1,
    autoRefreshTtlHours: incoming.autoRefreshTtlHours ?? current.autoRefreshTtlHours,
    gateways: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ---------------------------------------------------------------------------
// Atomic, serialized JSON writes
//
// Every persisted file here is written by *multiple concurrent writers*:
// `refreshStaleGateways` discovers all stale gateways in one process via
// Promise.all, and each result writes back through the same path. Two defects
// follow from the naive form (`write tmp -> rename`, tmp named
// `${path}.${pid}.${Date.now()}`):
//
//   A. Collision. `Date.now()` has millisecond resolution and `pid` is shared
//      by the whole process, so concurrent calls compute the SAME temp path.
//      The first rename consumes the file and every later rename throws ENOENT.
//
//   B. Lost updates. A whole-file read-modify-write with no serialization lets
//      two writers both read the pre-image, so the last one silently deletes
//      the other's key. This one does not throw — the file just loses a lane.
//
// Both were reproduced: 134 failed renames out of 160 concurrent saves, and
// 20/20 rounds dropped at least one gateway's metadata.
//
// Fixes: a per-path in-process lock (serialization), and a temp name that is
// unique per call (collision-free). Cross-process writers are covered by a
// bounded retry rather than a real lock — Node has no flock without a
// dependency, and pi itself documents the same class of hazard on its model
// store. A transient failure must never corrupt or silently truncate state.
// ---------------------------------------------------------------------------

let writeSeq = 0;

export function uniqueTempPath(path: string): string {
  writeSeq = (writeSeq + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${path}.${process.pid}.${writeSeq}.${rand}.tmp`;
}

const pathLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` alone among callers touching `path` in this process.
 *
 * The chain is deliberately continued on rejection: one failed write must not
 * poison every later write to the same file.
 */
function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  pathLocks.set(
    path,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

/** Write JSON atomically with a call-unique temp file, mode 0600. */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = uniqueTempPath(path);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

const RETRYABLE_WRITE_CODES = new Set(["ENOENT", "EEXIST", "EACCES", "EPERM", "EBUSY"]);

function isRetryableWrite(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && RETRYABLE_WRITE_CODES.has(code);
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read-modify-write one JSON object file, serialized per path and retried on
 * transient filesystem collisions.
 *
 * `mutate` returns false to mean "nothing changed", so callers can skip the
 * write entirely rather than rewrite identical content.
 */
export async function mutateJsonObjectFile(
  path: string,
  load: () => Promise<Record<string, unknown>>,
  mutate: (record: Record<string, unknown>) => boolean | void,
): Promise<boolean> {
  return withPathLock(path, async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const record = await load();
        if (mutate(record) === false) return false;
        await atomicWriteJson(path, record);
        return true;
      } catch (error) {
        lastError = error;
        if (!isRetryableWrite(error) || attempt === 2) break;
        await delayMs(20 * (attempt + 1));
      }
    }
    throw lastError;
  });
}

/** Read a JSON object file, treating absence or a bad shape as an empty record. */
export async function readJsonObjectFile(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Store one provider's API key in auth.json, serialized against other writers. */
export async function setStoredApiKey(providerId: string, key: string): Promise<void> {
  await mutateJsonObjectFile(AUTH_PATH, () => readJsonObjectFile(AUTH_PATH), (record) => {
    record[providerId] = { type: "api_key", key };
  });
}

export async function saveConfig(next: GatewayConfigFile): Promise<void> {
  await withPathLock(CONFIG_PATH, () => atomicWriteJson(CONFIG_PATH, next));
}

/** Read the user's default model from pi's settings (best-effort). */
export function readSettingsDefault(): { provider: string; modelId: string } | undefined {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
    };
    if (typeof data.defaultProvider === "string" && typeof data.defaultModel === "string") {
      return { provider: data.defaultProvider, modelId: data.defaultModel };
    }
  } catch {
    // No settings file (or unreadable) — no default.
  }
  return undefined;
}

/** Remove one key from a JSON object file, preserving unrelated entries (used for auth.json / models-store.json cleanup). */
export async function deleteJsonRecordKey(path: string, key: string): Promise<boolean> {
  let removed = false;
  await mutateJsonObjectFile(path, () => readJsonObjectFile(path), (record) => {
    if (!Object.hasOwn(record, key)) return false;
    delete record[key];
    removed = true;
  });
  return removed;
}
