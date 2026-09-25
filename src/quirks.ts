import type { GatewayApi } from "./config.ts";

/**
 * Curated per-family API quirks.
 *
 * Why this exists rather than live probing: the entries below were each
 * established empirically once, against a real backend, and are stable for as
 * long as the vendor keeps its API shape. Re-deriving them with a request per
 * model per level costs ~6 requests/model on every discovery run, is rate-limit
 * and quota hostile, and can bill for a completion just to learn a parameter
 * name. Encoding the knowledge once keeps discovery offline and deterministic.
 *
 * Precedence (most specific wins, matching how compat/overrides already layer):
 *
 *   defaults  <  quirks  <  gateway.compat / gateway.api  <  modelOverrides
 *
 * i.e. a quirk never overrides something the user wrote down explicitly.
 */
export interface ModelQuirk {
  /** Matched against the discovered model id, case-insensitively. */
  match: RegExp;
  /** Route to a different protocol. Only applied when `gateway.api` is unset. */
  api?: GatewayApi;
  /** Replace the thinking-level vocabulary. `null` marks a level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
  /** Human explanation, surfaced by verbose discovery / doctor. */
  note: string;
}

/**
 * Models that refuse `tools` together with `reasoning_effort` on
 * `/chat/completions`, or that exist only on `/responses`.
 *
 * Every alternative is anchored to an OpenAI model-name prefix. A pattern
 * keyed on a bare suffix such as `-pro$` looks harmless until it silently
 * rewrites `gemini-2.5-pro` on an unrelated lane and 404s it — a quirk table
 * is only safe if each rule can name the vendor family it belongs to.
 */
const NEEDS_RESPONSES =
  /^(?:gpt-5\.(?:3-codex|4|5|6)|gpt-6|gpt-.*-pro|o\d[\d.]*-pro)/u;

const LEVELS_NONE_HIGH = { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };

export const MODEL_QUIRKS: readonly ModelQuirk[] = [
  {
    match: NEEDS_RESPONSES,
    api: "openai-responses",
    note: "refuses tools + reasoning_effort on /chat/completions; /responses only",
  },
  {
    // `gpt-5-pro` is the only pro tier that cannot do medium/xhigh.
    match: /^gpt-5-pro(?:-20\d{2}-\d{2}-\d{2})?$/u,
    api: "openai-responses",
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
    note: "pro tier: reasoning cannot be disabled and only 'high' is a valid level",
  },
  {
    match: /^gpt-5\.(?:[2-9]|\d{2,})-pro/u,
    api: "openai-responses",
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: null },
    note: "pro tier: 'low' is rejected, minimum effort is 'medium'",
  },
  {
    // Legacy o-series pro tiers: reasoning cannot be disabled AND `minimal` is
    // not a level, so `off` must map to null (which excludes it, letting pi
    // clamp to `low`) rather than being left absent — pi core's /responses
    // client would otherwise emit `reasoning: {effort: "none"}` and 400.
    //
    // Note the contrast with gpt-5.4+/gpt-6, which *do* accept "none":
    // stamping off:null there is a regression, because pi then clamps a
    // user's "off" up to `minimal`, which those models reject.
    match: /^o\d[\d.]*-pro/u,
    api: "openai-responses",
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    note: "o-series pro tier: no 'none' and no 'minimal'; levels are low|medium|high",
  },
  {
    // Mistral's own API exposes two reasoning settings, not the OpenAI six.
    match: /^(magistral-|mistral-(medium|small)|mistral-vibe-cli)/u,
    thinkingLevelMap: LEVELS_NONE_HIGH,
    note: "Mistral API accepts reasoning_effort none|high only",
  },
  {
    // ZAI GLM fronted by a Mistral-style lane: a third, different vocabulary,
    // and omitting the parameter entirely is valid.
    //
    // Measured on this deployment, `glm-5-2` accepts every level while
    // `zai-glm-5`, `zai-glm-5-3` and `zai-glm-latest` accept only low|high|max.
    // Those are two different checkpoints, and the gateway exposes each under
    // several aliases that all resolve to one `name`. A family prefix alone is
    // therefore not enough: without the lookahead, `zai-glm-5-2` and its own
    // alias `glm-5-2` resolve differently while being the same backend, and the
    // more restrictive of the two wins. Keeping alias entries in agreement is
    // the property that matters — a rule that configures one backend two ways
    // is wrong regardless of which side you measure.
    match: /^zai-glm(?![-._/]5[-._]2($|[-._/]))/u,
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    note: "GLM accepts reasoning_effort low|high|max; 'off' must omit the field",
  },
  {
    // Always-thinking models: the field is not accepted at all except 'high'.
    match: /^gemma-4/u,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
    note: "gemma-4: thinking cannot be switched off; only 'high' is accepted",
  },
];

