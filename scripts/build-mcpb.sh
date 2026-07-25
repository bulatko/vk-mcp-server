#!/usr/bin/env bash
# Builds the .mcpb bundle — the one-click install file for Claude Desktop and
# other MCP clients. The bundle ships its own node_modules, so it is built in a
# clean directory with production dependencies only; packing the working tree
# would drag in jest and the test suite.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

VERSION="$(node -p "require('$ROOT/package.json').version")"
MANIFEST_VERSION="$(node -p "require('$ROOT/manifest.json').version")"

if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  echo "version mismatch: package.json is $VERSION, manifest.json is $MANIFEST_VERSION" >&2
  exit 1
fi

cp -r "$ROOT/src" "$ROOT/manifest.json" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/LICENSE" "$BUILD/"

# --omit=dev keeps jest and the mcpb CLI out of the bundle. NODE_ENV is forced
# because a production environment makes npm skip the install entirely.
(cd "$BUILD" && NODE_ENV=development npm install --omit=dev --no-audit --no-fund --silent)

mkdir -p "$ROOT/dist"
(cd "$BUILD" && npx --yes @anthropic-ai/mcpb@2.1.2 pack . "$ROOT/dist/vk-mcp-server-$VERSION.mcpb")

echo
echo "built: dist/vk-mcp-server-$VERSION.mcpb"
ls -lh "$ROOT/dist/vk-mcp-server-$VERSION.mcpb" | awk '{print "size: " $5}'
