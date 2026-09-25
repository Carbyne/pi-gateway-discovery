#!/usr/bin/env bash
# Print the first API key found in a pi auth.json, for use as GATEWAY_API_KEY
# in dev/test runs. Keeps the secret in the environment only — it is never
# copied into a sandbox file, so a test cannot leave a second credential behind.
#
# Usage:  export GATEWAY_API_KEY="$(scripts/read-gateway-key.sh)"
set -u
python3 - "${1:-$HOME/.pi/agent/auth.json}" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(0)
for entry in data.values():
    if isinstance(entry, dict) and isinstance(entry.get("key"), str) and entry["key"]:
        sys.stdout.write(entry["key"])
        break
PY
