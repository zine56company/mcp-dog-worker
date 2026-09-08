import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import path from "node:path";

const CODEX = process.env.CODEX_BIN;
const WORKSPACE_ROOT = process.env.QWEN_WORKSPACE_ROOT;
const WORKER_CODEX_HOME = "/Users/ricardoadrianovandofuentealba/.local/share/qwen-worker-mcp/codex-home";
if (!CODEX || !WORKSPACE_ROOT) throw new Error("CODEX_BIN and QWEN_WORKSPACE_ROOT are required");

const resolvedRoot = await realpath(WORKSPACE_ROOT);
const resolvedTemp = await realpath(process.env.TMPDIR ?? "/tmp");
const writeQueues = new Map();
let nextCheapWorker = "deepseek";
const maxReportChars = 12000;

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

for (const name of ["FREETOKEN_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "DEEPSEEK_API_KEY", "PGS_API_KEY"]) {
  delete process.env[name];
}

const proxy = http.createServer((request, response) => {
  const upstream = Object.values(upstreams).find(candidate => request.url?.startsWith(`/${candidate.route}/`));
  if (!upstream) {
    response.writeHead(404).end();
    return;
  }

  const relativePath = request.url.slice(upstream.route.length + 2);
  const target = new URL(relativePath, upstream.baseUrl);
  const headers = { ...request.headers, host: target.host, authorization: `Bearer ${upstream.bearer}`, ...upstream.headers };
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
const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Failed to start credential proxy");

const protectedPaths = [
  { kind: "subpath", value: "/Users/ricardoadrianovandofuentealba/.config" },
  { kind: "literal", value: "/Users/ricardoadrianovandofuentealba/.codex/auth.json" },
  { kind: "subpath", value: "/Users/ricardoadrianovandofuentealba/.ssh" },
  { kind: "subpath", value: "/Users/ricardoadrianovandofuentealba/.aws" },
  { kind: "subpath", value: "/Users/ricardoadrianovandofuentealba/.gnupg" },
  { kind: "subpath", value: "/Users/ricardoadrianovandofuentealba/Library/Keychains" }
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
].map(name => path.join(WORKER_CODEX_HOME, name));
function createSeatbeltProfile(workingDirectory, allowEdits) {
  const writablePaths = ["/private/tmp", resolvedTemp, WORKER_CODEX_HOME];
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

function toolDefinition(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task for the delegated worker." },
        working_directory: { type: "string", description: "Workspace root approved for this router." },
        allow_edits: { type: "boolean", description: "False for analysis; true only for requested workspace changes." }
      },
      required: ["prompt", "working_directory", "allow_edits"],
      additionalProperties: false
    }
  };
}

async function validateWorkspace(candidate) {
  const resolved = await realpath(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("working_directory is outside the authorized workspace");
  }
  return resolved;
}

function executeCodex(worker, prompt, workingDirectory, allowEdits) {
  const workerConfig = {
    deepseek: { profile: "deepseek-worker", provider: "deepseek-worker" },
    glm: { profile: "glm-worker", provider: "phoenix-grove-worker" }
  }[worker];
  if (!workerConfig || !upstreams[worker]) throw new Error(`Worker ${worker} is not configured`);
  const { profile, provider } = workerConfig;
  const sandbox = "danger-full-access";
  const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}/${upstreams[worker].route}`;
  const args = [
    "exec",
    "--profile", profile,
    "--sandbox", sandbox,
    "--ignore-rules",
    "--skip-git-repo-check",
    "--config", `model_providers.${provider}.base_url=\"${proxyBaseUrl}\"`,
    "--cd", workingDirectory,
    prompt
  ];
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      CODEX_HOME: WORKER_CODEX_HOME,
      WORKER_PROXY_BEARER: "router-managed-placeholder",
      WORKER_PROXY_CF_ID: "router-managed-placeholder",
      WORKER_PROXY_CF_SECRET: "router-managed-placeholder"
    };
    const seatbeltProfile = createSeatbeltProfile(workingDirectory, allowEdits);
    const child = spawn("/usr/bin/sandbox-exec", ["-p", seatbeltProfile, CODEX, ...args], {
      cwd: workingDirectory,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      const concise = output.trim().slice(-maxReportChars) || "Worker completed without text output.";
      if (code === 0) resolve(concise);
      else reject(new Error(`worker exited with code ${code}: ${concise}`));
    });
  });
}

function serializeWrite(workspace, job) {
  const previous = writeQueues.get(workspace) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(job);
  writeQueues.set(workspace, current);
  return current.finally(() => {
    if (writeQueues.get(workspace) === current) writeQueues.delete(workspace);
  });
}

async function runWorker(worker, args) {
  if (!args || typeof args.prompt !== "string" || typeof args.working_directory !== "string" || typeof args.allow_edits !== "boolean") {
    throw new Error("prompt, working_directory, and allow_edits are required");
  }
  const workspace = await validateWorkspace(args.working_directory);
  const job = () => executeCodex(worker, args.prompt, workspace, args.allow_edits);
  const report = args.allow_edits ? await serializeWrite(workspace, job) : await job();
  return { content: [{ type: "text", text: `[worker: ${worker}]\n${report}` }] };
}

const server = new Server({ name: "qwen-worker-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    toolDefinition("run_cheap_worker", upstreams.glm ? "Runs DeepSeek V4 Flash and GLM 5.3 Flash in round-robin order." : "Runs the DeepSeek V4 Flash worker."),
    toolDefinition("run_deepseek_worker", "Runs the DeepSeek V4 Flash worker."),
    ...(upstreams.glm ? [toolDefinition("run_glm_worker", "Runs the Phoenix Grove GLM 5.3 Flash worker.")] : [])
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  let worker;
  if (name === "run_cheap_worker") {
    worker = upstreams.glm ? nextCheapWorker : "deepseek";
    if (upstreams.glm) nextCheapWorker = nextCheapWorker === "deepseek" ? "glm" : "deepseek";
  } else if (name === "run_deepseek_worker") worker = "deepseek";
  else if (name === "run_glm_worker" && upstreams.glm) worker = "glm";
  else throw new Error(`Unknown tool: ${name}`);
  return runWorker(worker, args);
});

await server.connect(new StdioServerTransport());
