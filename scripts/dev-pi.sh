#!/usr/bin/env bash
# Run pi against THIS checkout's extension only, in a sandboxed agent dir.
#
# Isolation guarantees:
#   * PI_CODING_AGENT_DIR -> .dev/agent  (own gateway-discovery.json / auth.json /
#     models-store.json / settings.json; the real ~/.pi/agent is never written)
#   * .dev/agent/settings.json lists no packages, so the pi-installed copy of
#     this extension is NOT loaded -> no duplicate provider registration.
#   * The extension is loaded from ./src/index.ts via `pi -e`.
#   * YODA_API_KEY is read from the real auth.json at launch and only ever
#     placed in the environment; it is never copied into a file or printed.
#
# Usage:
#   ./scripts/dev-pi.sh [--fresh] [pi args...]
#   ./scripts/dev-pi.sh --fresh -p "hello" --model yoda-gemini/gemini-3.7-flash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$HERE/.dev/agent"
REAL_AUTH="$HOME/.pi/agent/auth.json"

if [ ! -d "$HERE/node_modules/@earendil-works" ]; then
  echo "dev-pi: node_modules not linked yet; running link-deps.sh" >&2
  "$HERE/scripts/link-deps.sh" >&2
fi

# --fresh: drop the derived catalog cache so discovery definitely re-runs.
if [ "${1:-}" = "--fresh" ]; then
  rm -f "$SANDBOX/models-store.json" "$SANDBOX/gateway-discovery-meta.json"
  shift
fi

# Supply the gateway key from the real credential store, without materialising
# a second secret file. Override by exporting YODA_API_KEY yourself first.
if [ -z "${YODA_API_KEY:-}" ] && [ -r "$REAL_AUTH" ]; then
  YODA_API_KEY="$("$HERE/scripts/read-yoda-key.sh" "$REAL_AUTH")"
  export YODA_API_KEY
  if [ -n "$YODA_API_KEY" ]; then
    echo "dev-pi: YODA_API_KEY loaded from $REAL_AUTH" >&2
  else
    echo "dev-pi: warning - could not read a key from $REAL_AUTH" >&2
  fi
fi

exec env PI_CODING_AGENT_DIR="$SANDBOX" pi -e "$HERE/src/index.ts" "$@"
