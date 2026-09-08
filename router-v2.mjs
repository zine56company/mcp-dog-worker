import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODEX = process.env.CODEX_BIN;
const WORKSPACE_ROOT = process.env.QWEN_WORKSPACE_ROOT;
const MCP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER_CODEX_HOME = process.env.QWEN_WORKER_CODEX_HOME ?? path.join(MCP_ROOT, "codex-home");
const RUN_ROOT = process.env.QWEN_RUN_ROOT ?? path.join(MCP_ROOT, "runs");
const RUNNER = process.env.QWEN_RUNNER ?? path.join(MCP_ROOT, "worker-runner.mjs");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROMPT_CHARS = 250_000;
const DEFAULT_LOG_CHARS = 12_000;
const MAX_LOG_CHARS = 100_000;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 300;

if (!CODEX || !WORKSPACE_ROOT) {
  throw new Error("CODEX_BIN and QWEN_WORKSPACE_ROOT are required");
}

const resolvedRoot = await realpath(WORKSPACE_ROOT);
await mkdir(RUN_ROOT, { recursive: true, mode: 0o700 });
let nextCheapWorker = "deepseek";

const upstreams = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/",
    bearer: process.env.DEEPSEEK_API_KEY,
    headers: {},
    route: randomBytes(24).toString("hex")
  }
};
if (process.env.PGS_API_KEY) {
  upstreams.glm = {
    baseUrl: "https://api.pgsgrove.com/v1/",
    bearer: process.env.PGS_API_KEY,
    headers: {},
    route: randomBytes(24).toString("hex")
  };
}
for (const [worker, upstream] of Object.entries(upstreams)) {
  if (!upstream.bearer || Object.values(upstream.headers).some(value => !value)) {
    throw new Error(`Missing credentials for ${worker}`);
  }
}
for (const name of [
  "FREETOKEN_API_KEY",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "DEEPSEEK_API_KEY",
  "PGS_API_KEY"
]) {
  delete process.env[name];
}

function runToolDefinition(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_CHARS },
        working_directory: { type: "string" },
        allow_edits: { type: "boolean" }
      },
      required: ["prompt", "working_directory", "allow_edits"],
      additionalProperties: false
    }
  };
}

function statusToolDefinition(name, description, includeWait = false) {
  const properties = {
    run_id: { type: "string" },
    after_offset: { type: "integer", minimum: 0, default: 0 },
    max_chars: {
      type: "integer",
      minimum: 0,
      maximum: MAX_LOG_CHARS,
      default: DEFAULT_LOG_CHARS
    }
  };
  if (includeWait) {
    properties.timeout_seconds = {
      type: "integer",
      minimum: 0,
      maximum: MAX_WAIT_SECONDS,
      default: DEFAULT_WAIT_SECONDS
    };
  }
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required: ["run_id"],
      additionalProperties: false
    }
  };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function nowIso() {
  return new Date().toISOString();
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("run_id is not a valid worker run id");
  }
}

function runDirectory(runId) {
  validateRunId(runId);
  return path.join(RUN_ROOT, runId);
}

