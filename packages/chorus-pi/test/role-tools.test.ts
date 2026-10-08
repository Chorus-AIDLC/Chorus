import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import reviewProvider from "../lib/child-review.js";
import workProvider from "../lib/child-work.js";
import { isRoleToolAllowed, type ChorusRole } from "../lib/role-policy.js";
import { executeRoleTool, ROLE_TOOL_SCHEMA, type RoleToolInput } from "../lib/role-tools.js";

const workerOnly = ["chorus_claim_task", "chorus_release_task", "chorus_update_task", "chorus_report_work",
  "chorus_report_criteria_self_check", "chorus_submit_for_verify", "chorus_session_checkin_task", "chorus_session_checkout_task"];
const queries = ["chorus_get_task", "chorus_get_future_resource", "chorus_get_notifications", "chorus_list_tasks",
  "chorus_list_projects", "chorus_search", "chorus_checkin", "chorus_add_comment"];
const forbidden = ["chorus_admin_verify_task", "chorus_admin_approve_proposal", "chorus_pm_create_idea", "chorus_create_tasks",
  "chorus_create_session", "chorus_close_session", "chorus_list_sessions", "chorus_session_heartbeat", "mcp", "mcpScript",
  "tool_search", "codemode", "tools/call", "mcp__chorus__chorus_get_task", "chorus_get_", "chorus_get_task/evil", "chorus_get_task\n"];

function fixture() {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const names = [...queries, ...workerOnly, ...forbidden];
  const schemas = names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: { uuid: { type: "string" } } } }));
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    calls.push(body);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? {} : body.method === "tools/list"
      ? body.params?.cursor ? { tools: schemas.slice(5) } : { tools: schemas.slice(0, 5), nextCursor: "second" }
      : { content: [{ type: "text", text: "accepted" }, { type: "image", data: "base64", mimeType: "image/png" },
        { type: "resource_link", uri: "chorus://task/1", name: "task" }], structuredContent: { task: "1" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, schemas, config: { url: "http://localhost:9999", apiKey: "cho_role_fixture", fetch: fetcher } };
}

test("role policy permits broad queries and exactly eight worker additions", () => {
  for (const role of ["reviewer", "worker"] as const) {
    for (const name of queries) expect(isRoleToolAllowed(role, name)).toBe(true);
    for (const name of forbidden) expect(isRoleToolAllowed(role, name)).toBe(false);
    for (const name of workerOnly) expect(isRoleToolAllowed(role, name)).toBe(role === "worker");
  }
  expect(isRoleToolAllowed("admin" as ChorusRole, "chorus_checkin")).toBe(false);
});

for (const role of ["reviewer", "worker"] as const) {
  test(`${role} discovery returns only actual allowed schemas across all pages`, async () => {
    const { config, schemas, calls } = fixture();
    const result = await executeRoleTool(role, { action: "discover" }, config);
    const expected = schemas.filter((tool) => isRoleToolAllowed(role, tool.name));
    expect(JSON.parse(result.content[0].text!)).toEqual({ tools: expected });
    expect(result.details).toEqual({ tools: expected });
    expect(calls.filter((call) => call.method === "tools/list")).toHaveLength(2);
    const filtered = await executeRoleTool(role, { action: "discover", tool: "chorus_get_task" }, config);
    expect(JSON.parse(filtered.content[0].text!).tools).toEqual([schemas[0]]);
    const unavailable = await executeRoleTool(role, { action: "discover", tool: "chorus_get_not_installed" }, config);
    expect(JSON.parse(unavailable.content[0].text!).tools).toEqual([]);
  });

  test(`${role} forbidden operations fail before even initialization`, async () => {
    const { config, calls } = fixture();
    for (const tool of [...forbidden, ...(role === "reviewer" ? workerOnly : [])]) {
      for (const action of ["call", "discover"] as const) {
        await expect(executeRoleTool(role, { action, tool }, config)).rejects.toThrow("not allowed");
      }
    }
    expect(calls).toHaveLength(0);
  });
}

