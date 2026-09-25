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
 * `/chat/completions`, or that exist only on `/responses`. The gateway says so
 * explicitly ("... use /v1/responses"), but that is a runtime error you only
 * meet on first use — and a lane-wide `api` switch is the wrong fix when older
 * models on the same lane have no `/responses` equivalent.
 */
const NEEDS_RESPONSES = /^gpt-5\.(3-codex|4|5|6)|^gpt-6|^gpt-5-pro$|^o[13]-pro$|-pro(?:-20\d{2}-\d{2}-\d{2})?$/u;

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
    match: /^gpt-5\.[2-9]-pro/u,
    api: "openai-responses",
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: null },
    note: "pro tier: 'low' is rejected, minimum effort is 'medium'",
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
    match: /^zai-glm/u,
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

/** Returns the reason string when the id names a non-chat / unusable model. */
export function unusableModelReason(id: string): string | undefined {
  const normalized = id.toLowerCase();
  return UNUSABLE_PATTERNS.find((p) => p.match.test(normalized))?.reason;
}

/** First matching quirk for a model id, or undefined. */
export function findQuirk(id: string): ModelQuirk | undefined {
  const normalized = id.toLowerCase();
  return MODEL_QUIRKS.find((q) => q.match.test(normalized));
}
