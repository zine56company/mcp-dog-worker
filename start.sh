#!/bin/zsh
set -euo pipefail
MCP_DOG_ROOT="${0:A:h}"

if [[ -n "${MCP_DOG_ENV_FILE:-}" ]]; then
  source "$MCP_DOG_ENV_FILE"
elif [[ -f "$MCP_DOG_ROOT/.env" ]]; then
  source "$MCP_DOG_ROOT/.env"
else
  [[ -f "$HOME/.config/deepseek/access.env" ]] && source "$HOME/.config/deepseek/access.env"
  [[ -f "$HOME/.config/phoenix-grove/access.env" ]] && source "$HOME/.config/phoenix-grove/access.env"
fi

if [[ -z "${CODEX_BIN:-}" ]]; then
  CODEX_BIN="$(command -v codex 2>/dev/null || true)"
fi
if [[ -z "$CODEX_BIN" ]]; then
  for candidate in "$HOME"/.vscode/extensions/openai.chatgpt-*-darwin-x64/bin/macos-*/codex; do
    if [[ -x "$candidate" ]] && { [[ -z "$CODEX_BIN" ]] || [[ "$candidate" -nt "$CODEX_BIN" ]]; }; then
      CODEX_BIN="$candidate"
    fi
  done
fi
if [[ -z "$CODEX_BIN" || ! -x "$CODEX_BIN" ]]; then
  echo "mcp-dog-worker: no executable Codex binary found; set CODEX_BIN in .env" >&2
  exit 1
fi
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "mcp-dog-worker: no executable Node.js found; set NODE_BIN in .env" >&2
  exit 1
fi
: "${DEEPSEEK_API_KEY:?mcp-dog-worker: set DEEPSEEK_API_KEY in .env}"
: "${QWEN_WORKSPACE_ROOT:?mcp-dog-worker: set QWEN_WORKSPACE_ROOT in .env}"
if [[ ! -f "$MCP_DOG_ROOT/codex-home/deepseek-worker.config.toml" ]]; then
  echo "mcp-dog-worker: runtime config missing; run ./setup.sh first" >&2
  exit 1
fi
export CODEX_BIN
export QWEN_WORKSPACE_ROOT
exec "$NODE_BIN" "$MCP_DOG_ROOT/router-v2.mjs"
