import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

export const reviewOperations = ["chorus_get_task", "chorus_get_future_fixture", "chorus_list_tasks",
  "chorus_list_projects", "chorus_search", "chorus_checkin", "chorus_add_comment"];
export const workOperations = ["chorus_claim_task", "chorus_release_task", "chorus_update_task",
  "chorus_report_work", "chorus_report_criteria_self_check", "chorus_submit_for_verify",
  "chorus_session_checkin_task", "chorus_session_checkout_task"];
export const forbiddenOperations = ["chorus_admin_approve_proposal", "chorus_admin_verify_task",
  "chorus_mark_acceptance_criteria", "chorus_pm_create_idea", "chorus_create_session",
  "chorus_close_session", "chorus_submit_for_verify_extra", "mcp", "codemode"];
export const fixtureTools = [...reviewOperations, ...workOperations, ...forbiddenOperations].map((name) => ({
  name, description: `Loopback-only child role fixture: ${name}`,
  inputSchema: { type: "object", properties: { marker: { type: "string" }, fail: { type: "boolean" } },
    additionalProperties: false },
}));

export async function startFixture(networkLog, apiKey = "fixture-only") {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    appendFileSync(networkLog, JSON.stringify({ port: request.socket.localPort, method: request.method, path: request.url }) + "\n");
    try {
      assert.equal(request.url, "/api/mcp", "Only the isolated MCP endpoint is available");
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 204 : 405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body);
      requests.push({ method: rpc.method, params: rpc.params });
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (rpc.method === "initialize") {
        result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "chorus-child-loopback", version: "1.0.0" } };
      } else if (rpc.method === "tools/list") {
        assert.ok(rpc.params?.cursor === undefined || rpc.params.cursor === "second");
        result = rpc.params?.cursor === "second" ? { tools: fixtureTools.slice(5) }
          : { tools: fixtureTools.slice(0, 5), nextCursor: "second" };
      } else if (rpc.method === "tools/call") {
        assert.ok(fixtureTools.some((tool) => tool.name === rpc.params.name), rpc.params.name);
        const args = rpc.params.arguments ?? {};
        result = { content: [{ type: "text", text: args.fail ? "fixture-requested-failure" : JSON.stringify({
          fixture: true, operation: rpc.params.name, marker: args.marker,
          ...(rpc.params.name === "chorus_create_session" ? { uuid: "fixture-worker-session" } : {}),
        }) }], isError: args.fail === true };
      } else if (rpc.method === "ping") {
        result = {};
      } else {
        throw new Error(`Unexpected fixture RPC: ${rpc.method}`);
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  return { requests, errors, endpoint: `http://127.0.0.1:${server.address().port}/api/mcp`,
    close: () => new Promise((accept) => { server.close(accept); server.closeAllConnections(); }) };
}
