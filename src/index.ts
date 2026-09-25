/**
 * pi-gateway-discovery — dynamic model discovery for OpenAI-compatible and
 * LiteLLM API gateways.
 *
 * Each configured gateway is registered with pi as a native dynamic provider
 * (createProvider + fetchModels). Pi owns the model cache (models-store.json)
 * and the refresh lifecycle; this extension owns endpoint probing, metadata
 * enrichment, and catalog matching.
 *
 * Secrets: API keys are stored by pi's /login in auth.json (0600) or read
 * from an ambient env var (gateway.apiKeyEnv). They never appear in the
 * config file or in AI-visible output.
 *
 * Commands:
 *   /gw add <baseUrl> [id] [token]  Register a gateway with optional API token
 *   /gw remove <id>                 Remove a gateway, its credential, and its cache
 *   /gw sync [id]                   Force a model-list refresh
 *   /gw list                         Show gateways and last sync status
 *
 * Tool: `gateways` — the same operations for AI-driven setup.
 */

import {
  createProvider,
  StringEnum,
  Type,
  type Api,
  type FetchFunction,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  AUTH_PATH,
  CONFIG_PATH,
  MODELS_STORE_PATH,
  deleteDiscoveryMeta,
  deleteJsonRecordKey,
  diffGatewayConfigs,
  fingerprintConfig,
  inferenceBaseUrlForApi,
  isGatewayApi,
  loadConfig,
  loadDiscoveryMeta,
  mergeGatewayConfigs,
  normalizeBaseUrl,
  parseGatewayConfig,
  saveConfig,
  saveDiscoveryMeta,
  suggestGatewayIdentity,
  validateGatewayId,
  type ConfigDelta,
  type GatewayApi,
  type GatewayConfig,
  type GatewayConfigFile,
  type GatewayDiscoveryMeta,
  type ModelOverride,
} from "./config.ts";
import {
  AUTO_REFRESH_DEFAULT_TTL_HOURS,
  PERIODIC_CHECK_INTERVAL_MS,
  isOffline,
  markSelfWrite,
  readStoreModels,
  refreshStaleGateways,
  staleGatewayIds,
  startStoreWatcher,
  startConfigWatcher,
  resolveGatewayKey,
  ttlMsFromConfig,
} from "./autorefresh.ts";
import { readSettingsDefault } from "./config.ts";
import { discoverGateway, type GatewayDiscoveryStatus } from "./discovery.ts";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { chmod, rename, rm } from "node:fs/promises";
import { nodeHttpFetch } from "./streaming-fetch.ts";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface SyncInfo {
  ok: boolean;
  syncedAt: number;
  modelCount?: number;
  matchedCount?: number;
  unmatchedCount?: number;
  unmatched?: Array<{ id: string; candidates: string[] }>;
  inferenceBaseUrl?: string;
  healthyEndpoints?: number;
  unhealthyEndpoints?: number;
  litellmEnriched?: boolean;
  maxTokensCappedCount?: number;
  excludedUnusableCount?: number;
  quirksAppliedCount?: number;
  /** Which models were auto-configured, and where each setting came from. */
  quirksAppliedDetail?: Array<{ id: string; note: string; source: "declared" | "quirk" }>;
  excludedUnusableDetail?: Array<{ id: string; reason: string }>;
  /** Protocol actually used, and whether config or negotiation chose it. */
  api?: GatewayApi;
  apiSource?: "explicit" | "negotiated";
  error?: string;
}

let configFile: GatewayConfigFile = { version: 1, gateways: [] };
/** Fingerprint of `configFile` as last read from disk. */
let loadedConfigFingerprint = "";
/**
 * Gateways whose on-disk config changed since their last successful sync.
 * The provider has been re-registered, so new requests use the new settings,
 * but the cached catalog was derived from the old ones — worth saying out loud
 * rather than letting `state: "ok"` imply everything is current.
 */
const driftedGateways = new Set<string>();

/** Mirror of gateway-discovery-meta.json, refreshed on load and on write. */
let persistedMeta: Record<string, GatewayDiscoveryMeta> = {};

interface DiscoveryMetaView {
  syncedAt: number;
  modelCount?: number;
  inferenceBaseUrl?: string;
  excludedUnusableDetail?: Array<{ id: string; reason: string }>;
  quirksAppliedDetail?: Array<{ id: string; note: string; source: "declared" | "quirk" }>;
  quirksSuppressed?: Array<{ id: string; note: string }>;
  /** True when this came from disk rather than a discovery run in this session. */
  persisted: boolean;
}

/**
 * Discovery metadata for a gateway: prefer what this session observed, else
 * fall back to the persisted record. Without the fallback, `describe` and
 * `doctor` could not report provenance in a fresh session — which is the
 * normal case, since discovery rarely runs in the session that asks.
 */
function discoveryMetaFor(gatewayId: string): DiscoveryMetaView | undefined {
  const info = lastSync.get(gatewayId);
  if (info?.ok) {
    return {
      syncedAt: info.syncedAt,
      modelCount: info.modelCount,
      inferenceBaseUrl: info.inferenceBaseUrl,
      excludedUnusableDetail: info.excludedUnusableDetail,
      quirksAppliedDetail: info.quirksAppliedDetail,
      persisted: false,
    };
  }
  const meta = persistedMeta[gatewayId];
  if (!meta) return undefined;
  return {
    syncedAt: meta.syncedAt,
    modelCount: meta.modelCount,
    inferenceBaseUrl: meta.inferenceBaseUrl,
    excludedUnusableDetail: meta.excludedUnusable,
    quirksAppliedDetail: meta.quirksApplied,
    quirksSuppressed: meta.quirksSuppressed,
    persisted: true,
  };
}

/**
 * Persist the discovery record (provenance + exclusions) for a gateway.
 *
 * Both discovery paths must call this: the provider's `fetchModels` and the
 * factory's `refreshStaleGateways`. The latter is what `pi --list-models` and
 * `pi -p` use, so writing only from `fetchModels` silently produced no
 * metadata in exactly the headless flows that bootstrap a new machine.
 */
async function recordDiscoveryMeta(
  gatewayId: string,
  modelCount: number,
  status?: GatewayDiscoveryStatus,
): Promise<void> {
  const meta: GatewayDiscoveryMeta = {
    syncedAt: Date.now(),
    modelCount,
    ...(status ? { inferenceBaseUrl: status.inferenceBaseUrl } : {}),
    ...(status?.excludedUnusable ? { excludedUnusable: status.excludedUnusable } : {}),
    ...(status?.quirksApplied ? { quirksApplied: status.quirksApplied } : {}),
    ...(status?.quirksSuppressed ? { quirksSuppressed: status.quirksSuppressed } : {}),
  };
  persistedMeta = { ...persistedMeta, [gatewayId]: meta };
  try {
    await saveDiscoveryMeta(gatewayId, meta);
  } catch (error) {
    // Reporting data, not the catalog itself — but say so, rather than
    // swallowing it: a silently missing file reads as "nothing was excluded".
    console.error(`[gateway-discovery] could not persist discovery metadata for ${gatewayId}: ${errorMessage(error)}`);
  }
}

/** Write config and keep the in-memory copy and its fingerprint in step. */
async function persistConfig(next: GatewayConfigFile): Promise<void> {
  configFile = next;
  loadedConfigFingerprint = fingerprintConfig(next);
  await saveConfig(next);
}

/**
 * Reconcile the in-memory config with what is on disk.
 *
 * `configFile` is loaded once at extension start and each provider closes over
 * its own `GatewayConfig`, so a hand-edit (or another session's `/gw` call)
 * otherwise leaves `sync` re-deriving models from stale settings while still
 * reporting success. Call this at the top of every operation that reads
 * `configFile`; it is a no-op when nothing changed.
 *
 * Never throws: a half-written file must not break an otherwise healthy
 * session, so on any read/parse failure the in-memory config is kept.
 */
