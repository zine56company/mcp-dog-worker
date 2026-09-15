import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { atomicWriteJson, readJsonFile, replaceFileAtomically } from "./atomic-file.mjs";

const router = fileURLToPath(new URL("./router-v2.mjs", import.meta.url));
const runner = fileURLToPath(new URL("./worker-runner.mjs", import.meta.url));

test("Windows worker processes are launched without console windows", async () => {
  const [routerSource, runnerSource] = await Promise.all([
    readFile(router, "utf8"),
    readFile(runner, "utf8")
  ]);
  assert.match(
    routerSource,
    /spawn\(process\.execPath, \[RUNNER, directory\], \{[\s\S]*?windowsHide: true/
  );
  assert.match(
    runnerSource,
    /spawn\(IS_WINDOWS \? launchCommand : "\/usr\/bin\/sandbox-exec", launchArgs, \{[\s\S]*?windowsHide: true/
  );
});

test("atomic replacement retries transient Windows sharing violations", async () => {
  let attempts = 0;
  const delays = [];
  await replaceFileAtomically("temporary", "target", {
    renameFile: async () => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    },
    retryWait: async delay => delays.push(delay)
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 40]);
});

test("atomic JSON replacement stays readable under concurrent status traffic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-dog-atomic-test-"));
  const target = path.join(root, "status.json");
  await atomicWriteJson(target, { generation: -1 });
  let reading = true;
  const observedErrors = [];
  const readers = Array.from({ length: 4 }, async () => {
    while (reading) {
      try {
        await readJsonFile(target);
      } catch (error) {
        observedErrors.push(error);
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  });
  try {
    for (let generation = 0; generation < 50; generation += 1) {
      await atomicWriteJson(target, { generation, payload: "x".repeat(4096) });
    }
  } finally {
    reading = false;
    await Promise.all(readers);
  }
  assert.deepEqual(observedErrors, []);
  assert.equal((await readJsonFile(target)).generation, 49);
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qwen-worker-mcp-test-"));
  const workspace = path.join(root, "workspace");
  const workerHome = path.join(root, "worker-home");
  const runRoot = path.join(root, "runs");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(workerHome, { recursive: true }),
    mkdir(runRoot, { recursive: true })
  ]);
  const fakeCodex = path.join(root, "fake-codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const prompt = process.argv.at(-1) ?? "";
const finalMessageIndex = process.argv.indexOf("--output-last-message");
if (finalMessageIndex >= 0) {
  const result = prompt.includes("long-final") ? "R".repeat(700) : "fake-result:" + prompt;
  writeFileSync(process.argv[finalMessageIndex + 1], result);
}
console.log("fake-start:" + prompt);
if (prompt.includes("huge")) process.stdout.write("A".repeat(4096) + "\\nfinal-tail-marker\\n");
if (prompt.includes("show-env")) {
  const sandboxIndex = process.argv.indexOf("--sandbox");
  console.log("worker-env:" + JSON.stringify({
    cargoTarget: process.env.CARGO_TARGET_DIR,
    cargoIncremental: process.env.CARGO_INCREMENTAL,
    devDebug: process.env.CARGO_PROFILE_DEV_DEBUG,
    testDebug: process.env.CARGO_PROFILE_TEST_DEBUG,
    temp: process.env.TMPDIR,
    secretLeak: process.env.TEST_SUPER_SECRET ?? null,
    parentPermission: process.env.CODEX_PERMISSION_PROFILE ?? null,
    sandbox: sandboxIndex >= 0 ? process.argv[sandboxIndex + 1] : null
  }));
}
if (prompt.includes("descendant")) {
  const code = "setTimeout(() => { const fs = require('node:fs'); fs.mkdirSync(process.env.TMPDIR, { recursive: true }); fs.writeFileSync(process.env.TMPDIR + '/descendant-marker', 'orphan'); }, 1500); setTimeout(() => {}, 5000);";
  spawn(process.execPath, ["-e", code], { env: process.env, stdio: "ignore" });
}
const delay = prompt.includes("cancel") ? 30000 : prompt.includes("lock") ? 5000 : prompt.includes("slow") ? 1200 : 100;
setTimeout(() => { console.log("fake-finish:" + prompt); }, delay);
`,
    { mode: 0o700 }
  );
  await chmod(fakeCodex, 0o700);
  return {
    root,
    workspace,
    workerHome,
    runRoot,
    fakeCodex,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

function decode(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

async function connect(values) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [router],
    env: {
      ...process.env,
      CODEX_BIN: values.fakeCodex,
      QWEN_WORKSPACE_ROOT: values.workspace,
      QWEN_WORKER_CODEX_HOME: values.workerHome,
      QWEN_RUN_ROOT: values.runRoot,
      QWEN_RUNNER: runner,
      ...(values.logLimit ? { WORKER_LOG_LIMIT_BYTES: String(values.logLimit) } : {}),
      ...(values.logTail ? { WORKER_LOG_TAIL_BYTES: String(values.logTail) } : {}),
      ...(values.minFreeBytes ? { WORKER_MIN_FREE_BYTES: String(values.minFreeBytes) } : {}),
      ...(values.maxTargetBytes ? { WORKER_MAX_TARGET_BYTES: String(values.maxTargetBytes) } : {}),
      ...(values.outputLimit ? { WORKER_MAX_OUTPUT_CHARS: String(values.outputLimit) } : {}),
      WORKER_TERMINATION_GRACE_MS: "500",
      TEST_SUPER_SECRET: "must-not-reach-worker",
      CODEX_PERMISSION_PROFILE: ":danger-full-access",
      DEEPSEEK_API_KEY: "test-only-placeholder"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "qwen-worker-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function start(client, workspace, prompt, allowEdits = false) {
  return decode(
    await client.callTool({
      name: "run_deepseek_worker",
      arguments: { prompt, working_directory: workspace, allow_edits: allowEdits }
    })
  );
}

async function status(client, runId, timeoutSeconds = 5, afterOffset = 0) {
  return decode(
    await client.callTool({
      name: "wait_worker",
      arguments: {
        run_id: runId,
        timeout_seconds: timeoutSeconds,
        after_offset: afterOffset,
        max_chars: 100000
      }
    })
  );
}

async function waitTerminal(client, runId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await status(client, runId, 2);
    if (current.completion_marker) return current;
  }
  throw new Error(`run ${runId} did not become terminal`);
}

test("async run exposes heartbeat, incremental logs, and durable completion", async () => {
  const values = await fixture();
  const { client } = await connect(values);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    for (const expected of [
      "run_deepseek_worker",
      "worker_status",
      "wait_worker",
      "cancel_worker",
      "list_worker_runs"
    ]) {
      assert(names.includes(expected), `missing tool ${expected}`);
    }
    const startedAt = Date.now();
    const run = await start(client, values.workspace, "fast smoke");
    assert(Date.now() - startedAt < 1000, "run tool must return asynchronously");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.completion_marker, true);
    assert.match(terminal.log, /fake-start:fast smoke/);
    assert.match(terminal.log, /fake-finish:fast smoke/);
    const marker = JSON.parse(
      await readFile(path.join(values.runRoot, run.run_id, "completion.json"), "utf8")
    );
    assert.equal(marker.status, "completed");
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("truncated logs retain a bounded rolling tail with the final worker output", async () => {
  const values = { ...(await fixture()), logLimit: 1024, logTail: 2048 };
  const { client } = await connect(values);
  try {
    const run = await start(client, values.workspace, "huge output");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.log_truncated, true);
    assert.equal(Buffer.byteLength(terminal.log), 1024);
    assert.doesNotMatch(terminal.log, /final-tail-marker/);
    assert.match(terminal.log_tail, /final-tail-marker/);
    assert(terminal.log_tail_bytes <= values.logTail);
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("configured MCP output cap bounds each returned log chunk", async () => {
  const values = { ...(await fixture()), outputLimit: 500 };
  const { client } = await connect(values);
  try {
    const run = await start(client, values.workspace, "huge output");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "completed");
    assert(Buffer.byteLength(terminal.log) <= values.outputLimit);
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("worker reuses the workspace target with bounded Cargo profiles and managed temporary files", async () => {
  const values = await fixture();
  const { client } = await connect(values);
  try {
    const run = await start(client, values.workspace, "show-env");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "completed");
    const match = terminal.log.match(/worker-env:(\{[^\n]+\})/);
    assert(match, "worker must report its managed build environment");
    const environment = JSON.parse(match[1]);
    assert.equal(environment.cargoTarget, path.join(terminal.working_directory, "target"));
    assert.equal(environment.cargoIncremental, "0");
    assert.equal(environment.devDebug, "0");
    assert.equal(environment.testDebug, "0");
    assert.equal(environment.temp, path.join(values.runRoot, run.run_id, "tmp"));
    assert.equal(environment.secretLeak, null);
    assert.equal(environment.parentPermission, null);
    assert.equal(environment.sandbox, "danger-full-access");
    assert.match(terminal.log, /Never override CARGO_TARGET_DIR/);
    await assert.rejects(stat(environment.temp), error => error?.code === "ENOENT");
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("final worker result is independently capped", async () => {
  const values = { ...(await fixture()), outputLimit: 500 };
  const { client } = await connect(values);
  try {
    const run = await start(client, values.workspace, "long-final");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "completed");
    assert.equal(Array.from(terminal.worker_result).length, values.outputLimit);
    assert.equal(terminal.worker_result_truncated, true);
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("disk preflight refuses to launch below the configured reserve", async () => {
  const values = { ...(await fixture()), minFreeBytes: Number.MAX_SAFE_INTEGER };
  const { client } = await connect(values);
  try {
    const run = await start(client, values.workspace, "must-not-start");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "failed");
    assert.match(terminal.error, /disk safety preflight failed/);
    assert.doesNotMatch(terminal.log, /fake-start/);
    assert.equal(terminal.disk_min_free_bytes, Number.MAX_SAFE_INTEGER);
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("target-size preflight refuses to launch above the configured cap", async () => {
  const values = { ...(await fixture()), maxTargetBytes: 1024 * 1024 };
  await mkdir(path.join(values.workspace, "target"), { recursive: true });
  await writeFile(path.join(values.workspace, "target", "oversized.bin"), Buffer.alloc(2 * 1024 * 1024));
  const { client } = await connect(values);
  try {
    const run = await start(client, values.workspace, "must-not-start-target");
    const terminal = await waitTerminal(client, run.run_id);
    assert.equal(terminal.status, "failed");
    assert.match(terminal.error, /Cargo target size preflight failed/);
    assert.doesNotMatch(terminal.log, /fake-start/);
    assert(terminal.cargo_target_bytes > terminal.cargo_target_max_bytes);
    assert.equal(terminal.cargo_target_max_bytes, values.maxTargetBytes);
  } finally {
    await client.close();
    await values.cleanup();
  }
});

test("editing runs serialize per workspace and a running job can be cancelled", async () => {
  const values = await fixture();
  const { client } = await connect(values);
  try {
    const first = await start(client, values.workspace, "lock first", true);
    const second = await start(client, values.workspace, "lock second", true);
    let ownerRun = null;
    let queuedRun = null;
    // Runner startup includes real disk preflights and sandbox setup, which can
    // exceed two seconds on a loaded host. Give the lock state time to become
    // observable instead of turning host latency into a false negative.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [firstStatus, secondStatus] = await Promise.all(
        [first.run_id, second.run_id].map(async runId =>
          decode(
            await client.callTool({
              name: "worker_status",
              arguments: { run_id: runId, max_chars: 0 }
            })
          )
        )
      );
      if (firstStatus.queued_for_lock && firstStatus.lock_owner_run_id === second.run_id) {
        ownerRun = second;
        queuedRun = first;
        break;
      }
      if (secondStatus.queued_for_lock && secondStatus.lock_owner_run_id === first.run_id) {
        ownerRun = first;
        queuedRun = second;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ownerRun, "one editing run must own the workspace lock");
    assert(queuedRun, "the competing editing run must wait for that lock");
    const firstDone = await waitTerminal(client, first.run_id);
    const secondDone = await waitTerminal(client, second.run_id);
    assert.equal(firstDone.status, "completed");
    assert.equal(secondDone.status, "completed");
    const ownerDone = ownerRun.run_id === first.run_id ? firstDone : secondDone;
    const queuedDone = queuedRun.run_id === first.run_id ? firstDone : secondDone;
    assert(Date.parse(queuedDone.started_at) >= Date.parse(ownerDone.finished_at));

    const cancellable = await start(client, values.workspace, "cancel me", false);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = decode(
        await client.callTool({
          name: "worker_status",
          arguments: { run_id: cancellable.run_id, max_chars: 0 }
        })
      );
      if (current.status === "running") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    decode(
      await client.callTool({
        name: "cancel_worker",
        arguments: { run_id: cancellable.run_id }
      })
    );
    const cancelled = await waitTerminal(client, cancellable.run_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.completion_marker, true);

    const descendant = await start(client, values.workspace, "cancel descendant", false);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = decode(
        await client.callTool({
          name: "worker_status",
          arguments: { run_id: descendant.run_id, max_chars: 0 }
        })
      );
      if (current.status === "running") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    decode(
      await client.callTool({
        name: "cancel_worker",
        arguments: { run_id: descendant.run_id }
      })
    );
    const descendantCancelled = await waitTerminal(client, descendant.run_id);
    assert.equal(descendantCancelled.status, "cancelled");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await assert.rejects(
      stat(path.join(values.runRoot, descendant.run_id, "tmp", "descendant-marker")),
      error => error?.code === "ENOENT"
    );
  } finally {
    await client.close();
    await values.cleanup();
  }
});
