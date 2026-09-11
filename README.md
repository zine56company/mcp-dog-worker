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
tool_timeout_sec = 7200
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
does not orphan the job. The sequential log is capped at 16 MiB per run. After that cap, status calls
also return `log_tail`, a rolling 512 KiB tail that retains the worker's latest progress and final
report without allowing unbounded disk growth. Roll back by pointing `start.sh` back to `router.mjs`.
For large repositories, configure Codex with a two-hour MCP tool timeout (`7200` seconds). Keep status
polls short enough to report progress; their timeout is not the worker's lifetime limit.

For administration while an existing Codex thread still holds the old stdio transport, use
`node worker-client.mjs list`, `status <run_id>`, `wait <run_id>`, `cancel <run_id>`, or `runs`.
`start` accepts one JSON request on standard input so prompts do not appear in the process list.

## Local disk safety

Every delegated process receives the workspace's existing `target/` through
`CARGO_TARGET_DIR`; it must not create an isolated Cargo target. Incremental
compilation and Cargo debug symbols are disabled for worker-owned commands by
default to bound generated data. A private temporary directory is created
inside the durable run directory and removed on every terminal path, so a
worker cannot freely populate the host's global `/tmp` tree.

The supervisor measures free space before launch and every five seconds while
the worker runs. It refuses to start, or terminates the complete worker process
group, when available space falls below the default 12 GiB reserve. Status
responses expose `disk_free_bytes`, `disk_min_free_bytes`,
`cargo_target_directory`, and `managed_temp_directory`. Override the defaults
only in the private `.env` using `WORKER_MIN_FREE_BYTES`,
`WORKER_DISK_CHECK_MS`, `WORKER_TERMINATION_GRACE_MS`, or
`WORKER_CARGO_DEBUG`. Cancellation also targets the complete child process
group so orphaned `cargo`/`rustc` descendants cannot continue filling disk.