async function ensureConfigCurrent(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<ConfigDelta | undefined> {
  let fresh: GatewayConfigFile;
  try {
    fresh = await loadConfig();
  } catch {
    return undefined;
  }
  const fingerprint = fingerprintConfig(fresh);
  if (fingerprint === loadedConfigFingerprint) return undefined;

  const delta = diffGatewayConfigs(configFile, fresh);
  configFile = fresh;
  loadedConfigFingerprint = fingerprint;

  for (const id of delta.removed) {
    try {
      pi.unregisterProvider(id);
    } catch {
      // Already gone.
    }
    lastSync.delete(id);
    driftedGateways.delete(id);
  }
  for (const id of [...delta.added, ...delta.modified]) {
    const gateway = fresh.gateways.find((candidate) => candidate.id === id);
    if (!gateway) continue;
    pi.registerProvider(makeProvider(gateway));
    // Cached models came from the previous settings; mark for re-discovery.
    driftedGateways.add(id);
  }
  return delta.changed ? delta : undefined;
}
const lastSync = new Map<string, SyncInfo>();

function wrapStreams(gateway: GatewayConfig, streams: ProviderStreams): ProviderStreams {
  return gateway.directHttpStreaming ? withDirectStreamingFetch(streams) : streams;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ageMs(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/**
 * Wrap a ProviderStreams implementation so every request path that threads
 * a custom fetch through (stream / streamSimple / fetchDeferred /
 * cancelDeferred) uses the node:http-backed streaming fetch. Used for
 * gateways with `directHttpStreaming: true` (HTTP/1.1-only gateways where
 * undici buffers the whole chunked response — see streaming-fetch.ts).
 * An explicitly passed fetch (should one ever exist) is preserved.
 */
function withDirectStreamingFetch(streams: ProviderStreams): ProviderStreams {
  const inject = <T extends object | undefined>(
    options: T,
  ): T & { fetch?: FetchFunction } => ({
    ...(options ?? {}),
    fetch: (options as { fetch?: FetchFunction } | undefined)?.fetch ?? nodeHttpFetch,
  }) as T & { fetch?: FetchFunction };
  const wrapped: ProviderStreams = {
    stream: (model, context, options) => streams.stream(model, context, inject(options)),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, inject(options)),
  };
  if (streams.fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options) =>
      streams.fetchDeferred!(model, handle, inject(options));
  }
  if (streams.cancelDeferred) {
    wrapped.cancelDeferred = async (model, handle, options) =>
      streams.cancelDeferred!(model, handle, inject(options));
  }
  return wrapped;
}

function makeProvider(gateway: GatewayConfig): Provider<Api> {
  const api: GatewayApi = gateway.api ?? "openai-completions";

  const resolveKey = async (): Promise<string | undefined> => {
    // Ambient env var first so it can be rotated without re-login.
    if (gateway.apiKeyEnv) {
      const envKey = process.env[gateway.apiKeyEnv];
      if (envKey) return envKey;
    }
    return undefined;
  };

  return createProvider<Api>({
    id: gateway.id,
    name: gateway.name,
    baseUrl: inferenceBaseUrlForApi(gateway.baseUrl, api),
    auth: {
      apiKey: {
        name: `${gateway.name} API key`,
        async login(interaction) {
          const key = await interaction.prompt({
            type: "secret",
            message: `Enter the API key for ${gateway.name} (${gateway.baseUrl})`,
          });
          if (!key.trim()) throw new Error("API key cannot be empty");
          return { type: "api_key", key: key.trim() };
        },
        async check({ credential, ctx }) {
          if (credential?.key) return { type: "api_key", source: "stored API key" };
          if (gateway.apiKeyEnv) {
            const envKey = await ctx.env(gateway.apiKeyEnv);
            if (envKey) return { type: "api_key", source: gateway.apiKeyEnv };
          }
          return undefined;
        },
        async resolve({ credential, ctx }) {
          if (credential?.key) {
            return { auth: { apiKey: credential.key }, source: "stored API key" };
          }
          if (gateway.apiKeyEnv) {
            const envKey = await ctx.env(gateway.apiKeyEnv);
            if (envKey) return { auth: { apiKey: envKey }, source: gateway.apiKeyEnv };
          }
          return undefined;
        },
      },
    },
    models: [],
    api: {
      "openai-completions": wrapStreams(gateway, openAICompletionsApi()),
      "openai-responses": wrapStreams(gateway, openAIResponsesApi()),
      "anthropic-messages": wrapStreams(gateway, anthropicMessagesApi()),
    },
    fetchModels: async (context) => {
      if (!context.allowNetwork) return [];

      // In-process TTL gate: serve the cached catalog when this session
      // already fetched recently. Prevents a duplicate network fetch when
      // pi's own background refresh follows the factory auto-refresh; pi
      // documents `force` as "bypass provider freshness checks".
      const ttlMs = ttlMsFromConfig(configFile);
      const last = lastSync.get(gateway.id);
      if (
        !context.force &&
        ttlMs > 0 &&
        last?.ok &&
        Date.now() - last.syncedAt < ttlMs &&
        context.stored &&
        context.stored.models.length > 0
      ) {
        return context.stored.models.filter((m) => m.provider === gateway.id);
      }

      const credential = context.credential;
      const key =
        (credential?.type === "api_key" ? credential.key : undefined) ?? (await resolveKey());
      if (!key) {
        throw new Error(
          `No API key for gateway '${gateway.id}' — run /login ${gateway.id}` +
            (gateway.apiKeyEnv ? ` or set ${gateway.apiKeyEnv}` : ""),
        );
      }

      try {
        const result = await discoverGateway(gateway, key, context.signal);
        lastSync.set(gateway.id, {
          ok: true,
          syncedAt: Date.now(),
          modelCount: result.status.modelCount,
          matchedCount: result.status.matched.length,
          unmatched: result.status.unmatched.map((u) => ({
            id: u.id,
            candidates: u.candidates.map((c) => `${c.provider}/${c.id}`),
          })),
          inferenceBaseUrl: result.status.inferenceBaseUrl,
          healthyEndpoints: result.status.healthyEndpoints,
          unhealthyEndpoints: result.status.unhealthyEndpoints,
          litellmEnriched: result.status.litellmEnriched,
          api: result.status.api,
          apiSource: result.status.apiSource,
          ...(result.status.maxTokensCapped
            ? { maxTokensCappedCount: result.status.maxTokensCapped.length }
            : {}),
          ...(result.status.excludedUnusable
            ? { excludedUnusableCount: result.status.excludedUnusable.length }
            : {}),
          ...(result.status.quirksApplied
            ? { quirksAppliedCount: result.status.quirksApplied.length, quirksAppliedDetail: result.status.quirksApplied }
            : {}),
          ...(result.status.excludedUnusable
            ? { excludedUnusableDetail: result.status.excludedUnusable }
            : {}),
        });
        // A successful re-discovery was derived from the current settings, so
        // any recorded drift is now resolved.
        driftedGateways.delete(gateway.id);
        await recordDiscoveryMeta(gateway.id, result.status.modelCount, result.status);
        return result.models;
      } catch (error) {
        lastSync.set(gateway.id, { ok: false, syncedAt: Date.now(), error: errorMessage(error) });
        throw error;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Config mutation + registration
// ---------------------------------------------------------------------------

async function saveAndRegister(
  pi: ExtensionAPI,
  gateway: GatewayConfig,
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<void> {
  const replacing = configFile.gateways.some((g) => g.id === gateway.id);
  const gateways = configFile.gateways.filter((g) => g.id !== gateway.id);
  await persistConfig({ version: 1, gateways: [...gateways, gateway].sort((a, b) => a.id.localeCompare(b.id)) });

  if (replacing) pi.unregisterProvider(gateway.id);
  pi.registerProvider(makeProvider(gateway));

  // Best-effort immediate refresh so the model list is available right away.
  try {
    await ctx.modelRegistry.refresh({ providers: [gateway.id], force: true });
  } catch {
    // Not fatal — the user can run /gw sync later.
  }
}

interface InternalModelRuntime {
  logout?(providerId: string): Promise<void>;
  models?: {
    modelsStore?: {
      delete(providerId: string): Promise<void>;
    };
  };
}

/**
 * Remove a gateway's stored credential and model cache. Prefer the live
 * runtime capability (keeps in-memory state coherent); fall back to editing
 * the persisted files directly.
 */
async function cleanupGatewayState(
  gatewayId: string,
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<{ credential: "runtime" | "file"; modelCache: "runtime" | "file" }> {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: InternalModelRuntime }).runtime;

  let credential: "runtime" | "file";
  if (runtime?.logout) {
    await runtime.logout(gatewayId);
    credential = "runtime";
  } else {
    await deleteJsonRecordKey(AUTH_PATH, gatewayId);
    credential = "file";
  }

  let modelCache: "runtime" | "file";
  if (runtime?.models?.modelsStore) {
    await runtime.models.modelsStore.delete(gatewayId);
    modelCache = "runtime";
  } else {
    await deleteJsonRecordKey(MODELS_STORE_PATH, gatewayId);
    modelCache = "file";
  }
  return { credential, modelCache };
}

// ---------------------------------------------------------------------------
// Operations (shared by commands and the AI tool)
// ---------------------------------------------------------------------------

async function addGateway(
  pi: ExtensionAPI,
  params: { baseUrl?: string; gatewayId?: string; displayName?: string; apiKeyEnv?: string; apiToken?: string; api?: string; compat?: Record<string, unknown>; directHttpStreaming?: boolean },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Record<string, unknown>> {
  if (!params.baseUrl) throw new Error("baseUrl is required for action=add");

  // Validate before touching anything: registering a lane under a protocol it
  // does not speak produces a catalog of models that all fail at inference.
  let explicitApi: GatewayApi | undefined;
  if (params.api !== undefined && params.api !== "") {
    if (!isGatewayApi(params.api)) {
      throw new Error(
        `Invalid api '${params.api}' — expected openai-completions, openai-responses, or anthropic-messages`,
      );
    }
    explicitApi = params.api;
  }

  const existingIds = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
  for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) existingIds.add(providerId);
  for (const gateway of configFile.gateways) existingIds.add(gateway.id);

  const suggested = suggestGatewayIdentity(params.baseUrl, existingIds);
  const id = params.gatewayId ? validateGatewayId(params.gatewayId) : suggested.id;
  const managed = configFile.gateways.find((gateway) => gateway.id === id);
  if (ctx.modelRegistry.getProvider(id) && !managed) {
    throw new Error(`Provider '${id}' already exists and is not managed by gateway-discovery`);
  }

  const gateway: GatewayConfig = {
    id,
    name: params.displayName?.trim() || managed?.name || suggested.name,
    baseUrl: normalizeBaseUrl(params.baseUrl),
    ...(explicitApi ?? managed?.api ? { api: explicitApi ?? managed!.api! } : {}),
    ...(params.apiKeyEnv?.trim() ? { apiKeyEnv: params.apiKeyEnv.trim() } : managed?.apiKeyEnv ? { apiKeyEnv: managed.apiKeyEnv } : {}),
    ...(params.compat && Object.keys(params.compat).length > 0
      ? { compat: params.compat }
      : managed?.compat
        ? { compat: managed.compat }
        : {}),
    ...(managed?.modelOverrides ? { modelOverrides: managed.modelOverrides } : {}),
    ...(managed?.excludedModels ? { excludedModels: managed.excludedModels } : {}),
    ...(params.directHttpStreaming ?? managed?.directHttpStreaming
      ? { directHttpStreaming: true }
      : {}),
  };
  await saveAndRegister(pi, gateway, ctx);

  // If an API token was provided, store it in auth.json
  if (params.apiToken?.trim()) {
    const tempPath = `${AUTH_PATH}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(AUTH_PATH), { recursive: true });
      const auth = await (async () => {
        try {
          const content = await readFile(AUTH_PATH, "utf8");
          return JSON.parse(content) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      auth[id] = { type: "api_key", key: params.apiToken.trim() };
      await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, AUTH_PATH);
      await chmod(AUTH_PATH, 0o600);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  return {
    gateway,
    nextStep: params.apiToken ? undefined : `/login ${id}`,
    note: params.apiToken 
      ? "API key has been stored and is ready to use."
      : "Enter the API key through pi /login (or set the apiKeyEnv env var); keys are never stored in the config file.",
  };
}

async function removeGateway(
  pi: ExtensionAPI,
  params: { gatewayId?: string },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Record<string, unknown>> {
  if (!params.gatewayId) throw new Error("gatewayId is required for action=remove");
  const gatewayId = validateGatewayId(params.gatewayId);
  const current = configFile.gateways.find((gateway) => gateway.id === gatewayId);
  if (!current) throw new Error(`Unknown gateway: ${gatewayId}`);

  await persistConfig({ version: 1, gateways: configFile.gateways.filter((gateway) => gateway.id !== gatewayId) });
  pi.unregisterProvider(gatewayId);
  lastSync.delete(gatewayId);
  await deleteDiscoveryMeta(gatewayId);
  delete persistedMeta[gatewayId];
  const cleanup = await cleanupGatewayState(gatewayId, ctx);
  await ctx.modelRegistry.refresh();

  return {
    removed: gatewayId,
    displayName: current.name,
    credentialCleanup: cleanup.credential,
    modelCacheCleanup: cleanup.modelCache,
  };
}

async function syncGateways(
  params: { gatewayId?: string },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Record<string, unknown>> {
  const targets = params.gatewayId
    ? [validateGatewayId(params.gatewayId)]
    : configFile.gateways.map((gateway) => gateway.id);

  const unknown = targets.filter((id) => !configFile.gateways.some((gateway) => gateway.id === id));
  if (unknown.length > 0) throw new Error(`Unknown gateway${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);

  const result = await ctx.modelRegistry.refresh({ providers: targets, force: true });
  const errors = [...result.errors.entries()].map(([id, error]) => ({ id, error: errorMessage(error) }));

  return {
    targets,
    aborted: result.aborted,
    errors,
    status: targets.map((id) => ({ id, ...summarizeSync(id) })),
  };
}

function summarizeSync(id: string): Record<string, unknown> {
  const info = lastSync.get(id);
  if (!info) return { state: "not-synced", hint: `run /login ${id} then /gw sync ${id}` };
  if (!info.ok) return { state: "error", at: ageMs(info.syncedAt), error: info.error };
  const drifted = driftedGateways.has(id);
  return {
    state: drifted ? "config-changed" : "ok",
    at: ageMs(info.syncedAt),
    ...(drifted
      ? { hint: `config edited since this catalog was derived — run /gw sync ${id}` }
      : {}),
    models: info.modelCount,
    matched: info.matchedCount,
    unmatched: info.unmatchedCount ?? info.unmatched?.length ?? 0,
    litellmEnriched: info.litellmEnriched,
    ...(info.api ? { api: info.api, apiSource: info.apiSource } : {}),
    ...(info.maxTokensCappedCount ? { maxTokensCapped: info.maxTokensCappedCount } : {}),
    ...(info.excludedUnusableCount ? { excludedUnusable: info.excludedUnusableCount } : {}),
    ...(info.quirksAppliedCount ? { quirksApplied: info.quirksAppliedCount } : {}),
    ...(info.healthyEndpoints !== undefined
      ? { healthyEndpoints: info.healthyEndpoints, unhealthyEndpoints: info.unhealthyEndpoints ?? 0 }
      : {}),
  };
}

/**
 * Set or clear per-model overrides for a gateway (topmost metadata layer).
 * Re-registers the provider and forces a refresh so the new overrides are
 * baked into the model cache.
 */
async function overrideModel(
  pi: ExtensionAPI,
  params: {
    gatewayId?: string;
    modelId?: string;
    api?: GatewayApi;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    thinkingLevelMap?: Record<string, string | null>;
    compat?: Record<string, unknown>;
    clear?: boolean;
  },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Record<string, unknown>> {
  if (!params.gatewayId) throw new Error("gatewayId is required for action=override");
  const gatewayId = validateGatewayId(params.gatewayId);
  const gateway = configFile.gateways.find((g) => g.id === gatewayId);
  if (!gateway) throw new Error(`Unknown gateway: ${gatewayId}`);

  const overrides: Record<string, ModelOverride> = { ...(gateway.modelOverrides ?? {}) };
  if (params.clear) {
    if (params.modelId) delete overrides[params.modelId];
    else for (const key of Object.keys(overrides)) delete overrides[key];
  } else {
    if (!params.modelId) throw new Error("modelId is required for action=override");
    const next: ModelOverride = { ...overrides[params.modelId] };
    if (params.api !== undefined) next.api = params.api;
    if (params.reasoning !== undefined) next.reasoning = params.reasoning;
    if (params.contextWindow !== undefined) next.contextWindow = params.contextWindow;
    if (params.maxTokens !== undefined) next.maxTokens = params.maxTokens;
    if (params.thinkingLevelMap !== undefined) next.thinkingLevelMap = params.thinkingLevelMap;
    if (params.compat !== undefined) next.compat = { ...(next.compat ?? {}), ...params.compat };
    overrides[params.modelId] = next;
  }

  const updated: GatewayConfig = {
    ...gateway,
    ...(Object.keys(overrides).length > 0 ? { modelOverrides: overrides } : { modelOverrides: undefined }),
  };
  await persistConfig({ version: 1, gateways: configFile.gateways.map((g) => (g.id === gatewayId ? updated : g)) });
  pi.registerProvider(makeProvider(updated));
  await ctx.modelRegistry.refresh({ providers: [gatewayId], force: true });

  return {
    gateway: gatewayId,
    model: params.modelId ?? "(all)",
    modelOverrides: updated.modelOverrides ?? {},
  };
}

function listGateways(ctx: Pick<ExtensionCommandContext, "modelRegistry">): Record<string, unknown> {
  const builtIn = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
  const ttlMs = ttlMsFromConfig(configFile);
  return {
    autoRefresh: {
      ttlHours: configFile.autoRefreshTtlHours ?? AUTO_REFRESH_DEFAULT_TTL_HOURS,
      offline: isOffline(),
      stale: staleGatewayIds(configFile, ttlMs),
    },
    gateways: configFile.gateways.map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      baseUrl: gateway.baseUrl,
      api: gateway.api ?? "openai-completions",
      keySource: gateway.apiKeyEnv ? `env:${gateway.apiKeyEnv}` : "login",
      ...(gateway.directHttpStreaming ? { directHttpStreaming: true } : {}),
      shadowsBuiltinProvider: builtIn.has(gateway.id),
      sync: summarizeSync(gateway.id),
    })),
  };
}

/**
 * Restore a usable model when a session starts with the sentinel "unknown"
 * model (see session_start). Best-effort: re-reads the store fresh, restores
 * the gateway catalogs to the registry (offline), and sets the settings
 * default model (or the first cached gateway model) as the session model.
 */
async function selfHealUnknownModel(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionCommandContext, "modelRegistry" | "ui" | "hasUI">,
): Promise<void> {
  const gatewayIds = configFile.gateways.map((g) => g.id);
  if (gatewayIds.length > 0) {
    // Offline refresh: pi re-reads the store (its file revision changed when the
    // in-flight write completed) and republishes the cached catalogs.
    void ctx.modelRegistry.refresh({ providers: gatewayIds, allowNetwork: false }).catch(() => {});
  }

  let restore: Model<Api> | undefined;
  const def = readSettingsDefault();
  if (def && configFile.gateways.some((g) => g.id === def.provider)) {
    let models = readStoreModels(def.provider) as Model<Api>[] | undefined;
    if (!models) {
      // The racing write may still be in flight — give it a moment and retry.
      await new Promise((r) => setTimeout(r, 500));
      models = readStoreModels(def.provider) as Model<Api>[] | undefined;
    }
    restore = models?.find((m) => m.id === def.modelId);
  }
  if (!restore) {
    for (const gateway of configFile.gateways) {
      let models = readStoreModels(gateway.id) as Model<Api>[] | undefined;
      if (!models) {
        await new Promise((r) => setTimeout(r, 500));
        models = readStoreModels(gateway.id) as Model<Api>[] | undefined;
      }
      if (models?.length) {
        restore = models[0];
        break;
      }
    }
  }
  if (!restore) return;

  try {
    const ok = await pi.setModel(restore);
    if (ok && ctx.hasUI) {
      ctx.ui.notify(
        `Model was lost at session start (store read raced a write); restored ${restore.provider}/${restore.id}.`,
        "info",
      );
    }
  } catch {
    // Best-effort; the user can still pick a model manually.
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Portable bundles: export / import
// -------------------------------------------------------------------------

interface GatewayBundle {
  bundleVersion: 1;
  generatedBy: string;
  generatedAt: string;
  config: GatewayConfigFile;
  /** Present only when the export was explicitly asked to include keys. */
  credentials?: Record<string, string>;
}

async function readStoredApiKeys(): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await readFile(AUTH_PATH, "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >;
    const out: Record<string, string> = {};
    for (const [id, entry] of Object.entries(data)) {
      if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key) out[id] = entry.key;
    }
    return out;
  } catch {
    return {};
  }
}

async function mergeStoredApiKeys(credentials: Record<string, string>): Promise<string[]> {
  const tempPath = `${AUTH_PATH}.${process.pid}.${Date.now()}.tmp`;
  let auth: Record<string, unknown> = {};
  try {
    auth = JSON.parse(await readFile(AUTH_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    // No auth file yet.
  }
  const written: string[] = [];
  for (const [id, key] of Object.entries(credentials)) {
    if (typeof key !== "string" || !key) continue;
    auth[id] = { type: "api_key", key };
    written.push(id);
  }
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, AUTH_PATH);
    await chmod(AUTH_PATH, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return written;
}

interface ExportResult {
  path: string;
  gateways: number;
  gatewayIds: string[];
  credentialsIncluded: boolean;
  credentialProviders: string[];
  note: string;
}

async function exportBundle(params: {
  path?: string;
  withKeys?: boolean;
  overwrite?: boolean;
}): Promise<ExportResult> {
  if (!params.path) throw new Error("path is required for action=export");
  const target = resolvePath(params.path);
  if (existsSync(target) && !params.overwrite) {
    throw new Error(`Refusing to overwrite ${target} — pass overwrite=true to replace it`);
  }
  if (configFile.gateways.length === 0) throw new Error("No gateways configured — nothing to export");

  const credentials = params.withKeys ? await readStoredApiKeys() : undefined;
  const bundle: GatewayBundle = {
    bundleVersion: 1,
    generatedBy: "pi-gateway-discovery",
    generatedAt: new Date().toISOString(),
    // Deep copy: exporting must not hand out references into live config.
    config: JSON.parse(JSON.stringify(configFile)) as GatewayConfigFile,
    ...(credentials && Object.keys(credentials).length > 0 ? { credentials } : {}),
  };

  await mkdir(dirname(target), { recursive: true });
  // Always 0600: even a key-less bundle names internal endpoints.
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);

  return {
    path: target,
    gateways: bundle.config.gateways.length,
    gatewayIds: bundle.config.gateways.map((g) => g.id),
    credentialsIncluded: !!bundle.credentials,
    credentialProviders: bundle.credentials ? Object.keys(bundle.credentials) : [],
    note: bundle.credentials
      ? "WARNING: this file contains API keys. Treat it as a secret; do not commit or paste it."
      : "API keys are not included. Run /login <gatewayId> after importing, or set apiKeyEnv per gateway.",
  };
}

interface ImportResult {
  from: string;
  mode: "merge" | "replace";
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  totalGateways: number;
  credentialsInstalled: string[];
  needsLogin: string[];
  note?: string;
}

async function importBundle(
  pi: ExtensionAPI,
  params: { path?: string; mode?: string },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<ImportResult> {
  if (!params.path) throw new Error("path is required for action=import");
  const target = resolvePath(params.path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read bundle ${target}: ${errorMessage(error)}`);
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  const configInput = record.bundleVersion === 1 ? record.config : record;
  // Reuse the loader's validator: an import must be held to exactly the rules
  // the live config file is, or a bad bundle can reach the registry.
  const incoming = parseGatewayConfig(configInput);

  let credentialsInstalled: string[] = [];
  const creds = record.credentials;
  if (creds && typeof creds === "object" && !Array.isArray(creds)) {
    credentialsInstalled = await mergeStoredApiKeys(creds as Record<string, string>);
  }

  const mode: "merge" | "replace" = params.mode === "replace" ? "replace" : "merge";
  let next: GatewayConfigFile;
  if (mode === "replace") {
    next = incoming;
  } else {
    const byId = new Map(configFile.gateways.map((g) => [g.id, g]));
    for (const gateway of incoming.gateways) byId.set(gateway.id, gateway);
    next = {
      version: 1,
      autoRefreshTtlHours: incoming.autoRefreshTtlHours ?? configFile.autoRefreshTtlHours,
      gateways: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  const delta = diffGatewayConfigs(configFile, next);
  await persistConfig(next);
  for (const id of delta.removed) {
    try {
      pi.unregisterProvider(id);
    } catch {
      // Already gone.
    }
    lastSync.delete(id);
    driftedGateways.delete(id);
  }
  const toSync = [...delta.added, ...delta.modified];
  for (const id of toSync) {
    const gateway = next.gateways.find((candidate) => candidate.id === id);
    if (gateway) pi.registerProvider(makeProvider(gateway));
  }
  if (toSync.length > 0) {
    await ctx.modelRegistry.refresh({ providers: toSync, force: true }).catch(() => {});
  }

  const missingKeys = next.gateways
    .filter((g) => !g.apiKeyEnv)
    .map((g) => g.id)
    .filter((id) => !credentialsInstalled.includes(id));

  const imported: ImportResult = {
    from: target,
    mode,
    added: delta.added,
    updated: delta.modified,
    removed: delta.removed,
    unchanged: next.gateways.length - delta.added.length - delta.modified.length - delta.removed.length,
    totalGateways: next.gateways.length,
    credentialsInstalled,
    needsLogin: missingKeys,
    ...(missingKeys.length > 0 ? { note: `Run /login for: ${missingKeys.join(", ")}` } : {}),
  };
  return imported;
}

// -------------------------------------------------------------------------
// Setup health
// -------------------------------------------------------------------------

/**
 * Answer "is this actually working?" without having to try a model first.
 *
 * Each check corresponds to a failure that produced no useful error when it
 * happened: a gateway with no credential, a catalog derived from since-edited
 * config, a saved default model the upstream renamed, a lane whose discovery
 * failed silently. All of them are invisible until a request fails, which is
 * the worst possible moment to find out.
 */
export function doctorGateways(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): {
  ok: boolean;
  problems: string[];
  warnings: string[];
  gateways: Array<{
    id: string;
    api: string;
    models: number;
    excludedUnusable: number | null;
    autoConfigured: number | null;
    synced: string;
    quirksSuppressed: Array<{ id: string; note: string }>;
    issues: string[];
  }>;
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  const all = ctx.modelRegistry.getAll();

  if (configFile.gateways.length === 0) {
    return {
      ok: false,
      problems: ["no gateways configured — run /gw add <baseUrl>"],
      warnings: [],
      gateways: [],
    };
  }

  const ttlMs = ttlMsFromConfig(configFile);
  const gateways = configFile.gateways.map((gateway) => {
    const info = discoveryMetaFor(gateway.id);
    const models = all.filter((m) => m.provider === gateway.id);
    const issues: string[] = [];

    // A fresh session legitimately restores models from the cache without
    // contacting the gateway, so "never synced here" is only a problem when
    // nothing was restored — otherwise it is informational. Reporting it as a
    // problem would make every healthy session look broken and teach users to
    // ignore the output.
    const live = lastSync.get(gateway.id);
    if (!live) {
      if (models.length === 0) issues.push("no models registered and never synced in this session");
      else warnings.push(`${gateway.id}: using the cached catalog (${models.length} models); run /gw sync ${gateway.id} to re-discover`);
    } else if (!live.ok) issues.push(`discovery failed: ${live.error ?? "unknown error"}`);
    else if (driftedGateways.has(gateway.id))
      issues.push(`config edited after this catalog was built (run /gw sync ${gateway.id})`);

    if (!resolveGatewayKey(gateway)) {
      issues.push(
        gateway.apiKeyEnv
          ? `apiKeyEnv ${gateway.apiKeyEnv} is not set in this environment`
          : `no credential — run /login ${gateway.id} or set apiKeyEnv`,
      );
    }
    if (live?.ok && models.length === 0) {
      issues.push("catalog is empty — every model was filtered or excluded");
    }
    if (info && ttlMs > 0 && Date.now() - info.syncedAt > ttlMs) {
      warnings.push(`${gateway.id}: catalog older than the ${Math.round(ttlMs / 3_600_000)}h refresh TTL`);
    }

    for (const issue of issues) problems.push(`${gateway.id}: ${issue}`);
    return {
      id: gateway.id,
      api: gateway.api ?? "(negotiated)",
      models: models.length,
      // null means "no discovery record exists to answer from"; 0 means the
      // record exists and says nothing was filtered. Collapsing the two would
      // make a clean lane look like an unmeasured one.
      excludedUnusable: info ? (info.excludedUnusableDetail?.length ?? 0) : null,
      autoConfigured: info ? (info.quirksAppliedDetail?.length ?? 0) : null,
      synced: info ? (info.persisted ? `${ageMs(info.syncedAt)} (from disk)` : ageMs(info.syncedAt)) : "never",
      quirksSuppressed: info?.quirksSuppressed ?? [],
      issues,
    };
  });

  // A saved default pointing at a renamed model resolves to *a* provider and
  // then fails at request time with an error that never says "your default
  // model no longer exists" — the exact trap of a gateway that renames models.
  const saved = readSettingsDefault();
  if (saved) {
    if (configFile.gateways.some((g) => g.id === saved.provider)) {
      const known = all.some((m) => m.provider === saved.provider && m.id === saved.modelId);
      if (!known) {
        const served = all.filter((m) => m.provider === saved.provider).map((m) => m.id);
        problems.push(
          `settings default ${saved.provider}/${saved.modelId} is not registered`
          + (served.length
            ? `; this gateway serves: ${served.slice(0, 6).join(", ")}${served.length > 6 ? " …" : ""}`
            : ""),
        );
      }
    }
  }

  if (isOffline()) warnings.push("PI_OFFLINE is set — discovery will not reach the network");

  return { ok: problems.length === 0, problems, warnings, gateways };
}

// -------------------------------------------------------------------------
// Effective configuration
// -------------------------------------------------------------------------

/**
 * Report the *resolved* settings for a gateway or one of its models, with the
 * layer each value came from.
 *
 * After four merge layers (defaults, upstream-declared metadata, quirk table,
 * gateway.compat, modelOverrides) the composed answer is not recoverable from
 * the config file alone, and "did my setting take effect?" was otherwise only
 * answerable by re-deriving the merge by hand.
 */
function describeGateway(
  params: { gatewayId?: string; modelId?: string },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Record<string, unknown> {
  if (!params.gatewayId) throw new Error("gatewayId is required for action=describe");
  const gatewayId = validateGatewayId(params.gatewayId);
  const gateway = configFile.gateways.find((g) => g.id === gatewayId);
  if (!gateway) throw new Error(`Unknown gateway: ${gatewayId}`);

  const meta = discoveryMetaFor(gatewayId);
  const all = ctx.modelRegistry.getAll().filter((m) => m.provider === gatewayId);

  const provenanceFor = (id: string): Record<string, unknown> => {
    // Must read the merged view: in a fresh session `lastSync` is empty and the
    // provenance lives only in the persisted record, so consulting lastSync
    // alone made every auto-configured value look like a pi-core default.
    const applied = meta?.quirksAppliedDetail?.find((q) => q.id === id);
    const override = gateway.modelOverrides?.[id];
    return {
      api: override?.api ? "modelOverrides" : applied?.source === "quirk" ? "quirk-table" : gateway.api ? "gateway.api" : "negotiated-or-default",
      thinkingLevelMap: override?.thinkingLevelMap
        ? "modelOverrides"
        : applied?.source === "declared"
          ? "upstream-declared"
          : applied?.source === "quirk"
            ? "quirk-table"
            : "default (pi core clamping)",
      compat: override?.compat ? "modelOverrides" : gateway.compat ? "gateway.compat + defaults" : "defaults",
      note: applied?.note,
      suppressed: meta?.quirksSuppressed?.find((q) => q.id === id)?.note,
    };
  };

  if (params.modelId) {
    const model = all.find((m) => m.id === params.modelId);
    if (!model) {
      throw new Error(
        `Model '${params.modelId}' is not registered on ${gatewayId} (${all.length} models known; it may be excluded)`,
      );
    }
    return {
      gateway: gatewayId,
      baseUrl: gateway.baseUrl,
      model: {
        id: model.id,
        name: model.name,
        api: model.api,
        provider: model.provider,
        inferenceBaseUrl: model.baseUrl,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        compat: model.compat ?? null,
        thinkingLevelMap: model.thinkingLevelMap ?? null,
      },
      source: provenanceFor(model.id),
    };
  }

  return {
    gateway: gatewayId,
    name: gateway.name,
    configuredBaseUrl: gateway.baseUrl,
    configuredApi: gateway.api ?? "(unset — negotiated)",
    inferenceBaseUrl: meta?.inferenceBaseUrl ?? inferenceBaseUrlForApi(gateway.baseUrl, gateway.api ?? "openai-completions"),
    apiKeyEnv: gateway.apiKeyEnv ?? null,
    directHttpStreaming: gateway.directHttpStreaming ?? false,
    gatewayCompat: gateway.compat ?? null,
    modelOverrides: gateway.modelOverrides ? Object.keys(gateway.modelOverrides) : [],
    excludedModels: gateway.excludedModels ?? [],
    excludeUnusable: gateway.excludeUnusable !== false,
    sync: meta
      ? {
          ok: true,
          from: meta.persisted ? "persisted metadata" : "this session",
          models: meta.modelCount,
          excludedUnusable: meta.excludedUnusableDetail ?? [],
          autoConfigured: (meta.quirksAppliedDetail ?? []).map((q) => ({ id: q.id, via: q.source, note: q.note })),
          suppressedQuirks: meta.quirksSuppressed ?? [],
        }
      : { ok: false, note: "no discovery metadata recorded for this gateway" },
    registeredModels: all.map((m) => m.id),
  };
}


export default async function gatewayDiscoveryExtension(pi: ExtensionAPI): Promise<void> {
  try {
    configFile = await loadConfig();
    loadedConfigFingerprint = fingerprintConfig(configFile);
    persistedMeta = await loadDiscoveryMeta();
  } catch (error) {
    console.error(`[gateway-discovery] ${errorMessage(error)}`);
    return;
  }

  for (const gateway of configFile.gateways) {
    try {
      pi.registerProvider(makeProvider(gateway));
    } catch (error) {
      console.error(`[gateway-discovery] Failed to register ${gateway.id}: ${errorMessage(error)}`);
    }
  }

  // Auto-refresh: re-discover gateways whose cached catalog is older than
  // the TTL. pi awaits the factory and restores the cache from the store
  // after registration, so every mode — including `pi --list-models` and
  // `pi -p` — starts with a fresh model list. Fresh cache → zero delay.
  if (configFile.gateways.length > 0 && !isOffline()) {
    try {
      await refreshStaleGateways(configFile, async (id, info) => {
        lastSync.set(id, {
          ok: info.ok,
          syncedAt: Date.now(),
          ...(info.modelCount !== undefined ? { modelCount: info.modelCount } : {}),
          ...(info.matchedCount !== undefined ? { matchedCount: info.matchedCount } : {}),
          ...(info.unmatchedCount !== undefined ? { unmatchedCount: info.unmatchedCount } : {}),
          ...(info.inferenceBaseUrl ? { inferenceBaseUrl: info.inferenceBaseUrl } : {}),
          ...(info.litellmEnriched !== undefined ? { litellmEnriched: info.litellmEnriched } : {}),
          ...(info.maxTokensCappedCount !== undefined ? { maxTokensCappedCount: info.maxTokensCappedCount } : {}),
          ...(info.error ? { error: info.error } : {}),
        });
        if (info.ok && info.status) {
          await recordDiscoveryMeta(id, info.status.modelCount, info.status);
        }
      });
    } catch (error) {
      console.error(`[gateway-discovery] auto-refresh failed: ${errorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Cross-session propagation + periodic refresh (sessions only)
  // -------------------------------------------------------------------------

  let stopStoreWatcher: (() => void) | undefined;
  let stopConfigWatcher: (() => void) | undefined;
  let periodicTimer: NodeJS.Timeout | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // Self-heal: a session can start with the sentinel "unknown" model when
    // its fresh ModelRuntime read the model store while a write was in
    // flight (the store is written in-place; a concurrent reader can parse
    // partial/empty JSON and silently restore no models). Re-read the store
    // (the write has completed by now) and restore a usable model.
    const current = ctx.model;
    if (current && current.provider === "unknown" && current.id === "unknown") {
      await selfHealUnknownModel(pi, ctx);
    }
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    stopStoreWatcher?.();
    stopStoreWatcher = startStoreWatcher({
      getGatewayIds: () => configFile.gateways.map((g) => g.id),
      onExternalChange: (ids) => {
        // Offline refresh: pi re-reads the store (file revision changed)
        // and publishes the restored catalog to this session's registry.
        void ctx.modelRegistry.refresh({ providers: ids, allowNetwork: false }).catch(() => {});
      },
    });
    stopConfigWatcher?.();
    stopConfigWatcher = startConfigWatcher({
      onExternalChange: () => {
        // Reconcile providers with the file. Discovery stays explicit, so a
        // stray edit can never trigger a network sync behind the user's back.
        void ensureConfigCurrent(pi, ctx).catch(() => {});
      },
    });
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = setInterval(() => {
      const stale = staleGatewayIds(configFile, ttlMsFromConfig(configFile));
      if (stale.length === 0) return;
      markSelfWrite(10_000);
      void ctx.modelRegistry.refresh({ providers: stale, force: true }).catch(() => {});
    }, PERIODIC_CHECK_INTERVAL_MS);
    periodicTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    stopStoreWatcher?.();
    stopStoreWatcher = undefined;
    stopConfigWatcher?.();
    stopConfigWatcher = undefined;
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = undefined;
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("gw", {
    description: "Gateway model discovery: /gw add <url> [id] [api=…] [direct=true] | remove <id> | sync [id] | list | describe <id> [model] | override <id> <model> [k=v] | export [path] | import <path>",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["add", "remove", "sync", "list", "describe", "doctor", "override", "export", "import"].filter((c) => c.startsWith(prefix));
      if (subcommands.length > 0) return subcommands.map((value) => ({ value, label: value }));
      const gateways = configFile.gateways
        .filter((g) => g.id.startsWith(prefix))
        .map((g) => ({ value: g.id, label: g.id, description: g.name }));
      return gateways.length > 0 ? gateways : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/u);
      // Pick up config edits made outside this session before acting on it.
      await ensureConfigCurrent(pi, ctx);
      switch (sub) {
        case "add":
          await cmdAdd(pi, rest.join(" "), ctx);
          break;
        case "remove":
          await cmdRemove(rest.join(" "), ctx);
          break;
        case "sync":
          await cmdSync(rest.join(" "), ctx);
          break;
        case "list":
        case undefined:
          cmdList(ctx);
          break;
        case "doctor": {
          const report = doctorGateways(ctx);
          const lines = [
            report.ok ? "✓ gateway setup looks healthy" : `✗ ${report.problems.length} problem(s)`,
            ...report.problems.map((p) => `  ! ${p}`),
            ...report.warnings.map((w) => `  ~ ${w}`),
            ...report.gateways.map((g) =>
              `  ${g.id}: ${g.models} models (${g.api}), ${g.excludedUnusable} excluded, ${g.autoConfigured} auto-configured, synced ${g.synced}`),
          ];
          ctx.ui.notify(lines.join("\n"), report.ok ? "info" : "error");
          break;
        }
        case "describe":
          try {
            const [gatewayId, modelId] = rest;
            ctx.ui.notify(JSON.stringify(describeGateway({ gatewayId, modelId }, ctx), null, 2), "info");
          } catch (error) {
            ctx.ui.notify(errorMessage(error), "error");
          }
          break;
        case "export":
          try {
            const pathArg = rest.find((t) => !t.startsWith("--"));
            const result = await exportBundle({
              path: pathArg ?? "pi-gateways.json",
              withKeys: rest.includes("--keys"),
              overwrite: rest.includes("--force"),
            });
            ctx.ui.notify(
              `Exported ${result.gateways} gateway(s) to ${result.path}`
                + `${result.credentialsIncluded ? " INCLUDING API KEYS" : " (no API keys)"}`
                + `\n${result.note}`,
              result.credentialsIncluded ? "warning" : "info",
            );
          } catch (error) {
            ctx.ui.notify(errorMessage(error), "error");
          }
          break;
        case "import":
          try {
            const pathArg = rest.find((t) => !t.startsWith("--"));
            if (!pathArg) throw new Error("Usage: /gw import <path> [--replace]");
            const result = await importBundle(pi, { path: pathArg, mode: rest.includes("--replace") ? "replace" : "merge" }, ctx);
            ctx.ui.notify(
              `Imported ${result.totalGateways} gateway(s) from ${pathArg}: `
                + `${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed`
                + `${result.needsLogin.length ? `\nNeeds /login: ${result.needsLogin.join(", ")}` : ""}`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(errorMessage(error), "error");
          }
          break;
        case "override":
          await cmdOverride(pi, rest, ctx);
          break;
        default:
          ctx.ui.notify(
            "Usage: /gw add <baseUrl> [id] [token] [api=…] [direct=true|false] | /gw remove <id> | /gw sync [id] | /gw list | /gw override <id> <model> [k=v ... | clear]",
            "warning",
          );
      }
    },
  });

  async function cmdOverride(pi: ExtensionAPI, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
    const [gatewayId, modelId, ...kv] = rest;
    if (!gatewayId || !modelId) {
      ctx.ui.notify(
        "Usage: /gw override <gatewayId> <modelId> [api=... reasoning=true|false contextWindow=N maxTokens=N thinkingLevelMap={json} compat={json}] | /gw override <gatewayId> <modelId> clear",
        "warning",
      );
      return;
    }
    try {
      const params: {
        gatewayId: string;
        modelId: string;
        clear?: boolean;
        api?: GatewayApi;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
        thinkingLevelMap?: Record<string, string | null>;
        compat?: Record<string, unknown>;
      } = { gatewayId, modelId };
      for (const token of kv) {
        if (token === "clear") {
          params.clear = true;
          continue;
        }
        const eq = token.indexOf("=");
        if (eq <= 0) throw new Error(`Invalid override token: ${token}`);
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        switch (key) {
          case "api":
            if (value !== "openai-completions" && value !== "openai-responses" && value !== "anthropic-messages") {
              throw new Error(`Invalid api value: ${value}`);
            }
            params.api = value;
            break;
          case "reasoning":
            if (value !== "true" && value !== "false") throw new Error(`Invalid reasoning value: ${value}`);
            params.reasoning = value === "true";
            break;
          case "contextWindow":
          case "maxTokens": {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${key} value: ${value}`);
            params[key] = n;
            break;
          }
          case "thinkingLevelMap":
          case "compat": {
            const parsed: unknown = JSON.parse(value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error(`${key} must be a JSON object`);
            }
            if (key === "thinkingLevelMap") params.thinkingLevelMap = parsed as Record<string, string | null>;
            else params.compat = parsed as Record<string, unknown>;
            break;
          }
          default:
            throw new Error(`Unknown override key: ${key}`);
        }
      }
      const result = await overrideModel(pi, params, ctx);
      ctx.ui.notify(`Override updated for ${result.gateway}/${result.model}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function cmdAdd(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("/gw add requires interactive or RPC UI mode (or use the gateways tool)", "error");
      return;
    }
    const tokens = args.trim().length > 0 ? args.trim().split(/\s+/u) : [];
    const [rawUrl, rawId] = tokens;
    // `key=value` tokens are flags; everything else is positional. Parsing the
    // first non-`direct` token as the API key (the previous behaviour) meant a
    // mistyped or unsupported flag such as `api=anthropic-messages` was
    // silently written to auth.json as the gateway's secret.
    const flags: Record<string, string> = {};
    const positional: string[] = [];
    for (const token of tokens.slice(2)) {
      const eq = token.indexOf("=");
      if (eq > 0) flags[token.slice(0, eq)] = token.slice(eq + 1);
      else positional.push(token);
    }
    const rawToken = positional[0];

    let directHttpStreaming: boolean | undefined;
    for (const [name, value] of Object.entries(flags)) {
      if (name === "direct" || name === "directStreaming") {
        if (value !== "true" && value !== "false") {
          ctx.ui.notify(`Ignoring ${name}=${value} (expected true or false)`, "warning");
          continue;
        }
        directHttpStreaming = value === "true";
      } else if (name !== "api") {
        ctx.ui.notify(`Ignoring unknown flag: ${name}=… (supported: api=…, direct=true|false)`, "warning");
      }
    }

    let baseUrl = rawUrl;
    if (!baseUrl) {
      const promptedUrl = await ctx.ui.input("Gateway base URL", "https://example.com/api-gateway");
      if (!promptedUrl) return;
      baseUrl = promptedUrl;
    }

    let id = rawId;
    if (!id) {
      const existingIds = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
      for (const gateway of configFile.gateways) existingIds.add(gateway.id);
      const suggested = suggestGatewayIdentity(baseUrl, existingIds);
      const promptedId = await ctx.ui.input("Gateway ID", suggested.id);
      if (!promptedId) return;
      id = promptedId;
    }

    let token: string | undefined = rawToken;
    if (!token && ctx.hasUI) {
      const promptedToken = await ctx.ui.input("API token (or leave blank to set later with /login)", "");
      token = promptedToken || undefined;
    }

    try {
      const result = await addGateway(
        pi,
        { baseUrl, gatewayId: id, apiToken: token, api: flags["api"], directHttpStreaming },
        ctx,
      );
      const gateway = result.gateway as GatewayConfig;
      if (token) {
        ctx.ui.notify(
          `Registered gateway '${gateway.id}' (${gateway.name}). API key stored. ` +
            `Note: it was typed on the command line, so it is visible in this session log and your shell history.`,
          "warning",
        );
      } else {
        ctx.ui.notify(`Registered gateway '${gateway.id}' (${gateway.name}). Run /login ${gateway.id} to store the API key.`, "info");
        ctx.ui.setEditorText(`/login ${gateway.id}`);
      }
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  }

  async function cmdRemove(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("/gw remove requires interactive or RPC UI mode (or use the gateways tool)", "error");
      return;
    }
    if (configFile.gateways.length === 0) {
      ctx.ui.notify("No gateways configured. Run /gw add <baseUrl>.", "info");
      return;
    }

    let gatewayId = args.trim();
    if (!gatewayId) {
      const selected = await ctx.ui.select(
        "Remove gateway",
        configFile.gateways.map((gateway) => gateway.id),
      );
      if (!selected) return;
      gatewayId = selected;
    }

    let normalizedId: string;
    try {
      normalizedId = validateGatewayId(gatewayId);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return;
    }
    const current = configFile.gateways.find((gateway) => gateway.id === normalizedId);
    if (!current) {
      ctx.ui.notify(`Unknown gateway: ${normalizedId}`, "error");
      return;
    }

    const confirmed = await ctx.ui.confirm(
      "Remove gateway?",
      `${current.name} (${current.id})\nThis also removes its stored credential and model cache.`,
    );
    if (!confirmed) return;

    try {
      await removeGateway(pi, { gatewayId: normalizedId }, ctx);
      ctx.ui.notify(`Removed ${normalizedId}, its credential, and its model cache.`, "info");
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  }

  async function cmdSync(args: string, ctx: ExtensionCommandContext): Promise<void> {
    ctx.ui.setStatus("gateway-discovery", "syncing gateway models…");
    try {
      const result = await syncGateways({ gatewayId: args.trim() || undefined }, ctx);
      const lines = (result.status as Array<Record<string, unknown>>).map((entry) => {
        const state = entry.state as string;
        if (state === "ok") {
          const parts = [`${entry.id}: ${entry.models} models`];
          if (typeof entry.matched === "number") parts.push(`${entry.matched} matched`);
          if (typeof entry.unmatched === "number" && entry.unmatched > 0) parts.push(`${entry.unmatched} unmatched`);
          if (typeof entry.healthyEndpoints === "number") parts.push(`endpoints ${entry.healthyEndpoints}✓/${entry.unhealthyEndpoints}✗`);
          parts.push(`(${entry.at})`);
          return parts.join(", ");
        }
        if (state === "error") return `${entry.id}: error — ${entry.error}`;
        return `${entry.id}: not synced — ${entry.hint}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    } finally {
      ctx.ui.setStatus("gateway-discovery", undefined);
    }
  }

  function cmdList(ctx: ExtensionCommandContext): void {
    if (configFile.gateways.length === 0) {
      ctx.ui.notify("No gateways configured. Run /gw add <baseUrl> [id].", "info");
      return;
    }
    const lines = configFile.gateways.map((gateway) => {
      const sync = summarizeSync(gateway.id);
      const syncText =
        sync.state === "ok" || sync.state === "config-changed"
          ? `${sync.models} models, ${sync.matched} matched, ${sync.unmatched} unmatched`
            + `${sync.maxTokensCapped ? `, ${sync.maxTokensCapped} output-capped` : ""}`
            + `${sync.excludedUnusable ? `, ${sync.excludedUnusable} excluded` : ""}`
            + `${sync.quirksApplied ? `, ${sync.quirksApplied} auto-configured` : ""}`
            + ` (${sync.at})`
            + `${sync.state === "config-changed" ? `\n  \u26a0 ${sync.hint}` : ""}`
          : sync.state === "error"
            ? `error: ${sync.error}`
            : `not synced — ${sync.hint}`;
      const flags = gateway.directHttpStreaming ? " [direct-http-streaming]" : "";
      // Show the protocol in use, not the one written in config: when `api` is
      // omitted it is negotiated at discovery time, and "did my setting take
      // effect?" is the question /gw list is being asked.
      const effectiveApi = (sync.api ?? gateway.api ?? "openai-completions") as string;
      const apiLabel = sync.api && sync.apiSource === "negotiated" ? `${effectiveApi} (negotiated)` : effectiveApi;
      return `${gateway.id} (${apiLabel}) ${gateway.baseUrl}${flags}\n  ${syncText}`;
    });
    ctx.ui.notify(lines.join("\n"), "info");
  }

  // -------------------------------------------------------------------------
  // AI tool
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "gateways",
    label: "Gateway Models",
    description:
      "Manage model-discovery gateways (OpenAI-compatible / LiteLLM endpoints): add a gateway (optionally with an explicit inference protocol or directHttpStreaming), remove it (including stored credential and model cache), force a model-list sync, set or clear per-model overrides, inspect gateway status, describe the *effective* configuration of a gateway or model (with the layer each value came from), and export/import a portable bundle so a tuned setup can be reproduced on another machine.",
    promptSnippet: "Add, remove, sync, override, describe, or export/import model-discovery gateways",
    parameters: Type.Object({
      action: StringEnum(["add", "remove", "sync", "list", "describe", "doctor", "override", "export", "import"] as const),
      path: Type.Optional(
        Type.String({ description: "Bundle file path for action=export (write target) or action=import (read source)" }),
      ),
      withKeys: Type.Optional(
        Type.Boolean({ description: "action=export only: include stored API keys. Off by default — a key-less bundle is the safe artifact to share. Enable only for private machine-to-machine migration." }),
      ),
      overwrite: Type.Optional(
        Type.Boolean({ description: "action=export only: replace an existing file at path" }),
      ),
      mode: Type.Optional(
        Type.String({ description: "action=import only: 'merge' (default, upsert by gateway id) or 'replace' (adopt the bundle wholesale)" }),
      ),
      baseUrl: Type.Optional(Type.String({ description: "Gateway base URL for action=add" })),
      gatewayId: Type.Optional(Type.String({ description: "Gateway id for add/remove/sync/override" })),
      displayName: Type.Optional(Type.String({ description: "Display name for action=add" })),
      apiKeyEnv: Type.Optional(Type.String({ description: "Env var name holding the API key (alternative to /login)" })),
      apiToken: Type.Optional(Type.String({ description: "API token to store immediately (optional, can use /login later)" })),
      directHttpStreaming: Type.Optional(
        Type.Boolean({ description: "Route streaming inference through a node:http-based fetch instead of undici (action=add; for HTTP/1.1-only gateways whose chunked SSE responses undici buffers until completion)" }),
      ),
      compat: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "Gateway-level compat overrides (action=add) or merged into the model override (action=override)" }),
      ),
      modelId: Type.Optional(Type.String({ description: "Model id for action=override" })),
      api: Type.Optional(
        StringEnum(["openai-completions", "openai-responses", "anthropic-messages"] as const, {
          description:
            "Protocol for a model (action=override) or a whole lane (action=add). For add, omit it to let discovery negotiate OpenAI vs Anthropic lanes; set it only to override that.",
        }),
      ),
      reasoning: Type.Optional(Type.Boolean({ description: "Force reasoning on/off for a model (action=override)" })),
      contextWindow: Type.Optional(Type.Number({ description: "Override context window (action=override)" })),
      maxTokens: Type.Optional(Type.Number({ description: "Override max output tokens (action=override)" })),
      thinkingLevelMap: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()], { description: "Level map value" }), {
          description: "Replace the model's thinking-level map; null marks a level unsupported (action=override)",
        }),
      ),
      clear: Type.Optional(
        Type.Boolean({ description: "Clear the override for modelId (or all overrides when modelId is omitted) (action=override)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Pick up config edits made outside this session before acting on it.
      await ensureConfigCurrent(pi, ctx);
      let result: unknown;
      switch (params.action) {
        case "add":
          result = await addGateway(pi, params, ctx);
          break;
        case "remove":
          result = await removeGateway(pi, params, ctx);
          break;
        case "sync":
          result = await syncGateways(params, ctx);
          break;
        case "describe":
          result = describeGateway(params, ctx);
          break;
        case "doctor":
          result = doctorGateways(ctx);
          break;
        case "export":
          result = await exportBundle(params);
          break;
        case "import":
          result = await importBundle(pi, params, ctx);
          break;
        case "override":
          result = await overrideModel(pi, params, ctx);
          break;
        default:
          result = listGateways(ctx);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
