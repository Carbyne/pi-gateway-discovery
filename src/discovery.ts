/**
 * Gateway model discovery engine.
 *
 * Discovery strategy (all best-effort, each layer enriches the next):
 *   1. Model list:  GET {base}/models, then {base}/v1/models (OpenAI-style
 *      `data[]`, `models[]`, or bare arrays). The endpoint that answers also
 *      determines the inference base URL.
 *   2. LiteLLM enrichment (when the gateway exposes it):
 *        - GET {base}/v1/model/info  (single call, full metadata per model)
 *        - fallback: GET {base}/health → per healthy endpoint
 *          GET {base}/model/info?litellm_model_id=...
 *   3. Built-in catalog matching: unknown ids are matched (exact, then by
 *      suffix, then fuzzy) against pi's built-in model catalog so well-known
 *      models served through a gateway keep their real metadata.
 *
 * The engine is pure with respect to pi: it only returns Model<Api> objects
 * and a status report. Registration/caching is owned by pi (models-store.json).
 */

import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { GatewayApi, GatewayConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_HEALTH_ENDPOINTS = 64;

/** Conservative defaults for models with no discoverable metadata. */
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8_192;

/** Fields from litellm_params that may contain secrets or deployment details. */
const SENSITIVE_PARAM_KEYS = new Set([
  "api_key", "api_base", "api_version", "base_model",
  "vertex_project", "vertex_location", "vertex_credentials",
  "aws_access_key_id", "aws_secret_access_key", "aws_region_name",
]);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ModelMatch {
  id: string;
  /** e.g. "builtin:openai/gpt-5" or "gateway" (metadata came from the gateway itself). */
  source: string;
}

export interface ModelCandidate {
  provider: string;
  id: string;
  name: string;
  score: number;
}

export interface GatewayDiscoveryStatus {
  modelCount: number;
  matched: ModelMatch[];
  unmatched: Array<{ id: string; candidates: ModelCandidate[] }>;
  inferenceBaseUrl: string;
  /** Present when the gateway answered LiteLLM /health. */
  healthyEndpoints?: number;
  unhealthyEndpoints?: number;
  /** True when LiteLLM /model/info metadata was merged in. */
  litellmEnriched: boolean;
}

export interface GatewayDiscoveryResult {
  models: Model<Api>[];
  status: GatewayDiscoveryStatus;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface FetchOutcome {
  status: number;
  json?: unknown;
  error?: string;
}

async function fetchJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

type RawEntry = Record<string, unknown>;

function asRecord(value: unknown): RawEntry | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawEntry) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  return undefined;
}

/** Accept `data[]`, `models[]`, or a bare array of strings/objects. */
function parseModelEntries(payload: unknown): RawEntry[] | null {
  let entries: unknown;
  if (Array.isArray(payload)) {
    entries = payload;
  } else {
    const record = asRecord(payload);
    entries = record ? (Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined) : undefined;
  }
  if (!Array.isArray(entries)) return null;

  const out: RawEntry[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      out.push({ id: entry.trim() });
    } else if (asRecord(entry)) {
      out.push(entry as RawEntry);
    }
  }
  return out;
}

interface ModelListResult {
  entries: RawEntry[];
  /** Base URL for inference (the list endpoint's origin, minus /models). */
  inferenceBaseUrl: string;
}

async function fetchModelList(baseUrl: string, headers: Record<string, string>, signal?: AbortSignal): Promise<ModelListResult> {
  const candidates = [`${baseUrl}/models`, `${baseUrl}/v1/models`];
  let lastError = "no endpoint tried";

  for (const endpoint of candidates) {
    const outcome = await fetchJson(endpoint, headers, signal);
    if (signal?.aborted) throw new Error("Discovery aborted");

    if (outcome.status === 0) {
      lastError = `${endpoint}: unreachable (${outcome.error ?? "connection failed"})`;
      continue;
    }
    if (outcome.status === 401 || outcome.status === 403) {
      throw new Error(`${endpoint}: ${outcome.status} — check the API key for this gateway`);
    }
    if (!outcome.json) {
      lastError = `${endpoint}: HTTP ${outcome.status} (non-JSON response)`;
      continue;
    }

    const entries = parseModelEntries(outcome.json);
    if (!entries) {
      lastError = `${endpoint}: response does not contain a model array`;
      continue;
    }
    if (entries.length === 0) {
      lastError = `${endpoint}: model list is empty`;
      continue;
    }

    return { entries, inferenceBaseUrl: endpoint.slice(0, endpoint.length - "/models".length) };
  }

  throw new Error(`Unable to fetch gateway model list (${lastError})`);
}

