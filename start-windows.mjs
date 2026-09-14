import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`mcp-dog-worker: ${name} requires a value`);
  return value;
}

function loadEnvironmentFile(file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`mcp-dog-worker: external environment file not found: ${file}`);
  }
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("mcp-dog-worker: invalid environment line (expected NAME=value)");
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("mcp-dog-worker: invalid environment variable name");
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

function findNativeCodex() {
  const packageRoot = path.join(
    process.env.APPDATA ?? "",
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules"
  );
  const pending = [{ directory: packageRoot, depth: 0 }];
  const candidates = [];
  while (pending.length > 0) {
    const { directory, depth } = pending.pop();
    if (depth > 6 || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push({ directory: target, depth: depth + 1 });
      else if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") candidates.push(target);
    }
  }
  candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

const envFile = option("--env-file") ??
  process.env.MCP_DOG_ENV_FILE ??
  path.join(process.env.USERPROFILE ?? "", ".config", "mcp-dog-worker", ".env");
loadEnvironmentFile(path.resolve(envFile));

if (!process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_TOKEN_API) {
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_TOKEN_API;
}
delete process.env.DEEPSEEK_TOKEN_API;
if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error("mcp-dog-worker: DEEPSEEK_API_KEY or DEEPSEEK_TOKEN_API is required");
}

const workspace = option("--workspace-root") ??
  process.env.MCP_DOG_WORKSPACE_ROOT ??
  process.env.QWEN_WORKSPACE_ROOT;
if (!workspace) throw new Error("mcp-dog-worker: pass --workspace-root or set QWEN_WORKSPACE_ROOT");
process.env.QWEN_WORKSPACE_ROOT = path.resolve(workspace);
process.env.WORKER_MAX_OUTPUT_CHARS ||= "500";

process.env.CODEX_BIN ||= findNativeCodex() ?? "";
if (!process.env.CODEX_BIN || !existsSync(process.env.CODEX_BIN)) {
  throw new Error("mcp-dog-worker: native codex.exe not found; set CODEX_BIN in the external environment file");
}
if (path.extname(process.env.CODEX_BIN).toLowerCase() !== ".exe") {
  throw new Error("mcp-dog-worker: CODEX_BIN must point to native codex.exe on Windows");
}
if (!existsSync(path.join(root, "codex-home", "deepseek-worker.config.toml"))) {
  throw new Error("mcp-dog-worker: runtime config missing; run setup.ps1 first");
}

await import("./router-v2.mjs");
