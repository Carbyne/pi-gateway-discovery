#!/usr/bin/env bash
# Smoke-test the new tool paths through a REAL pi process, asserting on the
# tool results recorded in the session JSONL rather than on model prose.
#
# Everything runs via scripts/dev-pi.sh: PI_CODING_AGENT_DIR points at
# .dev/agent and only ./src/index.ts is loaded. A bare `pi` here would use the
# installed extension and the real agent dir and silently test the wrong thing.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
A=.dev/agent
SESS="$A/sessions"
BUNDLE=/tmp/probe/bundle.json
rm -f "$BUNDLE"

# Print the JSON `details` of the most recent gateways tool call.
latest_tool_result() {
  python3 - "$SESS" <<'PY'
import json, os, sys, glob
root = sys.argv[1]
files = sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True), key=os.path.getmtime)
for path in reversed(files):
    hit = None
    for line in open(path, encoding="utf8", errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        stack = [d]
        while stack:
            o = stack.pop()
            if isinstance(o, dict):
                if o.get("toolName") == "gateways" and o.get("role") == "toolResult":
                    hit = o
                stack.extend(o.values())
            elif isinstance(o, list):
                stack.extend(o)
    if hit is not None:
        print(json.dumps(hit.get("details", hit)))
        break
PY
}

ask() { # ask "<instruction>"
  timeout 300 ./scripts/dev-pi.sh -p "$1" >/dev/null 2>&1
}

echo "############ 0a. headless discovery must persist metadata"
# Regression: metadata was only written from the provider's fetchModels, but
# `pi --list-models` / `pi -p` discover via refreshStaleGateways instead — so
# exactly the headless flows used to bootstrap a new machine wrote no record,
# and describe/doctor silently fell back to "unknown"/0.
./scripts/dev-pi.sh --fresh --list-models >/dev/null 2>&1
python3 - <<'PYIN'
import json, os
p = ".dev/agent/gateway-discovery-meta.json"
assert os.path.exists(p), "headless discovery wrote no metadata"
d = json.load(open(p))
assert len(d) == 5, sorted(d)
kyb = d["yoda-kyber"]
declared = [q["id"] for q in kyb.get("quirksApplied", []) if q["source"] == "declared"]
assert declared == ["yoda/qwen3.8-flash"], declared
mis = d["yoda-mistral"]
assert len(mis.get("excludedUnusable", [])) >= 6, mis.get("excludedUnusable")
assert any("realtime" in x["id"] for x in d["yoda-openai"]["excludedUnusable"])
print(f"  meta OK: 5 gateways, {sum(len(m.get('excludedUnusable',[])) for m in d.values())} excluded,"
      f" {sum(len(m.get('quirksApplied',[])) for m in d.values())} auto-configured")
print(f"  declared-vocabulary models: {declared}")
PYIN
[ $? -ne 0 ] && exit 1

echo "############ 0b. confirm we are testing the DEV extension"
# The dev build accepts actions upstream never had; the installed one does not.
ask "Call the gateways tool exactly once with action=doctor."
DEV_JSON=$(latest_tool_result)
if [ -z "$DEV_JSON" ]; then echo "FAIL: no tool result recorded (extension not loaded?)"; exit 1; fi
python3 - "$DEV_JSON" <<'PY' || exit 1
import json,sys
d=json.loads(sys.argv[1])
assert "gateways" in d and "problems" in d, f"not a doctor report: {str(d)[:200]}"
print("  dev extension confirmed (doctor action supported)")
PY

echo "############ 1. EXPORT"
ask "Call the gateways tool exactly once with action=export and path=$BUNDLE."
python3 - "$BUNDLE" <<'PY'
import json, os, sys
p = sys.argv[1]
assert os.path.exists(p), "bundle was not written"
raw = open(p).read()
b = json.loads(raw)
mode = oct(os.stat(p).st_mode & 0o777)
ids = [g["id"] for g in b["config"]["gateways"]]
print(f"  bundleVersion={b.get('bundleVersion')} gateways={len(ids)} mode={mode} creds={'credentials' in b}")
print(f"  ids={ids}")
assert len(ids) == 5, ids
assert "credentials" not in b, "key-less export contained credentials"
assert "aip_" not in raw, "SECRET LEAKED INTO KEYLESS BUNDLE"
assert mode == "0o600", mode
print("  EXPORT OK")
PY
[ $? -ne 0 ] && exit 1

echo "############ 2. IMPORT restores a reduced config (merge by id)"
cp "$A/gateway-discovery.json" /tmp/probe/cfg-backup.json
python3 - "$A/gateway-discovery.json" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
one = [g for g in c["gateways"] if g["id"] == "yoda-kyber"]
json.dump({"version": 1, "autoRefreshTtlHours": 24, "gateways": one}, open(p, "w"), indent=2)
print("  reduced live config to:", [g["id"] for g in one])
PY
ask "Call the gateways tool exactly once with action=import and path=$BUNDLE."
python3 - "$A/gateway-discovery.json" <<'PY'
import json, sys
ids = [g["id"] for g in json.load(open(sys.argv[1]))["gateways"]]
print("  after import:", ids)
assert len(ids) == 5, f"import did not restore all lanes: {ids}"
print("  IMPORT OK")
PY
[ $? -ne 0 ] && exit 1

echo "############ 3. DESCRIBE a namespaced, auto-configured model"
ask "Call the gateways tool exactly once with action=describe, gatewayId=yoda-kyber, modelId=yoda/qwen3.8-flash."
latest_tool_result | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d['model']; src=d['source']
print('  api          :', m['api'], '| from', src['api'])
print('  thinkingMap  :', json.dumps(m['thinkingLevelMap']))
print('  map source   :', src['thinkingLevelMap'])
assert m['thinkingLevelMap']['low']=='low' and m['thinkingLevelMap']['high'] is None
assert src['thinkingLevelMap']=='upstream-declared', src
print('  DESCRIBE OK')
"
[ $? -ne 0 ] && exit 1

echo "############ 4. DOCTOR flags a renamed saved default"
python3 - "$A/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["defaultModel"] = "yoda/qwen3.8-next"; json.dump(s, open(p, "w"), indent=2)
print("  injected stale default:", s["defaultModel"])
PY
ask "Call the gateways tool exactly once with action=doctor."
latest_tool_result | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  ok      :', d['ok'])
for x in d['problems']: print('  problem :', x)
assert not d['ok']
assert any('not registered' in x for x in d['problems']), 'renamed default not detected'
print('  DOCTOR detects the renamed model OK')
"
[ $? -ne 0 ] && exit 1

echo "############ 5. DOCTOR healthy after fixing the default"
python3 - "$A/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["defaultModel"] = "yoda/qwen3.8-flash"; json.dump(s, open(p, "w"), indent=2)
PY
ask "Call the gateways tool exactly once with action=doctor."
latest_tool_result | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  ok:', d['ok'], '| problems:', d['problems'], '| warnings:', d['warnings'])
for g in d['gateways']:
    print(f\"    {g['id']:14s} {g['models']:3d} models {g['api']:20s} excluded={g['excludedUnusable']} auto={g['autoConfigured']} synced={g['synced']}\")
assert d['ok'], d['problems']
print('  DOCTOR healthy OK')
"
[ $? -ne 0 ] && exit 1

echo
echo "ALL SMOKE CHECKS PASSED"
