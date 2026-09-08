import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const runDirectory = process.argv[2];
if (!runDirectory || !path.isAbsolute(runDirectory)) {
  throw new Error("worker-runner requires an absolute run directory");
}

const statusPath = path.join(runDirectory, "status.json");
const completionPath = path.join(runDirectory, "completion.json");
const jobPath = path.join(runDirectory, "job.json");
const logPath = path.join(runDirectory, "worker.log");
const cancelPath = path.join(runDirectory, "cancel.requested");
const LOCK_POLL_MS = 1000;
const HEARTBEAT_MS = 5000;
const LOG_LIMIT_BYTES = 16 * 1024 * 1024;
const bearer = process.env.WORKER_UPSTREAM_BEARER;
if (!bearer) throw new Error("WORKER_UPSTREAM_BEARER is required");
delete process.env.WORKER_UPSTREAM_BEARER;

const job = JSON.parse(await readFile(jobPath, "utf8"));
await unlink(jobPath);
const runtimeRoot = path.dirname(runDirectory);
const lockRoot = path.join(runtimeRoot, "locks");
await mkdir(lockRoot, { recursive: true, mode: 0o700 });

let child = null;
let lockDirectory = null;
let heartbeat = null;
let cancelRequested = false;
let logBytes = 0;
let logTruncated = false;
let statusQueue = Promise.resolve();
let logQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function patchStatus(patch) {
  statusQueue = statusQueue.then(async () => {
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    const next = { ...current, ...patch, updated_at: nowIso() };
    await atomicWriteJson(statusPath, next);
    return next;
  });
  return statusQueue;
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

function appendLog(chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  logQueue = logQueue.then(async () => {
    if (logBytes >= LOG_LIMIT_BYTES) return;
    const remaining = LOG_LIMIT_BYTES - logBytes;
    const accepted = buffer.subarray(0, remaining);
    if (accepted.length > 0) {
      await appendFile(logPath, accepted, { mode: 0o600 });
      logBytes += accepted.length;
    }
    if (accepted.length < buffer.length && !logTruncated) {
      logTruncated = true;
      await patchStatus({ log_truncated: true });
    }
  });
  return logQueue;
}

async function acquireWriteLock() {
  if (!job.allow_edits) return;
  const key = createHash("sha256").update(job.working_directory).digest("hex");
  lockDirectory = path.join(lockRoot, `${key}.lock`);
  while (!cancelRequested) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      await atomicWriteJson(path.join(lockDirectory, "owner.json"), {
        run_id: job.run_id,
        supervisor_pid: process.pid,
        working_directory: job.working_directory,
        acquired_at: nowIso()
      });
      await patchStatus({ queued_for_lock: false, lock_owner_run_id: job.run_id });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8"));
      } catch (ownerError) {
        if (ownerError?.code !== "ENOENT" && !(ownerError instanceof SyntaxError)) throw ownerError;
      }
      if (owner && !processAlive(owner.supervisor_pid)) {
        const stale = `${lockDirectory}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
        try {
          await rename(lockDirectory, stale);
          await rm(stale, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
      await patchStatus({
        status: "queued",
        queued_for_lock: true,
        lock_owner_run_id: owner?.run_id ?? null,
        heartbeat_at: nowIso()
      });
      await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
      cancelRequested = cancelRequested || (await fileExists(cancelPath));
    }
  }
  throw new Error("worker cancelled while waiting for the workspace write lock");
}

async function releaseWriteLock() {
  if (!lockDirectory) return;
  try {
    const owner = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8"));
    if (owner.run_id === job.run_id) await rm(lockDirectory, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function createSeatbeltProfile(workingDirectory, allowEdits, workerCodexHome) {
  const userHome = process.env.HOME;
  const protectedPaths = [
    { kind: "subpath", value: path.join(userHome, ".config") },
    { kind: "literal", value: path.join(userHome, ".codex", "auth.json") },
    { kind: "subpath", value: path.join(userHome, ".ssh") },
    { kind: "subpath", value: path.join(userHome, ".aws") },
    { kind: "subpath", value: path.join(userHome, ".gnupg") },
    { kind: "subpath", value: path.join(userHome, "Library", "Keychains") }
  ];
  const immutableWorkerFiles = [
    "config.toml",
    "deepseek-worker.config.toml",
    "freetoken-public.config.toml",
    "deepseek-model.json",
    "glm-worker.config.toml",
    "glm-model.json",
    "freetoken-model.json",
    "qwen-worker-instructions.md"
  ].map(name => path.join(workerCodexHome, name));
  const temporaryRoot = process.env.TMPDIR ?? "/tmp";
  const writablePaths = ["/private/tmp", temporaryRoot, workerCodexHome];
  if (allowEdits) writablePaths.push(workingDirectory);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    `(allow file-write* ${writablePaths.map(value => `(subpath \"${value}\")`).join(" ")})`,
    "(allow file-write* (literal \"/dev/null\") (literal \"/dev/tty\"))",
    ...protectedPaths.map(({ kind, value }) => `(deny file-read* file-write* (${kind} \"${value}\"))`),
    ...immutableWorkerFiles.map(value => `(deny file-write* (literal \"${value}\"))`)
  ].join("\n");
}

async function startProxy() {
  const proxy = http.createServer((request, response) => {
    if (!request.url?.startsWith(`/${job.upstream_route}/`)) {
      response.writeHead(404).end();
      return;
    }
    const relativePath = request.url.slice(job.upstream_route.length + 2);
    const target = new URL(relativePath, job.upstream_base_url);
    const headers = {
      ...request.headers,
      host: target.host,
      authorization: `Bearer ${bearer}`,
      ...job.upstream_headers
    };
    delete headers.connection;
    const forwarded = https.request(target, { method: request.method, headers }, upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    });
    forwarded.on("error", error => {
      if (!response.headersSent) response.writeHead(502);
      response.end(`upstream error: ${error.message}`);
    });
    request.pipe(forwarded);
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  return proxy;
}

async function finish(status, exitCode, error = null) {
  if (heartbeat) clearInterval(heartbeat);
  await logQueue;
  const finishedAt = nowIso();
  await patchStatus({
    status,
    exit_code: exitCode,
    error,
    heartbeat_at: finishedAt,
    finished_at: finishedAt,
    queued_for_lock: false,
    completion_marker: true,
    log_truncated: logTruncated
  });
  await atomicWriteJson(completionPath, {
    run_id: job.run_id,
    worker: job.worker,
    status,
    exit_code: exitCode,
    finished_at: finishedAt
  });
  await releaseWriteLock();
}

async function requestCancellation() {
  if (cancelRequested) return;
  cancelRequested = true;
  await patchStatus({ status: "cancelling", heartbeat_at: nowIso() }).catch(() => undefined);
  if (child && processAlive(child.pid)) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

process.on("SIGTERM", () => void requestCancellation());
process.on("SIGINT", () => void requestCancellation());

let proxy = null;
try {
  await patchStatus({ supervisor_pid: process.pid, heartbeat_at: nowIso() });
  await acquireWriteLock();
  if (cancelRequested || (await fileExists(cancelPath))) {
    cancelRequested = true;
    await finish("cancelled", null, "cancelled before worker launch");
  } else {
    proxy = await startProxy();
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("failed to start credential proxy");
    const workerConfig = {
      deepseek: { profile: "deepseek-worker", provider: "deepseek-worker" },
      glm: { profile: "glm-worker", provider: "phoenix-grove-worker" }
    }[job.worker];
    if (!workerConfig) throw new Error(`unknown worker ${job.worker}`);
    const proxyBaseUrl = `http://127.0.0.1:${address.port}/${job.upstream_route}`;
    const args = [
      "exec",
      "--profile",
      workerConfig.profile,
      "--sandbox",
      "danger-full-access",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--config",
      `model_providers.${workerConfig.provider}.base_url=\"${proxyBaseUrl}\"`,
      "--cd",
      job.working_directory,
      job.prompt
    ];
    const childEnv = {
      ...process.env,
      CODEX_HOME: job.worker_codex_home,
      WORKER_PROXY_BEARER: "router-managed-placeholder",
      WORKER_PROXY_CF_ID: "router-managed-placeholder",
      WORKER_PROXY_CF_SECRET: "router-managed-placeholder"
    };
    const seatbelt = createSeatbeltProfile(job.working_directory, job.allow_edits, job.worker_codex_home);
    child = spawn("/usr/bin/sandbox-exec", ["-p", seatbelt, job.codex_bin, ...args], {
      cwd: job.working_directory,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    await patchStatus({
      status: "running",
      started_at: nowIso(),
      heartbeat_at: nowIso(),
      child_pid: child.pid,
      queued_for_lock: false
    });
    heartbeat = setInterval(() => {
      void patchStatus({ heartbeat_at: nowIso() }).catch(() => undefined);
    }, HEARTBEAT_MS);
    child.stdout.on("data", chunk => void appendLog(chunk));
    child.stderr.on("data", chunk => void appendLog(chunk));
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (cancelRequested || (await fileExists(cancelPath))) {
      await finish("cancelled", result.code, `worker terminated by ${result.signal ?? "request"}`);
    } else if (result.code === 0) {
      await finish("completed", 0);
    } else {
      await finish(
        "failed",
        result.code,
        `worker exited with code ${result.code ?? "null"}${result.signal ? ` after ${result.signal}` : ""}`
      );
    }
  }
} catch (error) {
  await appendLog(`\n[worker-runner error] ${error?.stack ?? error}\n`).catch(() => undefined);
  await finish(cancelRequested ? "cancelled" : "failed", null, String(error?.message ?? error)).catch(
    () => undefined
  );
  process.exitCode = cancelRequested ? 0 : 1;
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  await releaseWriteLock().catch(() => undefined);
}
