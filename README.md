# pi-gateway-discovery

Dynamic model discovery for Pi: point it at an OpenAI-compatible or LiteLLM
API gateway and it auto-discovers, enriches, and registers the gateway's
models as a native pi provider — no hand-written model JSON.

## What it does

For each configured gateway the extension:

1. **Lists models, and negotiates the lane's protocol** — probes
   `GET {base}/models`, then `GET {base}/v1/models`, trying the OpenAI auth
   style first and falling back to the Anthropic style (`x-api-key` +
   `anthropic-version`). The endpoint that answers also determines the
   inference base URL. This is what makes an Anthropic-shaped lane register at
   all: with `api` defaulting to `openai-completions` it otherwise yields zero
   models and a fetch error that does not mention the real cause.
2. **Enriches metadata (LiteLLM gateways)** — merges `GET /v1/model/info`
   (or, when that returns an empty list, `GET /health` → per-endpoint
   `GET /model/info?litellm_model_id=...`) for context lengths, modalities,
   reasoning/vision flags, costs, and descriptions. Sensitive
   `litellm_params` (api keys, api_base, …) are stripped before use.
3. **Matches pi's built-in catalog** — unknown model ids are matched exactly
   (then by id suffix) against pi's built-in model catalog, so well-known
   models served through a gateway keep their real name, context window,
   costs, and thinking-level map. Fuzzy candidates are *suggested* in status
   output for human confirmation, never auto-applied. Google-style resource
   prefixes (`models/gemini-2.5-flash`) are normalized to the bare model name,
   which the OpenAI-compatible layer accepts in requests.