// ---------------------------------------------------------------------------
// LiteLLM enrichment
// ---------------------------------------------------------------------------

/** Flatten one /model/info entry: model_info + non-sensitive litellm_params. */
function flattenLiteLLMInfo(entry: RawEntry): RawEntry | null {
  const modelName = asString(entry.model_name);
  if (!modelName) return null;

  const safeParams: RawEntry = {};
  const params = asRecord(entry.litellm_params);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (!SENSITIVE_PARAM_KEYS.has(k)) safeParams[k] = v;
    }
  }
  const info = asRecord(entry.model_info) ?? {};
  return { ...info, ...safeParams, model_name: modelName };
}

/**
 * Best-effort LiteLLM metadata. Returns a map keyed by model_name, or null
 * when the gateway does not expose LiteLLM admin endpoints.
 */
async function fetchLiteLLMInfo(
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, RawEntry> | null> {
  // Primary: /v1/model/info (or /model/info) — one call for everything.
  // A 200 with an EMPTY list is common on scoped gateways: remember the shape
  // but fall through to the /health per-endpoint fallback below.
  for (const endpoint of [`${baseUrl}/v1/model/info`, `${baseUrl}/model/info`]) {
    const outcome = await fetchJson(endpoint, headers, signal);
    if (signal?.aborted) throw new Error("Discovery aborted");
    if (outcome.status !== 200) continue;
    const data = asRecord(outcome.json)?.data;
    if (!Array.isArray(data)) continue;
    const map = new Map<string, RawEntry>();
    for (const entry of data) {
      const flat = flattenLiteLLMInfo(asRecord(entry) ?? {});
      if (flat) map.set(flat.model_name as string, flat);
    }
    if (map.size > 0) return map;
  }

  // Fallback: /health → per-endpoint /model/info?litellm_model_id=...
  const health = await fetchJson(`${baseUrl}/health`, headers, signal);
  if (health.status !== 200) return null;
  const healthy = asRecord(health.json)?.healthy_endpoints;
  if (!Array.isArray(healthy) || healthy.length === 0) return null;

  const map = new Map<string, RawEntry>();
  const endpoints = healthy.slice(0, MAX_HEALTH_ENDPOINTS);
  const results = await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      const modelId = asString(asRecord(endpoint)?.model_id);
      if (!modelId) return null;
      const outcome = await fetchJson(
        `${baseUrl}/model/info?litellm_model_id=${encodeURIComponent(modelId)}`,
        headers,
        signal,
      );
      if (outcome.status !== 200) return null;
      const data = asRecord(outcome.json)?.data;
      return Array.isArray(data) ? (asRecord(data[0]) ?? null) : null;
    }),
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const flat = flattenLiteLLMInfo(result.value);
    if (flat) map.set(flat.model_name as string, flat);
  }
  return map.size > 0 ? map : null;
}

/** Health counts for the status report (independent of whether info was merged). */
async function fetchLiteLLMHealthCounts(
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ healthy: number; unhealthy: number } | null> {
  const health = await fetchJson(`${baseUrl}/health`, headers, signal);
  if (health.status !== 200) return null;
  const record = asRecord(health.json);
  const healthy = Array.isArray(record?.healthy_endpoints) ? record.healthy_endpoints.length : null;
  const unhealthy = Array.isArray(record?.unhealthy_endpoints) ? record.unhealthy_endpoints.length : null;
  if (healthy === null && unhealthy === null) return null;
  return { healthy: healthy ?? 0, unhealthy: unhealthy ?? 0 };
}

// ---------------------------------------------------------------------------
// Built-in catalog matching
// ---------------------------------------------------------------------------

interface BuiltinIndex {
  byId: Map<string, Model<Api>[]>;
  bySuffix: Map<string, Model<Api>[]>;
  all: Model<Api>[];
}

let builtinIndex: BuiltinIndex | undefined;

function getBuiltinIndex(): BuiltinIndex {
  if (builtinIndex) return builtinIndex;
  const byId = new Map<string, Model<Api>[]>();
  const bySuffix = new Map<string, Model<Api>[]>();
  const all: Model<Api>[] = [];
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      all.push(model);
      const push = (map: Map<string, Model<Api>[]>, key: string) => {
        const list = map.get(key);
        if (list) list.push(model);
        else map.set(key, [model]);
      };
      push(byId, model.id);
      const slash = model.id.lastIndexOf("/");
      if (slash >= 0) push(bySuffix, model.id.slice(slash + 1));
    }
  }
  builtinIndex = { byId, bySuffix, all };
  return builtinIndex;
}

