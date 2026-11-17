#!/usr/bin/env bash
# Build the bridge and register it as a user-scope Claude Code MCP server. Idempotent.
# Usage: scripts/install.sh [server-name]   (default name: claude-opencode)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-claude-opencode}"

if ! command -v node >/dev/null 2>&1; then
  echo "node (>= 20) is required" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found. Build finished; register manually with:" >&2
  echo "  claude mcp add --scope user $NAME -- node $ROOT/dist/index.js" >&2
  exit 2
fi

cd "$ROOT"
# Install without lifecycle scripts (no prepare/postinstall), then build explicitly.
if [ ! -f node_modules/.package-lock.json ]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
npm run build

if claude mcp get "$NAME" >/dev/null 2>&1; then
  claude mcp remove --scope user "$NAME" >/dev/null
fi
claude mcp add --scope user "$NAME" -- node "$ROOT/dist/index.js"
echo "registered MCP server '$NAME' (user scope) -> $ROOT/dist/index.js"
