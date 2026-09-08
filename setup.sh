#!/bin/zsh
set -euo pipefail

MCP_DOG_ROOT="${0:A:h}"
WORKER_HOME="$MCP_DOG_ROOT/codex-home"

if ! command -v node >/dev/null 2>&1; then
  echo "mcp-dog-worker: Node.js is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "mcp-dog-worker: npm is required" >&2
  exit 1
fi

mkdir -p "$WORKER_HOME" "$MCP_DOG_ROOT/runs"
chmod 700 "$WORKER_HOME" "$MCP_DOG_ROOT/runs"

escaped_root=${MCP_DOG_ROOT//\\/\\\\}
escaped_root=${escaped_root//&/\\&}
escaped_root=${escaped_root//|/\\|}
sed "s|__MCP_ROOT__|$escaped_root|g" \
  "$MCP_DOG_ROOT/templates/deepseek-worker.config.toml" \
  > "$WORKER_HOME/deepseek-worker.config.toml"
sed "s|__MCP_ROOT__|$escaped_root|g" \
  "$MCP_DOG_ROOT/templates/glm-worker.config.toml" \
  > "$WORKER_HOME/glm-worker.config.toml"
cp "$MCP_DOG_ROOT/models/deepseek-v4-flash.json" "$WORKER_HOME/deepseek-model.json"
cp "$MCP_DOG_ROOT/models/glm-5.3-flash.json" "$WORKER_HOME/glm-model.json"
if [[ ! -f "$WORKER_HOME/config.toml" ]]; then
  print -r -- '# Secret-free isolated Codex home for delegated workers.' > "$WORKER_HOME/config.toml"
fi
chmod 600 "$WORKER_HOME"/*

npm --prefix "$MCP_DOG_ROOT" ci
node --check "$MCP_DOG_ROOT/router-v2.mjs"
node --check "$MCP_DOG_ROOT/worker-runner.mjs"
node --check "$MCP_DOG_ROOT/worker-client.mjs"
node -e 'for (const file of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(file, "utf8"))' \
  "$WORKER_HOME/deepseek-model.json" "$WORKER_HOME/glm-model.json"

if [[ ! -f "$MCP_DOG_ROOT/.env" ]]; then
  cp "$MCP_DOG_ROOT/.env.example" "$MCP_DOG_ROOT/.env"
  chmod 600 "$MCP_DOG_ROOT/.env"
  echo "mcp-dog-worker: created .env; fill DEEPSEEK_API_KEY and QWEN_WORKSPACE_ROOT" >&2
fi

echo "mcp-dog-worker: setup complete at $MCP_DOG_ROOT"