/**
 * Model ids that can never serve a chat-completion request, so registering
 * them only puts dead entries in the `/model` picker that fail on first use.
 *
 * Naming is deliberately conservative: it must not sweep up real chat models.
 * `turbo-instruct` is listed but a bare `instruct` is NOT — `llama-3-8b-instruct`
 * and friends are ordinary chat models. Likewise `search` is only matched in the
 * `search-api` / `search-preview` forms that lack function calling.
 */
const UNUSABLE_PATTERNS: Array<{ match: RegExp; reason: string }> = [
  // Not chat models at all — carried over from discovery's original filter,
  // now routed through one predicate so there is a single place to audit.
  { match: /(^|[/:._-])(embed|embedding|bge|gte|e5|rerank)([/:._-]|$)/u, reason: "embedding / reranker model" },
  { match: /nomic-embed/u, reason: "embedding model" },
  { match: /(^|[/:._-])(tts|whisper|transcribe|speech|audio)([/:._-]|$)/u, reason: "audio / speech model" },
  { match: /(^|[/:._-])(moderation|ocr|image|dall-e|davinci|babbage|sora)([/:._-]|$)/u, reason: "moderation, OCR, or image/video model" },
  { match: /(^|[/:._-])(veo|lyria|robotics|live)([/:._-]|$)/u, reason: "generation/live model (video, music, teleop)" },
  // Chat-shaped but unusable through a chat-completions client.
  { match: /(^|[/:._-])realtime([/:._-]|$)/u, reason: "realtime voice/session API, not chat completions" },
  { match: /(^|[/:._-])computer-use([/:._-]|$)/u, reason: "requires the vendor Computer Use tool" },
  { match: /(^|[/:._-])(search-api|search-preview)([/:._-]|$)/u, reason: "no function calling; unusable as an agent model" },
  { match: /(^|[/:._-])deep-research([/:._-]|$)/u, reason: "deep-research route, deprecated or not chat-capable" },
  { match: /(^|[/:._-])turbo-instruct([/:._-]|$)/u, reason: "legacy /completions-only base model" },
  { match: /(^|[/:._-])voxtral([/:._-]|$)/u, reason: "audio transcription model" },
  { match: /(^|[/:._-])omni([/:._-]|$)/u, reason: "Interactions-API-only multimodal model" },
  { match: /(^|[/:._-])antigravity([/:._-]|$)/u, reason: "function calling not enabled for this route" },
  { match: /(^|[/:._-])aqa([/:._-]|$)/u, reason: "answer-quality-assessment route, retired" },
];

/**
 * Ids a pattern should be tested against.
 *
 * Gateways routinely namespace model ids (`acme/mistral-medium-3.5`,
 * `vendor/gpt-5.5-pro`). A table anchored on the bare model name would
 * silently never fire on those lanes — it looks like "no quirk applies" rather
 * than a matching bug — so every rule tests both the full id and the segment
 * after the last slash.
 */
function idCandidates(id: string, ...extraNames: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of [id, ...extraNames]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.toLowerCase().trim();
    out.add(normalized);
    // Gateways namespace ids (`acme/gpt-5.5-pro`); a rule anchored on the bare
    // model name would silently never fire on those lanes.
    if (normalized.includes("/")) out.add(normalized.slice(normalized.lastIndexOf("/") + 1));
    // Mistral-style gateways also expose the same model under several ids via
    // `aliases`, all pointing at one `name`. Matching the name keeps alias
    // entries configured identically instead of half the aliases getting a
    // vocabulary and half not.
    if (normalized.startsWith("models/")) out.add(normalized.slice("models/".length));
  }
  return [...out];
}

/** Returns the reason string when the id names a non-chat / unusable model. */
export function unusableModelReason(id: string, ...extraNames: Array<string | undefined>): string | undefined {
  const candidates = idCandidates(id, ...extraNames);
  return UNUSABLE_PATTERNS.find((p) => candidates.some((c) => p.match.test(c)))?.reason;
}

