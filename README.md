# pi-gateway-discovery

Dynamic model discovery for Pi: point it at an OpenAI-compatible or LiteLLM
API gateway and it auto-discovers, enriches, and registers the gateway's
models as a native pi provider — no hand-written model JSON.

## What it does

For each configured gateway the extension:

1. **Lists models** — probes `GET {base}/models`, then `GET {base}/v1/models`
   (accepts `data[]`, `models[]`, or bare arrays). The endpoint that answers
   also determines the inference base URL.
2. **Enriches metadata (LiteLLM gateways)** — merges `GET /v1/model/info`
   (or, when that returns an empty list, `GET /health` → per-endpoint
   `GET /model/info?litellm_model_id=...`) for context lengths, modalities,
   reasoning/vision flags, costs, and descriptions. Sensitive
   `litellm_params` (api keys, api_base, …) are stripped before use.
3. **Matches pi's built-in catalog** — unknown model ids are matched exactly
   (then by id suffix) against pi's built-in model catalog, so well-known
   models served through a gateway keep their real name, context window,
   costs, and thinking-level map. Fuzzy candidates are *suggested* in status
   output for human confirmation, never auto-applied.
4. **Registers with pi** via `createProvider` + `fetchModels`. Pi owns the
   model cache (`models-store.json`) and the refresh lifecycle; the catalog
   is restored from cache on startup even when the gateway is offline.

Each model gets: context window, max output tokens, input modalities
(text/image), reasoning flag, cost (OpenRouter-style `pricing`, LiteLLM
`*_cost_per_token`, built-in catalog, or zero), and — when matched — the
built-in `thinkingLevelMap` and `compat` flags. Metadata is read from
OpenAI-style fields (`context_length`, `architecture`, `supported_parameters`),
Mistral-style fields (`max_context_length`, `capabilities`), Anthropic-style
fields (`display_name`, `max_input_tokens`, `max_tokens`), and LiteLLM
`/model/info` enrichment. Non-chat models (embeddings, TTS, transcription,
moderation, OCR, image/video/music generation, live/robotics) and
user-excluded ids are never registered.

## Security model

- **API keys never live in the config file** (`~/.pi/agent/gateway-discovery.json`).
  They are stored by pi's `/login` in `auth.json` (0600) or read from an
  ambient env var (`apiKeyEnv`).
- The `gateways` tool never accepts or exposes keys.
- Config files are written atomically with `0600` permissions.

## Installation

```sh
pi install /path/to/pi-gateway-discovery
# or, once published: pi install npm:pi-gateway-discovery
```

## Usage

```
/gw add <baseUrl> [id]    Register a gateway (prompts for missing values)
/gw remove <id>           Remove a gateway, its credential, and its model cache
/gw sync [id]             Force a model-list refresh (all gateways if no id)
/gw list                  Show gateways and last sync status
```

After `/gw add`, pi tells you to run `/login <id>` — enter the API key in
the secret prompt (it is stored in `auth.json`, never in chat or config).
The gateway's models then appear as `<id>/<model-id>`, e.g.
`yoda/qwen3.8-27b`.

The AI can drive the same operations through the `gateways` tool
(`add` / `remove` / `sync` / `list`).

### Example: the yoda gateway

```sh
/gw add https://yoda.teknologisk.dk/public/api-gateway/yoda
/login yoda
/gw list
```

```sh
yoda (openai-completions) https://yoda.teknologisk.dk/public/api-gateway/yoda
  1 models, 0 matched, 1 unmatched (just now)
```

If a gateway exposes its OpenAI-compatible interface under a subpath (e.g.
`.../gemini/v1beta/openai`), just include the subpath in the base URL —
discovery probes `{base}/models` and `{base}/v1/models` and uses whichever
answers as the inference base.

## Configuration

`~/.pi/agent/gateway-discovery.json` (created by `/gw add`):

```json
{
  "version": 1,
  "gateways": [
    {
      "id": "yoda",
      "name": "Yoda",
      "baseUrl": "https://yoda.teknologisk.dk/public/api-gateway/yoda",
      "api": "openai-completions",
      "apiKeyEnv": "YODA_API_KEY",
      "excludedModels": ["some/model"]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Provider id (lowercase `[a-z0-9._-]`). Doubles as the `/login` credential key. |
| `name` | Display name. |
| `baseUrl` | Gateway base URL (no trailing slash). |
| `api` | `openai-completions` (default), `openai-responses`, or `anthropic-messages`. A trailing `/v1` is stripped for anthropic. |
| `apiKeyEnv` | Optional env var holding the API key (checked before the stored credential… actually the stored credential wins at request time; the env var is checked first in discovery). |
| `excludedModels` | Model ids to never register. |

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
