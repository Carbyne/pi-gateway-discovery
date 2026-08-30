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
 *   /gw add <baseUrl> [id]   Register a gateway (then /login <id>)
 *   /gw remove <id>          Remove a gateway, its credential, and its cache
 *   /gw sync [id]            Force a model-list refresh
 *   /gw list                 Show gateways and last sync status
 *
 * Tool: `gateways` — the same operations for AI-driven setup.
 */

import {
  createProvider,
  StringEnum,
  Type,
  type Api,
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
} from "./config.ts";
import { discoverGateway } from "./discovery.ts";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface SyncInfo {
  ok: boolean;
  syncedAt: number;
  modelCount?: number;
  matchedCount?: number;
  unmatched?: Array<{ id: string; candidates: string[] }>;
  inferenceBaseUrl?: string;
  healthyEndpoints?: number;
  unhealthyEndpoints?: number;
  litellmEnriched?: boolean;
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
  params: { baseUrl?: string; gatewayId?: string; displayName?: string; apiKeyEnv?: string },
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
    ...(managed?.excludedModels ? { excludedModels: managed.excludedModels } : {}),
  };
  await saveAndRegister(pi, gateway, ctx);

  return {
    gateway,
    nextStep: `/login ${id}`,
    note: "Enter the API key through pi /login (or set the apiKeyEnv env var); keys are never stored in the config file.",
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
    unmatched: info.unmatched?.length ?? 0,
    litellmEnriched: info.litellmEnriched,
    ...(info.healthyEndpoints !== undefined
      ? { healthyEndpoints: info.healthyEndpoints, unhealthyEndpoints: info.unhealthyEndpoints ?? 0 }
      : {}),
  };
}

function listGateways(ctx: Pick<ExtensionCommandContext, "modelRegistry">): Record<string, unknown> {
  const builtIn = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
  return {
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

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("gw", {
    description: "Gateway model discovery: /gw add <url> [id] | remove <id> | sync [id] | list",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["add", "remove", "sync", "list"].filter((c) => c.startsWith(prefix));
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
        default:
          ctx.ui.notify("Usage: /gw add <baseUrl> [id] | /gw remove <id> | /gw sync [id] | /gw list", "warning");
      }
    },
  });

  async function cmdAdd(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("/gw add requires interactive or RPC UI mode (or use the gateways tool)", "error");
      return;
    }
    const [rawUrl, rawId] = args.trim().split(/\s+/u);

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

    try {
      const result = await addGateway(pi, { baseUrl, gatewayId: id }, ctx);
      const gateway = result.gateway as GatewayConfig;
      ctx.ui.notify(`Registered gateway '${gateway.id}' (${gateway.name}). Run /login ${gateway.id} to store the API key.`, "info");
      ctx.ui.setEditorText(`/login ${gateway.id}`);
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
          ? `${sync.models} models, ${sync.matched} matched, ${sync.unmatched} unmatched (${sync.at})`
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
      "Manage model-discovery gateways (OpenAI-compatible / LiteLLM endpoints): add a gateway, remove it (including stored credential and model cache), force a model-list sync, or list gateways with their last sync status. API keys are only entered via pi /login or env vars — this tool never accepts or exposes keys.",
    promptSnippet: "Add, remove, sync, or inspect model-discovery gateways",
    parameters: Type.Object({
      action: StringEnum(["add", "remove", "sync", "list"] as const),
      baseUrl: Type.Optional(Type.String({ description: "Gateway base URL for action=add" })),
      gatewayId: Type.Optional(Type.String({ description: "Gateway id for add/remove/sync" })),
      displayName: Type.Optional(Type.String({ description: "Display name for action=add" })),
      apiKeyEnv: Type.Optional(Type.String({ description: "Env var name holding the API key (alternative to /login)" })),
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
