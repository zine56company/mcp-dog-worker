#!/bin/zsh
set -euo pipefail
source "$HOME/.config/deepseek/access.env"
if [[ -f "$HOME/.config/phoenix-grove/access.env" ]]; then
  source "$HOME/.config/phoenix-grove/access.env"
fi
CODEX_BIN=""
for candidate in "$HOME"/.vscode/extensions/openai.chatgpt-*-darwin-x64/bin/macos-x86_64/codex; do
  if [ -x "$candidate" ] && { [ -z "$CODEX_BIN" ] || [ "$candidate" -nt "$CODEX_BIN" ]; }; then
    CODEX_BIN="$candidate"
  fi
done
if [ -z "$CODEX_BIN" ]; then
  echo "qwen-worker-mcp: no executable Codex binary found in the VS Code extension" >&2
  exit 1
fi
export CODEX_BIN
export QWEN_WORKSPACE_ROOT="/Users/ricardoadrianovandofuentealba/Documents/Codex/rustcinema"
exec "/usr/local/bin/node" "$HOME/.local/share/qwen-worker-mcp/router-v2.mjs"