4. **Composes each model's settings** from gateway-safe defaults, any
   upstream-declared metadata, and the curated quirk table — so strict
   backends are not sent parameters they reject, and per-family
   `reasoning_effort` vocabularies are correct without hand-written config.
   See [How models get configured automatically](#how-models-get-configured-automatically).
5. **Registers with pi** via `createProvider` + `fetchModels`. Pi owns the
   model cache (`models-store.json`) and the refresh lifecycle; the catalog
   is restored from cache on startup even when the gateway is offline.

Each model gets: context window, max output tokens, input modalities
(text/image), reasoning flag, cost (OpenRouter-style `pricing`, LiteLLM
`*_cost_per_token`, built-in catalog, or zero), and — when matched — the
built-in `thinkingLevelMap` and `compat` flags. Metadata is read from
OpenAI-style fields (`context_length`, `architecture`, `supported_parameters`),
Mistral-style fields (`max_context_length`, `capabilities`), Anthropic-style
fields (`display_name`, `max_input_tokens`, `max_tokens`), and LiteLLM
`/model/info` enrichment.

Models that can never serve a chat request are never registered: non-chat
families (embeddings, TTS, transcription, moderation, OCR, image/video/music
generation, live/robotics), vendor-namespaced equivalents, ids whose
`shutdown_date` is already in the past, and families that lack function calling
(realtime, computer-use, search-only). Each drop is reported with its reason,
and `excludeUnusable: false` opts out entirely.

## Security model

- **API keys never live in the config file** (`~/.pi/agent/gateway-discovery.json`).
  They are stored by pi's `/login` in `auth.json` (0600) or read from an
  ambient env var (`apiKeyEnv`).
- The `gateways` tool never **returns** a key in a tool result, so key material
  cannot leak into the model's context or the session transcript that way.
  Two operations do touch keys, both explicitly requested:
  - `add` / `/gw add` accepts `apiToken`, which is written straight to
    `auth.json`. Passing it on the command line means it is visible in the
    session log and shell history — prefer `/login <id>`, which prompts masked
    (`ctx.ui.input` has no secret mode; only the login interaction does).
  - `/gw export --keys` embeds stored keys in the bundle for a private
    migration. It is off by default, the file is written `0600`, and the result
    warns that the file is now a secret. A plain `/gw export` contains no key
    material and is safe to share or commit.
- Config, model cache, and discovery metadata are written atomically with
  `0600` permissions.

Persisted under the agent dir:

| File | Contents | Secret? |
|---|---|---|
| `gateway-discovery.json` | gateways, `api`, `compat`, `modelOverrides`, exclusions | no |
| `auth.json` | pi's provider credentials (shared with built-in providers) | **yes** |
| `models-store.json` | the discovered model cache (owned by pi) | no |
| `gateway-discovery-meta.json` | per-gateway discovery record: what was auto-configured and by which layer, what was filtered as unusable, and which quirks were suppressed by an explicit `api`. Read-only reporting aid, so `describe`/`doctor` can explain provenance in a session that did not run discovery. | no |

## Installation

```sh
pi install /path/to/pi-gateway-discovery
# or, once published: pi install npm:pi-gateway-discovery
```

## Usage

```
/gw add <baseUrl> [id] [token] [api=…] [direct=true|false]
                          Register a gateway (prompts for anything missing)
/gw remove <id>           Remove a gateway, its credential, and its model cache
/gw sync [id]             Force a model-list refresh (all gateways if no id)
/gw list                  Show gateways, effective protocol, and last sync status
/gw describe <id> [model] Show the *effective* config and which layer set each value
/gw override <id> <model> [k=v … | clear]
/gw export [path] [--keys] [--force]
                          Write a portable bundle (default: no API keys)
/gw import <path> [--replace]
                          Restore gateways on another machine (default: merge by id)
```

After `/gw add`, pi tells you to run `/login <id>` — enter the API key in
the secret prompt (it is stored in `auth.json`, never in chat or config).
The gateway's models then appear as `<id>/<model-id>`, e.g.
`openai/gpt-4-turbo`.

The AI can drive the same operations through the `gateways` tool
(`add` / `remove` / `sync` / `list` / `describe` / `override` / `export` /
`import`).

`api` only needs setting when you want to override the protocol discovery
negotiates — see [Protocol negotiation](#protocol-negotiation). Prefer leaving
it unset. Passing `token` on the command line stores it, but it is then visible
in the session log and your shell history; `/login <id>` prompts for it masked.

### Example: the OpenAI gateway

```sh
/gw add https://api.openai.com/v1
/login openai
/gw list
```

```sh
openai (openai-completions) https://api.openai.com/v1
  15 models, 15 matched, 0 unmatched (just now)
```

If a gateway exposes its OpenAI-compatible interface under a subpath (e.g.
`.../gemini/v1beta/openai`), just include the subpath in the base URL —
discovery probes `{base}/models` and `{base}/v1/models` and uses whichever
answers as the inference base.

> [!NOTE]
> Gateway ids that match a pi built-in provider (`openai`, `anthropic`,
> `mistral`, `gemini`, …) **override** that built-in provider for the whole
> session. Use distinct ids (e.g. `openai-custom`) when you want to keep the
> built-in catalog alongside the gateway.
>
> `pi --list-models` shows the **cached** catalog (no network fetch). The
> first interactive session (or `/gw sync`) performs the live discovery and
> caches it in `models-store.json`.

## Configuration

`~/.pi/agent/gateway-discovery.json` (created by `/gw add`):

```json
{
  "version": 1,
  "autoRefreshTtlHours": 1,
  "gateways": [
    {
      "id": "openai",
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKeyEnv": "OPENAI_API_KEY",
      "compat": { "supportsStore": false },
      "modelOverrides": {
        "gpt-4o": { "api": "openai-responses" }
      },
      "excludedModels": ["some/model"],
      "directHttpStreaming": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `autoRefreshTtlHours` | Auto-refresh TTL (top-level). When a gateway's cached catalog is older than this, it is refreshed automatically — at pi load (all modes, including `pi --list-models` a[...]
| `id` | Provider id (lowercase `[a-z0-9._-]`). Doubles as the `/login` credential key. |
| `name` | Display name. |
| `baseUrl` | Gateway base URL (no trailing slash). |
| `api` | `openai-completions`, `openai-responses`, or `anthropic-messages`. **Usually omit it** — see [Protocol negotiation](#protocol-negotiation). A trailing `/v1` is stripped for anthropic. |
| `apiKeyEnv` | Optional env var holding the API key (used for discovery; the stored `/login` credential wins at request time). |
| `compat` | Per-gateway compat overrides merged into every discovered model, **on top of** the strict-safe defaults (`supportsStore: false`, `supportsDeveloperRole: false`) that gateways get automatically[...]
| `modelOverrides` | Per-model overrides keyed by model id (topmost layer): `api` (route to a different protocol, e.g. `openai-responses`), `reasoning`, `contextWindow`, `maxTokens`, `thinkingLev[...]
| `excludedModels` | Model ids to never register, in addition to the automatic filter. |
| `excludeUnusable` | Set `false` to keep models the automatic filter would drop (realtime, audio, completions-only, no-function-calling families). Default `true`. The filter is reported per model, so check `/gw list` before disabling it. |
| `directHttpStreaming` | Route streaming inference requests through a `node:http`/`node:https`-backed fetch instead of the built-in `fetch` (undici). For gateways that only negotiate HTTP/1.1 — see “HTTP/1.1 streaming” below. |

## How models get configured automatically

Discovery composes each model's settings from four layers, lowest precedence
first:

1. **Gateway-safe defaults** — `supportsStore: false`,
   `supportsDeveloperRole: false`. pi core infers these from the provider name
   and base-URL host; a gateway matches no known vendor, so it would otherwise
   be assumed a standard OpenAI endpoint and have every optional parameter
   enabled. Strict backends reject the result (`store` → Gemini 400, Mistral
   422), which is the single most common reason a newly added gateway "does
   not work".
2. **Upstream-declared metadata** — if a `/models` entry publishes
   `reasoning.supported_efforts` (vLLM and similar), that vocabulary is used
   verbatim. It is authoritative, free, and describes the checkpoint actually
   being served.
3. **The quirk table** (`src/quirks.ts`) — curated per-family knowledge: which
   models refuse `tools` + `reasoning_effort` on `/chat/completions` and so
   need `/responses`, and which expose a non-standard effort vocabulary
   (Mistral's `none|high`, GLM's `low|high|max`, `*-pro` tiers, always-thinking
   `gemma-4`). Preferred over live probing, which would cost ~6 billable
   requests per model per discovery and could never run offline.
4. **Your config** — `gateway.api`, `gateway.compat`, and `modelOverrides`
   always win, so nothing here can contradict a deliberate choice.

`/gw describe <id> <model>` reports the resolved values **and** which layer
supplied them. Unusable families (embeddings, realtime, audio,
completions-only) are dropped during discovery and listed with their reason in
`/gw list` output and `gateways` tool status.

### Protocol negotiation

When `api` is unset, discovery tries the OpenAI model-list auth style first
(today's default, so the common case costs one request), then the Anthropic
style — a lane fronting `/v1/messages` needs an `anthropic-version` header, so
without a fallback it registers zero models and reports a fetch error that does
not mention the real cause.

Negotiation can only distinguish Anthropic-shaped from OpenAI-shaped lanes:
`/chat/completions` and `/responses` share an identical `/models` surface.
Choosing between those two stays a layer-2/3 decision.

## Moving a setup to another machine

`/gw export` writes one file containing every gateway, its `compat`, its
`modelOverrides`, and its exclusions. API keys are **not** included by default:

```sh
# machine A
/gw export ~/pi-gateways.json

# machine B
scp hostA:~/pi-gateways.json .
/gw import ./pi-gateways.json
/login <gatewayId>          # once per gateway that has no apiKeyEnv
```

`--keys` embeds stored credentials for a private migration — it writes them to
the bundle and warns you, since that file becomes a secret. Import merges by
gateway id (`--replace` adopts the bundle wholesale) and re-discovers only the
gateways that actually changed.

## Troubleshooting

Most failures are one of these, and the message usually names the injected
field. Note that a strict backend's error body is often *dropped* by the
OpenAI SDK (it only reads `body.error.message`, while Google returns an array
and Mistral returns `{message:{detail:[…]}}`), which is why some of these show
up as `400 status code (no body)`.

| Symptom | Cause | Fix |
|---|---|---|
| `422` / `400 Unknown name "store"` on every request | pi injects `store` for endpoints it assumes are standard | automatic since the gateway defaults; or `compat: { "supportsStore": false }` |
| `422` only on reasoning-capable models | pi sends `role: "developer"`, which several backends reject | `compat: { "supportsDeveloperRole": false }` |
| `Function tools with reasoning_effort are not supported … use /v1/responses` | model refuses tools on `/chat/completions` | `modelOverrides: { "<id>": { "api": "openai-responses" } }` |
| `This model is only supported in v1/responses` | responses-only model | same as above |
| `reasoning_effort 'low' is not supported … supported values: [none, high]` | the model's effort vocabulary differs from pi's levels | `modelOverrides: { "<id>": { "thinkingLevelMap": { … } } }` — `null` marks a level unsupported so pi clamps to one the backend accepts |
| `Unsupported value: 'none' is not supported` when thinking is off | on `/responses`, "off" becomes `effort: "none"` unless `off` is explicitly `null` | add `"off": null` to that model's `thinkingLevelMap` |
| `/models` fetch fails on an Anthropic-shaped lane | needs `anthropic-version`, not `Authorization: Bearer` | omit `api` and let negotiation find it, or set `"api": "anthropic-messages"` |
| 404 `/chat/completions` on a lane whose URL says `/anthropic` | wrong protocol registered | same as above |
| A model you expect is missing | automatic unusable filter, or `excludedModels` | `gateways list` / `/gw describe` shows the reason; set `excludeUnusable: false` to keep it |
| A model 404s with `has been deprecated` | vendor retired it after the list was built | add it to `excludedModels` (lists often still advertise it) |
| A model 403s with "an admin must enable them" | org entitlement, not a capability | leave it: another tenant may use it. Exclude per-machine if noisy |
| Edited the JSON and `sync` reported success but nothing changed | provider held the config loaded at startup | fixed — config is reconciled before every operation; a stale catalog now shows `config-changed` with a `/gw sync` hint |
| Tokens arrive all at once at the end | HTTP/1.1-only gateway buffering under `fetch` | `directHttpStreaming: true` |

## HTTP/1.1 streaming (`directHttpStreaming`)

Symptom: the gateway emits SSE events token-by-token (verify with `curl -N`),
but pi shows the whole answer at once when generation ends. Cause: the
gateway negotiates HTTP/1.1 only (no h2 ALPN), and Node's built-in fetch
(undici) buffers the entire chunked HTTP/1.1 response before handing the body
to the SSE consumer — every token delta then arrives as one lump.

With `"directHttpStreaming": true` on the gateway, the extension injects an
alternative fetch (built directly on `node:http`/`node:https`, which surface
each network chunk immediately via `IncomingMessage`) into the provider SDK
clients for that gateway's `stream` / `streamSimple` / `fetchDeferred` /
`cancelDeferred` request paths. Discovery GETs keep the global fetch (their
responses are small and fully read anyway).

Enable it per gateway:

- `/gw add <baseUrl> <id> [token] [direct=true]`
- the `gateways` tool: `action: "add"` with `directHttpStreaming: true`
- or set the field in the config file and run `/reload`

Caveats: proxy environment variables are **not** applied on this path (it is
for direct gateways), and keep-alive sockets are pooled per process. If the
gateway can serve HTTP/2, prefer fixing the ALPN — the built-in fetch streams
correctly there.

## Output-token capping

Gateways (vLLM in particular) often advertise `max_output_tokens` equal to
the full context window. That is fragile in pi: on from-scratch turns (first
turn, post-compaction) pi estimates prompt tokens as chars/4, and
tool/JSON-heavy prompts tokenize well below 4 chars/token. The underestimate
can exceed pi's internal 4096-token safety margin, so the backend rejects
the request with `input + max_output > context window` — even though the
prompt fits fine. For such models this extension caps the advertised output
at ¼ of the context window (min 2048): still a huge budget, and it keeps
any from-scratch prompt under ~75% of the window safe. Affected models are
reported in `/gw list` ("N output-capped") and in the `gateways` tool sync
status. Override per model with `modelOverrides.<id>.maxTokens` if you want
a different ceiling.

## Automatic updates

pi itself refreshes model catalogs in the background for interactive and RPC
sessions, but `pi --list-models` and `pi -p` never touch the network. This
extension closes that gap with a TTL-based auto-refresh
(`autoRefreshTtlHours`, default 1h, `0` disables):
- **On load (all modes)** — the extension factory (which pi awaits) checks
  the cached catalog age and re-discovers stale gateways *before* pi
  restores the cache, so `pi --list-models` and `pi -p` start with a fresh
  model list. A fresh cache costs nothing (no network, no delay). The
  refresh is bounded by a 15s timeout and never blocks startup on failure —
  the stale cache is used instead.
- **On `/reload`** — the factory runs again, same logic.
- **Cross-session** — each interactive/RPC session watches
  `models-store.json`; when another pi session rewrites it (its own
  auto-refresh, a `/gw sync`, …), this session re-reads the store and
  updates its in-memory registry, so running sessions pick up new models
  without a restart.
- **Long-running sessions** — a periodic check (every 5 min, unref'd) forces
  a refresh once the TTL has passed.

`PI_OFFLINE=1` disables all auto-refresh network access.

## Design notes

Patterns borrowed from the ecosystem:

- **`@danmademe/pi-provider-litellm`** — `createProvider` + `fetchModels`
  with pi-owned caching; LiteLLM `/model/info` + `/health` enrichment;
  sensitive `litellm_params` stripping.
- **`pi-relay-models`** — `/login`-only key handling, config-file schema with
  atomic 0600 writes, built-in catalog matching with fuzzy *suggestions*,
  runtime-aware credential/cache cleanup on removal, status reports.
- **`@hypabolic/crossbar`** — embedding-model filtering, conservative
  defaults for unknown metadata, honest capability flags.
- **`@robhowley/pi-openrouter`** — sync status semantics (healthy / cached /
  error, cache age, skip reasons surfaced in status).
