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
    match: /^gpt-5\.[2-9]-pro/u,
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

/**
 * Ids a pattern should be tested against.
 *
 * Gateways routinely namespace model ids (`yoda/mistral-medium-3.5`,
 * `openai/gpt-5.5-pro`). A table anchored on the bare model name would
 * silently never fire on those lanes — it looks like "no quirk applies" rather
 * than a matching bug — so every rule tests both the full id and the segment
 * after the last slash.
 */
function idCandidates(id: string): string[] {
  const normalized = id.toLowerCase();
  const bare = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  return bare === normalized ? [normalized] : [normalized, bare];
}

/** Returns the reason string when the id names a non-chat / unusable model. */
export function unusableModelReason(id: string): string | undefined {
  const candidates = idCandidates(id);
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
export function resolveQuirk(id: string): ResolvedQuirk | undefined {
  const candidates = idCandidates(id);
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
