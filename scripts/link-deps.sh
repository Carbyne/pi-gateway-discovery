#!/usr/bin/env bash
# Link the dev checkout's node_modules to an already-installed copy of this
# package's dependency tree, instead of running `npm install` (256M, and the
# deps are peer deps already present wherever pi is installed).
#
# Safe by construction: we only ever CREATE symlinks inside this checkout's own
# node_modules/. The dependency source is treated as strictly read-only.
#
#   ./scripts/link-deps.sh [source-node-modules]
#
# Default source: the pi-installed copy of pi-gateway-discovery.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_SRC="$HOME/.pi/agent/git/github.com/Carbyne/pi-gateway-discovery/node_modules"
SRC="${1:-$DEFAULT_SRC}"

if [ ! -d "$SRC" ]; then
  echo "error: dependency source not found: $SRC" >&2
  echo "       run 'npm install' here instead, or pass a source path." >&2
  exit 1
fi

# Refuse to link into a node_modules that is itself a symlink — that would let
# a later `npm install` write through into the installed copy.
if [ -L "$HERE/node_modules" ]; then
  echo "error: $HERE/node_modules is a symlink; replacing it with a real dir." >&2
  rm "$HERE/node_modules"
fi
mkdir -p "$HERE/node_modules"

count=0
for entry in "$SRC"/* "$SRC"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  [ "$name" = ".package-lock.json" ] && continue
  target="$HERE/node_modules/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    continue  # real directory already present locally; never clobber
  fi
  ln -sfn "$entry" "$target"
  count=$((count + 1))
done

echo "linked $count top-level packages from:"
echo "  $SRC"
echo
echo "NOTE: node_modules/ here contains symlinks into that tree."
echo "      Do NOT run 'npm install' in this checkout unless you first"
echo "      'rm -rf node_modules' -- npm may write through the links."
