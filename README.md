# mcp-dog-worker

Local asynchronous Codex worker router. Despite the historical local directory name, Qwen is disabled;
the configured economical workers are DeepSeek V4 Flash and, when credentials are present, GLM
5.3 Flash.

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
