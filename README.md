# mcp-dog-worker

Local asynchronous Codex worker router. Despite the historical local directory name, Qwen is disabled;
the configured economical workers are DeepSeek V4 Flash and, when credentials are present, GLM
5.3 Flash.

## Fresh installation (macOS)

```sh
git clone https://github.com/zine56company/mcp-dog-worker.git
cd mcp-dog-worker
./setup.sh
```

Edit the generated `.env` and set `DEEPSEEK_API_KEY` plus the canonical
`QWEN_WORKSPACE_ROOT`. `PGS_API_KEY` is optional and enables GLM. The real
`.env`, isolated `codex-home/`, run logs, and dependencies are ignored by Git.
The committed `.env.example`, model catalogs, and configuration templates are
secret-free.

Register the absolute launcher path in Codex:

```toml
[mcp_servers.qwen_worker]
command = "/absolute/path/to/mcp-dog-worker/start.sh"
startup_timeout_sec = 30
tool_timeout_sec = 300
```

Reload the Codex/VS Code window after changing MCP configuration. Run
`npm test` to verify async completion, logs, locking, and cancellation without
calling a paid provider. The worker sandbox currently uses macOS
`/usr/bin/sandbox-exec`; Linux and Windows installation are not yet supported.

Each `run_*_worker` call returns immediately with a durable `run_id`. Use `wait_worker` for bounded
waiting, `worker_status` for heartbeat and incremental logs, `list_worker_runs` to reconnect after a
client or MCP restart, and `cancel_worker` only when the owner requests cancellation or the worker is
authoritatively unsafe.

Durable state lives under `runs/<run_id>/`. A terminal run has both `completion_marker: true` in
`status.json` and a `completion.json` file. Editing workers take an atomic filesystem lock keyed by
the canonical workspace path, so two router processes cannot write to the same workspace at once.

Run tools are asynchronous by design: an MCP timeout while waiting does not imply worker failure and
does not orphan the job. Logs are capped at 16 MiB per run. Roll back by pointing `start.sh` back to
`router.mjs`.

For administration while an existing Codex thread still holds the old stdio transport, use
`node worker-client.mjs list`, `status <run_id>`, `wait <run_id>`, `cancel <run_id>`, or `runs`.
`start` accepts one JSON request on standard input so prompts do not appear in the process list.
