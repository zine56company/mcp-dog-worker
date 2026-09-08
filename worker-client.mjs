import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];
if (!command) {
  throw new Error("usage: worker-client.mjs <list|start|status|wait|cancel|runs> [arguments]");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function decode(result) {
  const block = result.content?.find(item => item.type === "text");
  if (!block) throw new Error("MCP tool returned no text result");
  return JSON.parse(block.text);
}

const transport = new StdioClientTransport({
  command: path.join(root, "start.sh"),
  stderr: "inherit"
});
const client = new Client({ name: "qwen-worker-local-client", version: "1.0.0" });
await client.connect(transport);

try {
  let result;
  if (command === "list") {
    result = (await client.listTools()).tools.map(tool => ({
      name: tool.name,
      description: tool.description
    }));
  } else if (command === "start") {
    const request = JSON.parse(await readStdin());
    const worker = request.worker ?? "deepseek";
    const tool = {
      deepseek: "run_deepseek_worker",
      glm: "run_glm_worker",
      cheap: "run_cheap_worker"
    }[worker];
    if (!tool) throw new Error(`unknown worker selection: ${worker}`);
    result = decode(
      await client.callTool({
        name: tool,
        arguments: {
          prompt: request.prompt,
          working_directory: request.working_directory,
          allow_edits: request.allow_edits
        }
      })
    );
  } else if (command === "status" || command === "wait") {
    const runId = process.argv[3];
    if (!runId) throw new Error(`${command} requires run_id`);
    const afterOffset = Number(process.argv[4] ?? 0);
    const timeoutSeconds = Number(process.argv[5] ?? 30);
    result = decode(
      await client.callTool({
        name: command === "wait" ? "wait_worker" : "worker_status",
        arguments: {
          run_id: runId,
          after_offset: afterOffset,
          max_chars: 100000,
          ...(command === "wait" ? { timeout_seconds: timeoutSeconds } : {})
        }
      })
    );
  } else if (command === "cancel") {
    const runId = process.argv[3];
    if (!runId) throw new Error("cancel requires run_id");
    result = decode(await client.callTool({ name: "cancel_worker", arguments: { run_id: runId } }));
  } else if (command === "runs") {
    result = decode(
      await client.callTool({
        name: "list_worker_runs",
        arguments: { limit: Number(process.argv[3] ?? 20) }
      })
    );
  } else if (command === "read-completion") {
    const runId = process.argv[3];
    if (!runId) throw new Error("read-completion requires run_id");
    result = JSON.parse(await readFile(path.join(root, "runs", runId, "completion.json"), "utf8"));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}