export interface ResolvedQuirk {
  api?: GatewayApi;
  thinkingLevelMap?: Record<string, string | null>;
  notes: string[];
}

/**
 * Merge *every* matching quirk, later table entries winning per field.
 *
 * Returning only the first match is a trap: the broad "needs /responses"
 * rule necessarily precedes the narrow "this pro tier only accepts high"
 * rule, so first-match-wins lets the broad one claim the model and the
 * narrow one's vocabulary never applies — which surfaces as an unrelated
 * 400 about `reasoning_effort`, not as a table bug.
 */
export function resolveQuirk(id: string, ...extraNames: Array<string | undefined>): ResolvedQuirk | undefined {
  const candidates = idCandidates(id, ...extraNames);
  const matched = MODEL_QUIRKS.filter((q) => candidates.some((c) => q.match.test(c)));
  if (matched.length === 0) return undefined;

  const resolved: ResolvedQuirk = { notes: [] };
  for (const q of matched) {
    if (q.api) resolved.api = q.api;
    if (q.thinkingLevelMap) {
      resolved.thinkingLevelMap = { ...resolved.thinkingLevelMap, ...q.thinkingLevelMap };
    }
    resolved.notes.push(q.note);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Upstream-declared metadata
//
// Read from the raw `/models` entry. Where an upstream states a fact about a
// model, that statement beats any name-based guess below: it is authoritative,
// free (already in the payload), and it cannot rot when the vendor changes a
// checkpoint.
// ---------------------------------------------------------------------------

/** Minimal structural view of a raw `/models` entry, to stay import-light. */
export type RawEntryLike = Record<string, unknown>;

function asRecordLike(value: unknown): RawEntryLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawEntryLike)
    : undefined;
}

/**
 * Effort vocabulary declared by the model list itself.
 *
 * vLLM / InferHub-style upstreams publish `reasoning.supported_efforts`. When
 * present it is authoritative and must beat every name-based guess, because
 * the vocabulary is a property of *this served checkpoint on this backend*
 * rather than of the model family: the same `mistral-medium` name answers
 * `none|high` on one deployment and the full OpenAI set on another. It is
 * also free — the field is already in the payload we fetched.
 *
 * Not universal: on this gateway only one lane's entries carry it, so the
 * quirk table remains the fallback where the upstream says nothing.
 */
export function declaredThinkingLevelMap(entry: RawEntryLike): Record<string, string | null> | undefined {
  const reasoning = asRecordLike(entry.reasoning);
  const raw = reasoning?.supported_efforts;
  if (!Array.isArray(raw)) return undefined;
  const supported = new Set(
    raw.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()),
  );
  if (supported.size === 0) return undefined;

  const map: Record<string, string | null> = {};
  // "off" is only honoured when the backend accepts an explicit "none"; a null
  // here makes pi clamp a user's "off" to the cheapest real level instead of
  // sending a value the backend rejects.
  map.off = supported.has("none") ? "none" : null;
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}

/**
 * A model the upstream has already switched off.
 *
 * Several OpenAI-compatible `/models` payloads carry `shutdown_date`. It is
 * compared against *now* rather than treated as "has a shutdown date": a
 * scheduled future retirement is a warning, not grounds for hiding a working
 * model (a lane here lists `o3-mini` with a future date and it serves fine).
 *
 * Preferred to a hard-coded list of retired ids, which rots the moment the
 * vendor retires another one — and free, since the field is already in the
 * list we fetched. Not complete on its own: some retired ids ship a null
 * `shutdown_date`, which is why the name-based capability table is retained
 * alongside it.
 */
/**
 * Vendor names for "this model has been switched off", and the shapes seen:
 *
 *   OpenAI-compatible  `shutdown_date`: "2026-07-23" | null
 *   Mistral            `deprecation`: "..." | { ... } | null
 *                      `deprecation_replacement_model`: "mistral-large-2512" | null
 *   Google (native)    `ttlExpirationTime`: RFC3339 | absent
 *
 * A date in the FUTURE is a scheduled retirement, not a dead model, so it is
 * compared against `now` rather than merely tested for presence — `o3-mini`
 * carries a future `shutdown_date` and serves fine. A truthy value that is not
 * a recognisable date is treated as retired: the vendor said so, and no
 * concrete retirement was announced.
 */
