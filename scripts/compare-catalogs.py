#!/usr/bin/env python3
"""Compare two models-store.json catalogs field-by-field.

Used to check that auto-configuration (dev build, bare config) reproduces the
hand-authored tuning in the live config, before anything is swapped.

  compare-catalogs.py LIVE.json DEV.json
"""
import json, sys, collections

FIELDS = ("api", "reasoning", "contextWindow", "maxTokens", "input", "compat", "thinkingLevelMap")


def load(path):
    raw = json.load(open(path))
    out = {}
    for gw, blob in raw.items():
        for m in blob.get("models", []):
            out[(gw, m["id"])] = m
    return out


live, dev = load(sys.argv[1]), load(sys.argv[2])

only_live = sorted(set(live) - set(dev))
only_dev = sorted(set(dev) - set(live))
common = sorted(set(live) & set(dev))

diffs = collections.Counter()
details = []
for key in common:
    a, b = live[key], dev[key]
    for f in FIELDS:
        if a.get(f) != b.get(f):
            diffs[f] += 1
            details.append((key, f, a.get(f), b.get(f)))

print(f"\ncatalogs: live={len(live)}  dev={len(dev)}  compared={len(common)}")
print(f"only in live ({len(only_live)}):")
for k in only_live:
    print(f"   {k[0]}/{k[1]}")
print(f"only in dev ({len(only_dev)}):")
for k in only_dev:
    print(f"   {k[0]}/{k[1]}")

print(f"\nfield differences over the {len(common)} shared models:")
if not diffs:
    print("   none")
for f, n in diffs.most_common():
    print(f"   {f:18s} {n}")
for key, f, a, b in details[:40]:
    print(f"\n   {key[0]}/{key[1]}  [{f}]")
    print(f"     live: {json.dumps(a)}")
    print(f"     dev : {json.dumps(b)}")
if len(details) > 40:
    print(f"\n   ... {len(details) - 40} more")

print(f"\nidentical on all compared fields: {len(common) - len({d[0] for d in details})}/{len(common)} models")
