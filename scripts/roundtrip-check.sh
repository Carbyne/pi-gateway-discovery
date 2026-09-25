#!/usr/bin/env bash
# Prove a bundle built from the LIVE tuned config round-trips through the real
# importer into a throwaway agent dir. Never writes to ~/.pi/agent.
#
#   bash scripts/roundtrip-check.sh [bundle-path]
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HERE="$(pwd)"
SRC_LIVE="$HOME/.pi/agent/gateway-discovery.json"
SANDBOX_CFG="$HERE/.dev/agent/gateway-discovery.json"
BUNDLE="${1:-$HOME/pi-gateways.tuned.json}"
RT=/tmp/rt

export YODA_API_KEY="${YODA_API_KEY:-$("$HERE/scripts/read-yoda-key.sh")}"
if [ -z "$YODA_API_KEY" ]; then
  echo "no API key available to drive the test session" >&2
  exit 1
fi

python3 - "$SRC_LIVE" "$BUNDLE" <<'PY'
import json, os, sys, datetime
src, out = sys.argv[1], sys.argv[2]
live = json.load(open(src))
json.dump(
    {
        "bundleVersion": 1,
        "generatedBy": "roundtrip-check",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "config": live,
    },
    open(out, "w"),
    indent=2,
)
os.chmod(out, 0o600)
print(f"built {out} from live config ({len(live['gateways'])} gateways)")
PY

# Uses bare `pi`, NOT scripts/dev-pi.sh: dev-pi ends with
#   exec env PI_CODING_AGENT_DIR="$SANDBOX" pi ...
# and an `env VAR=` prefix overrides whatever the caller exported. An earlier
# version of this test routed through dev-pi, so its "throwaway" import landed
# in the dev sandbox and corrupted a fixture while the assertions still passed.
#
# Isolation is asserted, not assumed: fingerprint everything that must not move.
GUARD="$(mktemp)"
for f in "$SRC_LIVE" "$SANDBOX_CFG"; do
  [ -f "$f" ] && md5sum "$f" >>"$GUARD"
done

rm -rf "$RT"
mkdir -p "$RT/agent"

python3 - "$RT" <<'PY'
import json, sys
rt = sys.argv[1]
# Seed one lane that authenticates from the environment so the driving `pi -p`
# has a usable model; mode=replace discards it, which is the point.
json.dump(
    {
        "version": 1,
        "gateways": [
            {
                "id": "yoda-kyber",
                "name": "Yoda",
                "baseUrl": "https://yoda.teknologisk.dk/public/api-gateway/yoda/v1",
                "apiKeyEnv": "YODA_API_KEY",
            }
        ],
    },
    open(f"{rt}/agent/gateway-discovery.json", "w"),
)
json.dump(
    {
        "defaultProvider": "yoda-kyber",
        "defaultModel": "yoda/qwen3.8-flash",
        "defaultThinkingLevel": "low",
        "enableInstallTelemetry": False,
    },
    open(f"{rt}/agent/settings.json", "w"),
)
print("scratch agent dir seeded (1 env-keyed lane)")
PY

echo "importing through the real tool (mode=replace)..."
PI_CODING_AGENT_DIR="$RT/agent" timeout 300 pi -e "$HERE/src/index.ts" -p \
  "Call the gateways tool exactly once with action=import, path=$BUNDLE, mode=replace. Then reply OK." \
  >"$RT/import.log" 2>&1
echo "  pi exit=$?"

if [ -s "$GUARD" ]; then
  if ! md5sum -c --quiet "$GUARD" 2>/dev/null; then
    echo "ISOLATION VIOLATION: a file outside $RT/agent was modified:" >&2
    md5sum -c "$GUARD" 2>&1 | grep -v ': OK' >&2 || true
    rm -f "$GUARD"
    exit 1
  fi
fi
rm -f "$GUARD"
echo "  isolation OK: real config and dev sandbox untouched"

python3 - "$RT/agent/gateway-discovery.json" "$SRC_LIVE" "$BUNDLE" <<'PY'
import json, sys
got_path, want_path, bundle_path = sys.argv[1:4]
got = json.load(open(got_path))
want = json.load(open(want_path))
by_id = {g["id"]: g for g in got.get("gateways", [])}
print(f"restored {len(by_id)} of {len(want['gateways'])} gateways")

problems = []
if "aip_" in open(bundle_path).read():
    problems.append("bundle contains key material")
if "aip_" in open(got_path).read():
    problems.append("imported config contains key material")

for w in want["gateways"]:
    g = by_id.get(w["id"])
    if not g:
        problems.append(f"missing gateway {w['id']}")
        continue
    for f in ("api", "compat", "modelOverrides", "excludedModels", "apiKeyEnv", "excludeUnusable"):
        if w.get(f) != g.get(f):
            problems.append(f"{w['id']}.{f}: want {json.dumps(w.get(f))[:70]} got {json.dumps(g.get(f))[:70]}")

n_over = sum(len(g.get("modelOverrides") or {}) for g in want["gateways"])
n_excl = sum(len(g.get("excludedModels") or []) for g in want["gateways"])
n_compat = sum(len(g.get("compat") or {}) for g in want["gateways"])
print(f"tuning carried: {n_over} modelOverrides, {n_excl} excludedModels, {n_compat} compat flags")

if problems:
    print("\nROUND-TRIP MISMATCH:")
    for p in problems:
        print("  !", p)
    sys.exit(1)
print("\nROUND-TRIP EXACT — every gateway, compat flag, modelOverride and exclusion reproduced; no key material.")
PY
