#!/usr/bin/env bash
# Local dev rebuild for the automation-mcp + mcp-server pair.
#
# Order matters: mcp-server consumes automation-mcp via a `file:` dependency
# (a symlink under npm 7+), so its build picks up the latest dist/ from here.
# Building automation-mcp first → then mcp-server gives Claude Desktop's bin
# a fully up-to-date bundle on the next restart.
#
# Run from either repo or with an absolute path. Idempotent.

set -euo pipefail

# Resolve sibling repos relative to this script so it works no matter where
# you invoke it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_SERVER_DIR="$(cd "$AUTOMATION_DIR/../testingbot-mcp-server" 2>/dev/null && pwd || true)"

color()  { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
header() { color "1;34" "==> $1"; }
ok()     { color "1;32" "✓ $1"; }
warn()   { color "1;33" "! $1"; }

header "Building @testingbot/automation-mcp ($AUTOMATION_DIR)"
( cd "$AUTOMATION_DIR" && npm run build )
ok "automation-mcp built"

if [[ -d "$MCP_SERVER_DIR" ]]; then
  header "Building @testingbot/mcp-server ($MCP_SERVER_DIR)"
  ( cd "$MCP_SERVER_DIR" && npm run build )
  ok "mcp-server built"
else
  warn "Sibling testingbot-mcp-server not found — skipping consumer build."
  warn "Expected at: $AUTOMATION_DIR/../testingbot-mcp-server"
fi

echo
ok "All builds complete."
echo
color "0" "Next steps:"
color "0" "  • Fully quit Claude Desktop (Cmd-Q) and reopen to pick up the new bin."
color "0" "  • Or run the standalone server to smoke-test:"
color "0" "      node $AUTOMATION_DIR/dist/index.js"
if [[ -d "$MCP_SERVER_DIR" ]]; then
  color "0" "      node $MCP_SERVER_DIR/dist/index.js"
fi
