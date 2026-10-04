// Local stdio MCP fixture. These names exercise hooks without changing Chorus state.
import { createInterface } from "node:readline";

const names = [
  "chorus_pm_submit_proposal",
  "chorus_submit_for_verify",
  "chorus_admin_verify_task",
  "chorus_submit_for_verify_extra",
  "chorus_get_task",
  "chorus_list_tasks",
  "chorus_list_projects",
  "chorus_add_comment",
];
const tools = names.map((name) => ({
  name,
  description: "Local reviewer-hook verification fixture",
  inputSchema: {
    type: "object",
    properties: { fail: { type: "boolean" }, tool: { type: "string" } },
    additionalProperties: false,
  },
}));

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "chorus-local-probe", version: "1.0.0" },
    };
  } else if (request.method === "tools/list") {
    result = { tools };
  } else if (request.method === "tools/call" && names.includes(request.params.name)) {
    const isError = request.params.arguments?.fail === true;
    result = {
      content: [{ type: "text", text: isError ? "fixture failure" : "fixture success" }],
      isError,
    };
  } else {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" },
    }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
