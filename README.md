# mcp-dog-worker

Local asynchronous Codex worker router. Despite the historical local directory name, Qwen is disabled;
the configured economical workers are DeepSeek V4 Flash and, when credentials are present, GLM
5.3 Flash.

## Fresh installation

```sh
git clone https://github.com/zine56company/mcp-dog-worker.git
cd mcp-dog-worker
./setup.sh
```

On Windows PowerShell:

```powershell
git clone https://github.com/zine56company/mcp-dog-worker.git
Set-Location mcp-dog-worker
.\setup.ps1
```

On macOS, edit the generated `.env` and set `DEEPSEEK_API_KEY` plus the canonical
`QWEN_WORKSPACE_ROOT`. On Windows, keep the environment file outside the clone; the default location
is `%USERPROFILE%\.config\mcp-dog-worker\.env`. `PGS_API_KEY` is optional and enables GLM. The real
`.env`, isolated `codex-home/`, run logs, and dependencies are ignored by Git. The committed
`.env.example`, model catalogs, and configuration templates are secret-free.

The Windows launcher also accepts `DEEPSEEK_TOKEN_API` as an alias, so an existing external
`%USERPROFILE%\.config\mcp-dog-worker\.env` does not need to be rewritten. Pass that external file
and the authorized workspace explicitly when registering Codex:

```toml
[mcp_servers.mcp_dog_worker]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\absolute\path\mcp-dog-worker\start-windows.mjs', '--env-file', 'C:\Users\you\.config\mcp-dog-worker\.env', '--workspace-root', 'C:\absolute\workspace']
startup_timeout_sec = 30
tool_timeout_sec = 7200
enabled = true

[mcp_servers.mcp_dog_worker.env]
WORKER_MAX_OUTPUT_CHARS = "500"
```

Register the absolute launcher path in Codex:

```toml
[mcp_servers.qwen_worker]
command = "/absolute/path/to/mcp-dog-worker/start.sh"
startup_timeout_sec = 30
tool_timeout_sec = 7200
```

Reload the Codex/VS Code window after changing MCP configuration. Run
`npm test` to verify async completion, logs, locking, and cancellation without
calling a paid provider. macOS uses `sandbox-exec`. The Windows 10 compatibility default uses Codex
`danger-full-access` because native sandbox process creation is unreliable on that platform;
workspace validation, secret scrubbing, write locks, disk guards, logical read-only instructions,
and supervisor review remain active. Set `WORKER_WINDOWS_SANDBOX_MODE=workspace-write` only after a
real delegated shell smoke test passes on the host. Windows cancellation uses `taskkill /T` so
descendants do not survive. Linux is not yet supported.

Provider credentials stay in the trusted router/supervisor and reach the provider through a
per-run loopback proxy. The delegated Codex process receives placeholder proxy credentials, and
secret-like host environment variables and parent `CODEX_*` control-plane state are removed before
it is launched. The isolated worker then receives only its own `CODEX_HOME`.
The supervisor captures Codex's final message separately as `worker_result` and truncates it to
`WORKER_MAX_OUTPUT_CHARS` Unicode characters (500 by default on Windows), independently of the
bounded diagnostic log chunks.
Windows defaults each returned status/log chunk to 500 characters, and the delegated prompt also
requires a final response of at most 500 characters. Override `WORKER_MAX_OUTPUT_CHARS` only when a
larger diagnostic payload is explicitly needed.

Each `run_*_worker` call returns immediately with a durable `run_id`. Use `wait_worker` for bounded
waiting, `worker_status` for heartbeat and incremental logs, `list_worker_runs` to reconnect after a
client or MCP restart, and `cancel_worker` only when the owner requests cancellation or the worker is
authoritatively unsafe.

Durable state lives under `runs/<run_id>/`. A terminal run has both `completion_marker: true` in
`status.json` and a `completion.json` file. Editing workers take an atomic filesystem lock keyed by
the canonical workspace path, so two router processes cannot write to the same workspace at once.
On Windows, status publication retries transient sharing violations and falls back to a guarded
in-place replacement when a continuously open antivirus/indexer/reader prevents every atomic
rename. Router and supervisor JSON reads retry that brief replacement window, and a failed
telemetry write cannot poison later heartbeats or the terminal completion marker.

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

The supervisor measures both free space and the shared Cargo target before
launch and every five seconds while the worker runs. It refuses to start, or
terminates the complete worker process group, when available space falls below
the default 12 GiB reserve or the target grows beyond 32 GiB. Status responses
expose `disk_free_bytes`, `disk_min_free_bytes`, `cargo_target_bytes`,
`cargo_target_max_bytes`, `cargo_target_directory`, and
`managed_temp_directory`. Override the defaults only in the private `.env`
using `WORKER_MIN_FREE_BYTES`, `WORKER_MAX_TARGET_BYTES`,
`WORKER_DISK_CHECK_MS`, `WORKER_TERMINATION_GRACE_MS`, or
`WORKER_CARGO_DEBUG`. Cancellation also targets the complete child process
group so orphaned `cargo`/`rustc` descendants cannot continue filling disk.