const RETIREMENT_FIELDS = [
  "shutdown_date",
  "deprecation",
  "ttlExpirationTime",
  "deprecation_date",
  "retirement_date",
] as const;

function retirementValue(entry: RawEntryLike): { raw: unknown; field: string } | undefined {
  const sources: RawEntryLike[] = [entry, asRecordLike(entry.capabilities) ?? {}];
  for (const source of sources) {
    for (const field of RETIREMENT_FIELDS) {
      if (source[field] !== undefined && source[field] !== null) return { raw: source[field], field };
    }
  }
  return undefined;
}

export function retiredModelReason(entry: RawEntryLike, now: number = Date.now()): string | undefined {
  const found = retirementValue(entry);
  if (!found) return undefined;
  const { raw, field } = found;

  const replacement =
    typeof entry.deprecation_replacement_model === "string" && entry.deprecation_replacement_model
      ? entry.deprecation_replacement_model
      : undefined;
  const suffix = replacement ? ` — use ${replacement} instead` : "";

  if (typeof raw === "boolean") {
    return raw ? `retired (${field})${suffix}` : undefined;
  }
  const at = typeof raw === "number" ? raw : Date.parse(String(raw));
  if (!Number.isFinite(at)) {
    // Present but unreadable: still a deprecation statement from the vendor.
    return `retired (${field}: ${JSON.stringify(raw)})${suffix}`;
  }
  return at <= now ? `retired — ${field} ${String(raw)}${suffix}` : undefined;
}

// ---------------------------------------------------------------------------
// Google native model metadata
// ---------------------------------------------------------------------------

/**
 * Fields from Google's *native* `GET {base}/models`, which the OpenAI-compatible
 * shim does not surface at all. The shim's entries carry only
 * `id/object/owned_by/display_name`, so anything pi does not already know from
 * its built-in catalog falls back to the 32K/8K defaults — on a lane whose real
 * windows are 1M/65K.
 *
 * Reachable with the same key via `x-goog-api-key`, and authoritative for the
 * checkpoint actually being served.
 */
export interface GoogleNativeMetadata {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
  supportedGenerationMethods?: string[];
  ttlExpirationTime?: string;
}

export interface GoogleNativePatch {
  contextWindow?: number;
  maxTokens?: number;
  /** Only set when the native list states it; absence must not clear a flag. */
  reasoning?: boolean;
  name?: string;
  unusableReason?: string;
}

/**
 * Translate one native entry into catalog fields.
 *
 * `inputTokenLimit` is used as the context window: Gemini bills input and
 * output against one budget, so the input limit is the conservative reading
 * and never overstates the window — which is the failure that actually hurts,
 * since pi sizes compaction and output reservations from it.
 *
 * `supportedGenerationMethods` replaces name-based guessing where it exists:
 * a model exposing only `generateAnswer` (e.g. `aqa`) is not a chat model
 * whatever its id says. Absence of the field is not treated as capability.
 */
export function googleNativePatch(entry: GoogleNativeMetadata | undefined): GoogleNativePatch | undefined {
  if (!entry) return undefined;
  const patch: GoogleNativePatch = {};

  const input = typeof entry.inputTokenLimit === "number" ? entry.inputTokenLimit : undefined;
  const output = typeof entry.outputTokenLimit === "number" ? entry.outputTokenLimit : undefined;
  if (input !== undefined) patch.contextWindow = input;
  if (output !== undefined) patch.maxTokens = output;

  if (typeof entry.thinking === "boolean") patch.reasoning = entry.thinking;
  if (typeof entry.displayName === "string" && entry.displayName.trim()) patch.name = entry.displayName.trim();

  const methods = Array.isArray(entry.supportedGenerationMethods)
    ? entry.supportedGenerationMethods.filter((m): m is string => typeof m === "string")
    : undefined;
  if (methods && methods.length > 0 && !methods.includes("generateContent")) {
    patch.unusableReason = `Google lists no generateContent for this model (methods: ${methods.join(", ") || "none"})`;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Index a native `models[]` array by bare name, stripping Google's prefix. */
export function indexGoogleNativeModels(entries: unknown): Map<string, GoogleNativeMetadata> {
  const out = new Map<string, GoogleNativeMetadata>();
  if (!Array.isArray(entries)) return out;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as GoogleNativeMetadata;
    if (typeof entry.name !== "string" || !entry.name) continue;
    out.set(entry.name.replace(/^models\//u, ""), entry);
  }
  return out;
}