test("worker operations forward real arguments and preserve text, image, resource and structured content", async () => {
  const { config, calls } = fixture();
  for (const tool of workerOnly) {
    const result = await executeRoleTool("worker", { action: "call", tool, arguments: { taskUuid: "task", sessionUuid: "session" } }, config);
    expect(result.content[0]).toEqual({ type: "text", text: "accepted" });
    expect(result.content[1]).toEqual({ type: "image", data: "base64", mimeType: "image/png" });
    expect(JSON.parse(result.content[2].text!)).toEqual({ type: "resource_link", uri: "chorus://task/1", name: "task" });
    expect(result.details).toHaveProperty("structuredContent", { task: "1" });
    expect(calls.at(-1)?.params).toEqual({ name: tool, arguments: { taskUuid: "task", sessionUuid: "session" } });
  }
});

test("invalid input and cancellation fail visibly", async () => {
  const { config, calls } = fixture();
  for (const input of [{ action: "other" }, { action: "call" }, { action: "call", tool: "chorus_checkin", arguments: [] }]) {
    await expect(executeRoleTool("reviewer", input as RoleToolInput, config)).rejects.toThrow();
  }
  await expect(executeRoleTool("reviewer", { action: "discover" }, config, AbortSignal.abort())).rejects.toThrow("aborted");
  expect(calls).toHaveLength(0);
});

test("providers register stable tools with the common Pi API even without configuration", async () => {
  const definitions: ToolDefinition[] = [];
  const pi = { registerTool: (tool: ToolDefinition) => definitions.push(tool) } as unknown as ExtensionAPI;
  reviewProvider(pi);
  workProvider(pi);
  expect(definitions.map((tool) => tool.name)).toEqual(["chorus_review", "chorus_work"]);
  for (const definition of definitions) expect(definition.parameters).toEqual(ROLE_TOOL_SCHEMA);
  await expect(executeRoleTool("reviewer", { action: "discover" }, { url: "", apiKey: "" })).rejects.toThrow("CHORUS_URL and CHORUS_API_KEY");
});

test("registered providers execute with existing env config and never write configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chorus-role-tools-"));
  const originalEnv = { CHORUS_URL: process.env.CHORUS_URL, CHORUS_API_KEY: process.env.CHORUS_API_KEY,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const originalFetch = globalThis.fetch;
  const { config, calls } = fixture();
  try {
    process.env.PI_CODING_AGENT_DIR = directory;
    delete process.env.CHORUS_URL;
    delete process.env.CHORUS_API_KEY;
    globalThis.fetch = config.fetch;
    const definitions: ToolDefinition[] = [];
    const pi = { registerTool: (tool: ToolDefinition) => definitions.push(tool) } as unknown as ExtensionAPI;
    reviewProvider(pi);
    workProvider(pi);
    for (const definition of definitions) {
      await expect(definition.execute("call", { action: "discover" }, undefined, undefined, { cwd: directory } as never)).rejects.toThrow("not configured");
    }
    expect(calls).toHaveLength(0);
    process.env.CHORUS_URL = config.url;
    process.env.CHORUS_API_KEY = config.apiKey;
    const result = await definitions[0].execute("call", { action: "call", tool: "chorus_add_comment", arguments: { content: "VERDICT: PASS" } }, undefined, undefined, { cwd: directory } as never);
    expect(result.content[0]).toEqual({ type: "text", text: "accepted" });
    expect(calls.at(-1)?.params).toEqual({ name: "chorus_add_comment", arguments: { content: "VERDICT: PASS" } });
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the installed Pi argument validator accepts the provider's plain JSON schema", async () => {
  const sdkDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { validateToolArguments } = await import(Bun.resolveSync("@earendil-works/pi-ai", sdkDirectory));
  const tool = { name: "chorus_review", parameters: ROLE_TOOL_SCHEMA };
  expect(validateToolArguments(tool, { name: tool.name, arguments: { action: "discover" } })).toEqual({ action: "discover" });
  const call = { action: "call", tool: "chorus_add_comment", arguments: { content: "VERDICT: PASS", extra: { nested: true } } };
  expect(validateToolArguments(tool, { name: tool.name, arguments: call })).toEqual(call);
  expect(() => validateToolArguments(tool, { name: tool.name, arguments: { action: "anything" } })).toThrow();
});

test("role tools propagate backend errors rather than return success-shaped details", async () => {
  const { config } = fixture();
  const fetcher = (async (url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.method !== "tools/call") return config.fetch(url, init);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Permission denied" }] } }));
  }) as typeof fetch;
  await expect(executeRoleTool("worker", { action: "call", tool: "chorus_submit_for_verify" }, { ...config, fetch: fetcher })).rejects.toThrow("Permission denied");
});