/** Prefer first-party providers when several catalog entries share an id. */
function sourceRank(model: Model<Api>): number {
  if (model.provider === "anthropic" || model.provider === "openai") return 0;
  if (model.provider === "openai-codex") return 1;
  return 2;
}

function pickBest(models: Model<Api>[]): Model<Api> {
  return [...models].sort((a, b) => sourceRank(a) - sourceRank(b))[0]!;
}

function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^.*\//u, "")
    .replace(/(?:^|[-_.])20\d{6}$/u, "")
    .replace(/[^a-z0-9]+/gu, "");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j < current.length; j += 1) previous[j] = current[j]!;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

/** Fuzzy candidates for unmatched ids (for human confirmation, never auto-applied). */
export function suggestBuiltinCandidates(remoteModelId: string, limit = 3): ModelCandidate[] {
  const needle = normalizeModelName(remoteModelId);
  if (!needle) return [];
  const { all } = getBuiltinIndex();
  const deduplicated = new Map<string, ModelCandidate>();

  for (const model of all) {
    const candidate = normalizeModelName(model.id);
    if (!candidate) continue;
    const maxLength = Math.max(needle.length, candidate.length);
    const similarity = maxLength === 0 ? 1 : 1 - editDistance(needle, candidate) / maxLength;
    const containment = needle.includes(candidate) || candidate.includes(needle) ? 0.25 : 0;
    const score = Math.round(Math.min(1, similarity + containment) * 100);
    const key = `${model.provider}/${model.id}`;
    const value = { provider: model.provider, id: model.id, name: model.name, score };
    const existing = deduplicated.get(key);
    if (!existing || value.score > existing.score) deduplicated.set(key, value);
  }

  return [...deduplicated.values()]
    .filter((candidate) => candidate.score >= 35)
    .sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Exact id match, then suffix match. Never fuzzy — fuzzy is suggestion-only. */
function lookupBuiltin(id: string): Model<Api> | undefined {
  const { byId, bySuffix } = getBuiltinIndex();
  const exact = byId.get(id);
  if (exact && exact.length > 0) return pickBest(exact);
  const slash = id.lastIndexOf("/");
  if (slash >= 0) {
    const suffix = bySuffix.get(id.slice(slash + 1));
    if (suffix && suffix.length > 0) return pickBest(suffix);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

/** Embedding/reranker models are not chat models — never register them. */
function isEmbeddingModel(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    /(^|[/:._-])(embed|embedding|bge|gte|e5|rerank)([/:._-]|$)/u.test(normalized) ||
    normalized.includes("nomic-embed")
  );
}

interface MappedModel {
  model: Model<Api>;
  source: string; // "builtin:provider/id" | "gateway"
}

function mapGatewayModel(
  gateway: GatewayConfig,
  id: string,
  entry: RawEntry,
  info: RawEntry | undefined,
  api: GatewayApi,
  inferenceBaseUrl: string,
): MappedModel | null {
  if (isEmbeddingModel(id)) return null;
  if (gateway.excludedModels?.includes(id)) return null;

  const builtin = lookupBuiltin(id);
  const architecture = asRecord(entry.architecture);
  const topProvider = asRecord(entry.top_provider);
  const supportedParams = Array.isArray(entry.supported_parameters)
    ? (entry.supported_parameters as unknown[]).filter((p): p is string => typeof p === "string")
    : [];

  const inputModalities = Array.isArray(architecture?.input_modalities)
    ? (architecture!.input_modalities as unknown[]).filter((m): m is string => typeof m === "string")
    : undefined;
  const infoInput = Array.isArray(info?.input)
    ? (info!.input as unknown[]).filter((m): m is string => typeof m === "string")
    : undefined;

  const supportsVision =
    inputModalities?.includes("image") === true ||
    info?.supports_vision === true ||
    infoInput?.includes("image") === true ||
    (builtin ? builtin.input.includes("image") : false);

  const supportsReasoning =
    entry.supports_reasoning === true ||
    info?.supports_reasoning === true ||
    supportedParams.includes("reasoning") ||
    supportedParams.includes("include_reasoning") ||
    (builtin?.reasoning ?? false);

  const contextWindow =
    asNumber(entry.context_length) ??
    asNumber(entry.context_window) ??
    asNumber(entry.max_input_tokens) ??
    asNumber(info?.max_input_tokens) ??
    builtin?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW;

  let maxTokens =
    asNumber(topProvider?.max_completion_tokens) ??
    asNumber(entry.max_output_tokens) ??
    asNumber(entry.max_completion_tokens) ??
    asNumber(info?.max_output_tokens) ??
    builtin?.maxTokens ??
    DEFAULT_MAX_TOKENS;
  maxTokens = Math.min(maxTokens, contextWindow);

  // Cost: OpenRouter-style `pricing` (per million, as strings) → LiteLLM
  // `*_cost_per_token` (per token) → built-in catalog → zero.
  const pricing = asRecord(entry.pricing);
  let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (pricing && (asNumber(pricing.prompt) !== undefined || asNumber(pricing.completion) !== undefined)) {
    cost = {
      input: asNumber(pricing.prompt) ?? 0,
      output: asNumber(pricing.completion) ?? 0,
      cacheRead: asNumber(pricing.input_cache_read) ?? 0,
      cacheWrite: asNumber(pricing.input_cache_write) ?? 0,
    };
  } else {
    const inputPerToken = asNumber(entry.input_cost_per_token) ?? asNumber(info?.input_cost_per_token);
    const outputPerToken = asNumber(entry.output_cost_per_token) ?? asNumber(info?.output_cost_per_token);
    if (inputPerToken !== undefined || outputPerToken !== undefined) {
      cost = {
        input: (inputPerToken ?? 0) * 1_000_000,
        output: (outputPerToken ?? 0) * 1_000_000,
        cacheRead: (asNumber(entry.cache_read_input_token_cost) ?? asNumber(info?.cache_read_input_token_cost) ?? 0) * 1_000_000,
        cacheWrite: (asNumber(entry.cache_creation_input_token_cost) ?? asNumber(info?.cache_creation_input_token_cost) ?? 0) * 1_000_000,
      };
    } else if (builtin) {
      cost = { ...builtin.cost };
    }
  }

  const name =
    asString(entry.name) ??
    asString(info?.yaml_name) ??
    asString(entry.model_name && entry.model_name !== id ? entry.model_name : undefined) ??
    builtin?.name ??
    id;

  const model: Model<Api> = {
    id,
    name,
    api,
    provider: gateway.id,
    baseUrl: inferenceBaseUrl,
    reasoning: supportsReasoning,
    input: supportsVision ? ["text", "image"] : ["text"],
    cost,
    contextWindow,
    maxTokens,
  };

  // Inherit thinking levels and compat flags from the matched catalog entry.
  if (builtin) {
    if (builtin.thinkingLevelMap) model.thinkingLevelMap = builtin.thinkingLevelMap;
    if (builtin.compat) model.compat = builtin.compat;
  }

  return {
    model,
    source: builtin ? `builtin:${builtin.provider}/${builtin.id}` : "gateway",
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function discoverGateway(
  gateway: GatewayConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<GatewayDiscoveryResult> {
  const api: GatewayApi = gateway.api ?? "openai-completions";
  const headers: Record<string, string> =
    api === "anthropic-messages"
      ? { accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey }
      : { accept: "application/json", authorization: `Bearer ${apiKey}` };

  const { entries, inferenceBaseUrl } = await fetchModelList(gateway.baseUrl, headers, signal);

  // LiteLLM enrichment + health counts (parallel, best-effort).
  const [infoMap, healthCounts] = await Promise.all([
    fetchLiteLLMInfo(gateway.baseUrl, headers, signal).catch(() => null),
    fetchLiteLLMHealthCounts(gateway.baseUrl, headers, signal).catch(() => null),
  ]);

  const models: Model<Api>[] = [];
  const matched: ModelMatch[] = [];
  const unmatched: GatewayDiscoveryStatus["unmatched"] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const id = asString(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const info = infoMap?.get(id);
    const mapped = mapGatewayModel(gateway, id, entry, info, api, inferenceBaseUrl);
    if (!mapped) continue;

    models.push(mapped.model);
    if (mapped.source === "gateway") {
      unmatched.push({ id, candidates: suggestBuiltinCandidates(id) });
    } else {
      matched.push({ id, source: mapped.source });
    }
  }

  return {
    models,
    status: {
      modelCount: models.length,
      matched,
      unmatched,
      inferenceBaseUrl,
      ...(healthCounts ? { healthyEndpoints: healthCounts.healthy, unhealthyEndpoints: healthCounts.unhealthy } : {}),
      litellmEnriched: (infoMap?.size ?? 0) > 0,
    },
  };
}