async function validateWorkspace(candidate) {
  const resolved = await realpath(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("working_directory is outside the authorized workspace");
  }
  return resolved;
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function readRun(runId) {
  try {
    return JSON.parse(await readFile(path.join(runDirectory(runId), "status.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown worker run: ${runId}`);
    throw error;
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function reconcileRun(run) {
  if (TERMINAL_STATUSES.has(run.status) || !run.supervisor_pid || processAlive(run.supervisor_pid)) {
    return run;
  }
  const directory = runDirectory(run.run_id);
  const cancelled = await fileExists(path.join(directory, "cancel.requested"));
  const finishedAt = run.finished_at ?? nowIso();
  const terminal = {
    ...run,
    status: cancelled ? "cancelled" : "failed",
    finished_at: finishedAt,
    updated_at: nowIso(),
    completion_marker: true,
    error: cancelled ? run.error ?? null : run.error ?? "worker supervisor exited without a completion marker"
  };
  await atomicWriteJson(path.join(directory, "status.json"), terminal);
  await atomicWriteJson(path.join(directory, "completion.json"), {
    run_id: run.run_id,
    status: terminal.status,
    finished_at: finishedAt,
    recovered_by_router: true
  });
  return terminal;
}

async function readLog(runId, afterOffset, maxChars) {
  const logPath = path.join(runDirectory(runId), "worker.log");
  const offset = Number.isSafeInteger(afterOffset) && afterOffset >= 0 ? afterOffset : 0;
  const limit = Number.isSafeInteger(maxChars)
    ? Math.max(0, Math.min(maxChars, MAX_LOG_CHARS))
    : DEFAULT_LOG_CHARS;
  if (limit === 0) return { log: "", next_offset: offset, log_eof: true };
  let handle;
  try {
    handle = await open(logPath, "r");
    const info = await handle.stat();
    const start = Math.min(offset, info.size);
    const bytesToRead = Math.min(limit, info.size - start);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    return {
      log: buffer.subarray(0, bytesRead).toString("utf8"),
      next_offset: start + bytesRead,
      log_eof: start + bytesRead >= info.size
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { log: "", next_offset: offset, log_eof: true };
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readLogTail(runId, maxChars) {
  const tailPath = path.join(runDirectory(runId), "worker-tail.log");
  const limit = Number.isSafeInteger(maxChars)
    ? Math.max(0, Math.min(maxChars, MAX_LOG_CHARS))
    : DEFAULT_LOG_CHARS;
  if (limit === 0) return { log_tail: "", log_tail_bytes: 0 };
  let handle;
  try {
    handle = await open(tailPath, "r");
    const info = await handle.stat();
    const bytesToRead = Math.min(limit, info.size);
    const start = info.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    return {
      log_tail: buffer.subarray(0, bytesRead).toString("utf8"),
      log_tail_bytes: info.size
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { log_tail: "", log_tail_bytes: 0 };
    throw error;
  } finally {
    await handle?.close();
  }
}

function publicRun(run) {
  return {
    run_id: run.run_id,
    worker: run.worker,
    status: run.status,
    allow_edits: run.allow_edits,
    working_directory: run.working_directory,
    created_at: run.created_at,
    started_at: run.started_at ?? null,
    updated_at: run.updated_at,
    heartbeat_at: run.heartbeat_at ?? null,
    finished_at: run.finished_at ?? null,
    queued_for_lock: Boolean(run.queued_for_lock),
    lock_owner_run_id: run.lock_owner_run_id ?? null,
    exit_code: run.exit_code ?? null,
    completion_marker: Boolean(run.completion_marker),
    log_truncated: Boolean(run.log_truncated),
    error: run.error ?? null
  };
}

async function statusWithLog(args) {
  validateRunId(args?.run_id);
  const run = await reconcileRun(await readRun(args.run_id));
  const log = await readLog(args.run_id, args.after_offset ?? 0, args.max_chars ?? DEFAULT_LOG_CHARS);
  const tail = run.log_truncated
    ? await readLogTail(args.run_id, args.max_chars ?? DEFAULT_LOG_CHARS)
    : { log_tail: "", log_tail_bytes: 0 };
  return { ...publicRun(run), ...log, ...tail };
}

async function startWorker(worker, args) {
  if (
    !args ||
    typeof args.prompt !== "string" ||
    args.prompt.length === 0 ||
    args.prompt.length > MAX_PROMPT_CHARS ||
    typeof args.working_directory !== "string" ||
    typeof args.allow_edits !== "boolean"
  ) {
    throw new Error("prompt, working_directory, and allow_edits are required and must be valid");
  }
  if (!upstreams[worker]) throw new Error(`Worker ${worker} is not configured`);
  const workspace = await validateWorkspace(args.working_directory);
  const runId = randomUUID();
  const directory = runDirectory(runId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const createdAt = nowIso();
  await atomicWriteJson(path.join(directory, "status.json"), {
    run_id: runId,
    worker,
    status: "queued",
    allow_edits: args.allow_edits,
    working_directory: workspace,
    created_at: createdAt,
    updated_at: createdAt,
    heartbeat_at: createdAt,
    queued_for_lock: args.allow_edits,
    completion_marker: false,
    log_truncated: false
  });
  await atomicWriteJson(path.join(directory, "job.json"), {
    run_id: runId,
    worker,
    prompt: args.prompt,
    working_directory: workspace,
    allow_edits: args.allow_edits,
    codex_bin: CODEX,
    worker_codex_home: WORKER_CODEX_HOME,
    workspace_root: resolvedRoot,
    upstream_base_url: upstreams[worker].baseUrl,
    upstream_headers: upstreams[worker].headers,
    upstream_route: upstreams[worker].route
  });
  const child = spawn(process.execPath, [RUNNER, directory], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WORKER_UPSTREAM_BEARER: upstreams[worker].bearer }
  });
  child.unref();
  return {
    run_id: runId,
    worker,
    status: "queued",
    allow_edits: args.allow_edits,
    working_directory: workspace,
    message: "Worker accepted asynchronously. Poll wait_worker or worker_status until completion_marker is true."
  };
}

async function waitForRun(args) {
  validateRunId(args?.run_id);
  const timeoutSeconds = Number.isSafeInteger(args.timeout_seconds)
    ? Math.max(0, Math.min(args.timeout_seconds, MAX_WAIT_SECONDS))
    : DEFAULT_WAIT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previous = await readRun(args.run_id);
  while (!TERMINAL_STATUSES.has(previous.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const current = await reconcileRun(await readRun(args.run_id));
    if (current.status !== previous.status || current.updated_at !== previous.updated_at) {
      previous = current;
      if (TERMINAL_STATUSES.has(current.status)) break;
    }
  }
  return statusWithLog(args);
}

async function cancelRun(args) {
  validateRunId(args?.run_id);
  let run = await reconcileRun(await readRun(args.run_id));
  if (TERMINAL_STATUSES.has(run.status)) {
    return { ...publicRun(run), message: "Run was already terminal; no signal sent." };
  }
  const directory = runDirectory(run.run_id);
  await writeFile(path.join(directory, "cancel.requested"), `${nowIso()}\n`, { mode: 0o600 });
  if (processAlive(run.supervisor_pid)) {
    try {
      process.kill(-run.supervisor_pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  run = await reconcileRun(await readRun(run.run_id));
  return {
    ...publicRun(run),
    message: "Cancellation requested for the worker process group. Poll until completion_marker is true."
  };
}

async function listRuns(args) {
  const limit = Number.isSafeInteger(args?.limit) ? Math.max(1, Math.min(args.limit, 100)) : 20;
  const entries = await readdir(RUN_ROOT, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    try {
      runs.push(await reconcileRun(await readRun(entry.name)));
    } catch {
      // An incompletely-created run will appear on the next poll.
    }
  }
  runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { runs: runs.slice(0, limit).map(publicRun) };
}

const server = new Server(
  { name: "qwen-worker-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    runToolDefinition(
      "run_cheap_worker",
      upstreams.glm
        ? "Starts DeepSeek V4 Flash or GLM 5.3 Flash asynchronously in round-robin order and returns a run_id."
        : "Starts DeepSeek V4 Flash asynchronously and returns a run_id."
    ),
    runToolDefinition(
      "run_deepseek_worker",
      "Starts the DeepSeek V4 Flash worker asynchronously and returns a run_id."
    ),
    ...(upstreams.glm
      ? [runToolDefinition("run_glm_worker", "Starts the GLM 5.3 Flash worker asynchronously and returns a run_id.")]
      : []),
    statusToolDefinition(
      "worker_status",
      "Returns durable worker state, heartbeat, completion marker, incremental logs, and a rolling tail after truncation."
    ),
    statusToolDefinition(
      "wait_worker",
      "Waits briefly for progress or completion and returns durable state, incremental logs, and a rolling tail after truncation.",
      true
    ),
    {
      name: "cancel_worker",
      description: "Requests real cancellation of a queued or running worker process group.",
      inputSchema: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: "list_worker_runs",
      description: "Lists recent durable worker runs for reconnecting after a client timeout or restart.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        additionalProperties: false
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  if (name === "worker_status") return textResult(await statusWithLog(args));
  if (name === "wait_worker") return textResult(await waitForRun(args));
  if (name === "cancel_worker") return textResult(await cancelRun(args));
  if (name === "list_worker_runs") return textResult(await listRuns(args));
  let worker;
  if (name === "run_cheap_worker") {
    worker = upstreams.glm ? nextCheapWorker : "deepseek";
    if (upstreams.glm) nextCheapWorker = nextCheapWorker === "deepseek" ? "glm" : "deepseek";
  } else if (name === "run_deepseek_worker") {
    worker = "deepseek";
  } else if (name === "run_glm_worker" && upstreams.glm) {
    worker = "glm";
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }
  return textResult(await startWorker(worker, args));
});

await server.connect(new StdioServerTransport());
