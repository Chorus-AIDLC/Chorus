import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const names = [
  "chorus_pm_submit_proposal", "chorus_submit_for_verify", "chorus_admin_verify_task",
  "chorus_submit_for_verify_extra", "chorus_get_task", "chorus_list_tasks",
  "chorus_list_projects", "chorus_add_comment", "chorus_checkin",
];

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "chorus-packed-compat-fixture", version: "1.0.0" } };
  } else if (request.method === "tools/list") {
    result = { tools: names.map((name) => ({ name, description: "Local compatibility fixture",
      inputSchema: { type: "object", properties: {
        fail: { type: "boolean" }, tool: { type: "string" }, marker: { type: "string" },
      }, additionalProperties: false } })) };
  } else if (request.method === "tools/call" && names.includes(request.params.name)) {
    appendFileSync(process.env.CHORUS_COMPAT_MCP_LOG, JSON.stringify({
      pid: process.pid, name: request.params.name, arguments: request.params.arguments,
    }) + "\n");
    result = { content: [{ type: "text", text: request.params.arguments?.fail
      ? "fixture failure" : "fixture success" }], isError: request.params.arguments?.fail === true };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "Unknown fixture method" } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
