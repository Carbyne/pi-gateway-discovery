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
  type Model,
  type Provider,
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
  deleteJsonRecordKey,
  inferenceBaseUrlForApi,
  loadConfig,
  normalizeBaseUrl,
  saveConfig,
  suggestGatewayIdentity,
  validateGatewayId,
  type GatewayApi,
  type GatewayConfig,
  type GatewayConfigFile,
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
  ttlMsFromConfig,
} from "./autorefresh.ts";
import { readSettingsDefault } from "./config.ts";
import { discoverGateway } from "./discovery.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chmod, rename, rm } from "node:fs/promises";

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
  error?: string;
}

let configFile: GatewayConfigFile = { version: 1, gateways: [] };
const lastSync = new Map<string, SyncInfo>();

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
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
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
          ...(result.status.maxTokensCapped
            ? { maxTokensCappedCount: result.status.maxTokensCapped.length }
            : {}),
        });
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
  configFile = { version: 1, gateways: [...gateways, gateway].sort((a, b) => a.id.localeCompare(b.id)) };
  await saveConfig(configFile);

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
  params: { baseUrl?: string; gatewayId?: string; displayName?: string; apiKeyEnv?: string; apiToken?: string; compat?: Record<string, unknown> },
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<Record<string, unknown>> {
  if (!params.baseUrl) throw new Error("baseUrl is required for action=add");

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
    ...(managed?.api ? { api: managed.api } : {}),
    ...(params.apiKeyEnv?.trim() ? { apiKeyEnv: params.apiKeyEnv.trim() } : managed?.apiKeyEnv ? { apiKeyEnv: managed.apiKeyEnv } : {}),
    ...(params.compat && Object.keys(params.compat).length > 0
      ? { compat: params.compat }
      : managed?.compat
        ? { compat: managed.compat }
        : {}),
    ...(managed?.modelOverrides ? { modelOverrides: managed.modelOverrides } : {}),
    ...(managed?.excludedModels ? { excludedModels: managed.excludedModels } : {}),
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

  configFile = { version: 1, gateways: configFile.gateways.filter((gateway) => gateway.id !== gatewayId) };
  await saveConfig(configFile);
  pi.unregisterProvider(gatewayId);
  lastSync.delete(gatewayId);
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
  return {
    state: "ok",
    at: ageMs(info.syncedAt),
    models: info.modelCount,
    matched: info.matchedCount,
    unmatched: info.unmatchedCount ?? info.unmatched?.length ?? 0,
    litellmEnriched: info.litellmEnriched,
    ...(info.maxTokensCappedCount ? { maxTokensCapped: info.maxTokensCappedCount } : {}),
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
  configFile = { version: 1, gateways: configFile.gateways.map((g) => (g.id === gatewayId ? updated : g)) };
  await saveConfig(configFile);
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

export default async function gatewayDiscoveryExtension(pi: ExtensionAPI): Promise<void> {
  try {
    configFile = await loadConfig();
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
      await refreshStaleGateways(configFile, (id, info) => {
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
      });
    } catch (error) {
      console.error(`[gateway-discovery] auto-refresh failed: ${errorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Cross-session propagation + periodic refresh (sessions only)
  // -------------------------------------------------------------------------

  let stopStoreWatcher: (() => void) | undefined;
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
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = undefined;
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("gw", {
    description: "Gateway model discovery: /gw add <url> [id] [token] | remove <id> | sync [id] | list | override <id> <model> [k=v ...]",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["add", "remove", "sync", "list", "override"].filter((c) => c.startsWith(prefix));
      if (subcommands.length > 0) return subcommands.map((value) => ({ value, label: value }));
      const gateways = configFile.gateways
        .filter((g) => g.id.startsWith(prefix))
        .map((g) => ({ value: g.id, label: g.id, description: g.name }));
      return gateways.length > 0 ? gateways : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/u);
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
        case "override":
          await cmdOverride(pi, rest, ctx);
          break;
        default:
          ctx.ui.notify(
            "Usage: /gw add <baseUrl> [id] [token] | /gw remove <id> | /gw sync [id] | /gw list | /gw override <id> <model> [k=v ... | clear]",
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
    const [rawUrl, rawId, rawToken] = args.trim().split(/\s+/u);

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

    let token = rawToken;
    if (!token && ctx.hasUI) {
      const promptedToken = await ctx.ui.input("API token (or leave blank to set later with /login)", "");
      token = promptedToken || undefined;
    }

    try {
      const result = await addGateway(pi, { baseUrl, gatewayId: id, apiToken: token }, ctx);
      const gateway = result.gateway as GatewayConfig;
      if (token) {
        ctx.ui.notify(`Registered gateway '${gateway.id}' (${gateway.name}). API key stored.`, "info");
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
        sync.state === "ok"
          ? `${sync.models} models, ${sync.matched} matched, ${sync.unmatched} unmatched${sync.maxTokensCapped ? `, ${sync.maxTokensCapped} output-capped` : ""} (${sync.at})`
          : sync.state === "error"
            ? `error: ${sync.error}`
            : `not synced — ${sync.hint}`;
      return `${gateway.id} (${gateway.api ?? "openai-completions"}) ${gateway.baseUrl}\n  ${syncText}`;
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
      "Manage model-discovery gateways (OpenAI-compatible / LiteLLM endpoints): add a gateway, remove it (including stored credential and model cache), force a model-list sync, set or clear per-model overrides, or inspect gateway status.",
    promptSnippet: "Add, remove, sync, override, or inspect model-discovery gateways",
    parameters: Type.Object({
      action: StringEnum(["add", "remove", "sync", "list", "override"] as const),
      baseUrl: Type.Optional(Type.String({ description: "Gateway base URL for action=add" })),
      gatewayId: Type.Optional(Type.String({ description: "Gateway id for add/remove/sync/override" })),
      displayName: Type.Optional(Type.String({ description: "Display name for action=add" })),
      apiKeyEnv: Type.Optional(Type.String({ description: "Env var name holding the API key (alternative to /login)" })),
      apiToken: Type.Optional(Type.String({ description: "API token to store immediately (optional, can use /login later)" })),
      compat: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "Gateway-level compat overrides (action=add) or merged into the model override (action=override)" }),
      ),
      modelId: Type.Optional(Type.String({ description: "Model id for action=override" })),
      api: Type.Optional(
        StringEnum(["openai-completions", "openai-responses", "anthropic-messages"] as const, {
          description: "Route a model to a different protocol (action=override)",
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
