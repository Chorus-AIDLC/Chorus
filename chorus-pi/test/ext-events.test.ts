// Extension-event tests for the session lifecycle in extensions/chorus.ts.
//
// These exercise the actual extension factory with a fake `pi` (handlers captured
// off pi.on) and a mocked global fetch (so mcpCall never hits the network). They
// cover the two P1 reviewer findings that need a runtime-event-level check:
//   P1-2: a successful subagent_spawn whose result shape neither extractor
//         recognizes must still close the orphan Chorus session (no leak).
//   P1-3: a failed chorus_close_session must NOT delete the agentId→sessionUuid
//         mapping, so session_shutdown can retry it (no permanent leak).
//
// Module-scope state (sessionMap / pendingSessions / spawnMapped) is reset
// between tests by invoking the session_shutdown handler, which clears all of
// them (mirroring what happens at real session end).

import { test, expect } from "bun:test";

// Set the connection env BEFORE importing the extension — the module reads
// process.env.CHORUS_URL / CHORUS_API_KEY at load time into frozen consts.
process.env.CHORUS_URL = "http://localhost:9999/api/mcp";
process.env.CHORUS_API_KEY = "cho_test_key";

// ─── fake fetch ────────────────────────────────────────────────────────────
// mcpCall issues three sequential fetches per tool call: initialize,
// notifications/initialized, tools/call. Route by JSON-RPC method and record
// the backend tool name of every tools/call so tests can assert on it.
let toolCalls: string[] = [];
// Per-tool-call result factory: map<toolName, () => JSON string of result.text>.
// Default returns {} (a close/session call with no payload). Tests override to
// make chorus_close_session fail (returning an MCP error).
let closeSessionResult: () => string = () => "{}";

function resetFetch(closeResult?: () => string): void {
  toolCalls = [];
  closeSessionResult = closeResult ?? (() => "{}");
}

const originalFetch = globalThis.fetch;
// Install the mock once for the whole file.
globalThis.fetch = (async (url: any, init: any) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (body.method === "initialize") {
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      status: 200,
      headers: { "mcp-session-id": "mcp-sess-1", "content-type": "application/json" },
    }) as unknown as Response;
  }
  if (body.method === "tools/call") {
    const name: string = body.params?.name ?? "";
    toolCalls.push(name);
    if (name === "chorus_close_session") {
      const text = closeSessionResult();
      // If the factory throws, surface a JSON-RPC error so mcpCall rejects.
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    if (name === "chorus_create_session") {
      const text = JSON.stringify({ uuid: "S-test-session" });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "{}" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ) as unknown as Response;
  }
  // notifications/initialized (no reply expected)
  return new Response("", { status: 200 }) as unknown as Response;
}) as any;

// ─── fake pi + load extension ───────────────────────────────────────────────
const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
const notifyMessages: { msg: string; level: string }[] = [];
const pi: any = {
  on: (ev: string, fn: (event: any, ctx: any) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
  sendUserMessage: () => {},
};
const ctx = {
  ui: {
    notify: (msg: string, level: string) => {
      notifyMessages.push({ msg, level });
    },
  },
  cwd: "/proj",
};

const ext = await import("../extensions/chorus.ts");
ext.default(pi);

// Reset module-scope state between tests by running the session_shutdown handler.
async function resetState(): Promise<void> {
  notifyMessages.length = 0;
  // Drain module-scope state first (close calls hit the current mock), THEN
  // reset the fetch mock + toolCalls so each test starts from a clean slate.
  if (handlers["session_shutdown"]) await handlers["session_shutdown"]({}, ctx);
  resetFetch();
}

// ─── P1-2: orphan session is closed when agentId extraction fails ─────────
test("P1-2: unknown spawn result shape closes the orphan session (no leak)", async () => {
  await resetState();
  // 1. tool_call(subagent_spawn, worker) → extension creates a session and
  //    stores its uuid in pendingSessions under the toolCallId.
  await handlers["tool_call"](
    { toolName: "subagent_spawn", toolCallId: "tc-1", input: { agent: "worker", task: "do work" } },
    ctx,
  );
  // create_session was called once (no close yet)
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);
  expect(toolCalls).not.toContain("chorus_close_session");

  // 2. tool_execution_end(subagent_spawn) with a result shape NEITHER extractor
  //    recognizes (no details.agent.id, no agentId, no sa_<uuid> in content).
  //    Before the fix the sid was dropped on the floor and leaked; after the fix
  //    the extension must close the orphan session immediately.
  await handlers["tool_execution_end"](
    {
      toolName: "subagent_spawn",
      toolCallId: "tc-1",
      isError: false,
      // An unknown structured shape — extractAgentId returns null on this.
      result: { weirdUnrecognizedShape: true, foo: { bar: 42 } },
    },
    ctx,
  );

  // The orphan session must have been closed.
  const closes = toolCalls.filter((t) => t === "chorus_close_session").length;
  expect(closes).toBeGreaterThanOrEqual(1);
  // A warning notification must be emitted explaining the orphan was closed.
  expect(notifyMessages.some((n) => n.level === "warning" && /closed the orphan/i.test(n.msg))).toBe(true);
});

// ─── P1-3: failed close retains the mapping for shutdown retry ─────────────
test("P1-3: failed chorus_close_session retains the mapping (retry on shutdown)", async () => {
  await resetState();

  // Make chorus_close_session return an MCP error so mcpCall rejects.
  resetFetch(() => {
    // Returning a body whose JSON-RPC `error` is set makes mcpCall throw.
    // But our fetch mock above always returns `result` — to force an error we
    // instead throw inside the factory, which the catch branch handles.
    throw new Error("transient network failure");
  });
  // Re-install the error behavior by overriding the mock locally:
  (globalThis as any).fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === "initialize") {
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { "mcp-session-id": "mcp-sess-1", "content-type": "application/json" },
      }) as unknown as Response;
    }
    if (body.method === "tools/call") {
      const name: string = body.params?.name ?? "";
      toolCalls.push(name);
      if (name === "chorus_close_session") {
        // Return a JSON-RPC error → mcpCall rejects → close "fails".
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "server boom" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as unknown as Response;
      }
      const text = name === "chorus_create_session" ? JSON.stringify({ uuid: "S-failclose" }) : "{}";
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    return new Response("", { status: 200 }) as unknown as Response;
  }) as any;

  // Establish a session + map agentId → sessionUuid via tool_result.
  await handlers["tool_call"](
    { toolName: "subagent_spawn", toolCallId: "tc-2", input: { agent: "worker", task: "do work" } },
    ctx,
  );
  await handlers["tool_result"](
    {
      toolName: "subagent_spawn",
      toolCallId: "tc-2",
      isError: false,
      details: { agent: { id: "sa_agentfail" } },
      input: { agent: "worker", task: "do work" },
    },
    ctx,
  );
  // Sanity: session mapped.
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);

  // Drive tool_execution_end so pendingSessions is drained (it sees spawnMapped
  // and early-returns, deleting the pending entry). Otherwise session_shutdown
  // would also iterate pendingSessions and double-close, masking the assertion.
  await handlers["tool_execution_end"](
    {
      toolName: "subagent_spawn",
      toolCallId: "tc-2",
      isError: false,
      result: { details: { agent: { id: "sa_agentfail" } } },
    },
    ctx,
  );

  const closeCountBefore = toolCalls.filter((t) => t === "chorus_close_session").length;


  // subagent_manage {action:"close"} with a FAILING close — must NOT delete mapping.
  await handlers["tool_result"](
    {
      toolName: "subagent_manage",
      toolCallId: "tc-3",
      isError: false,
      input: { action: "close", agentId: "sa_agentfail" },
    },
    ctx,
  );
  // The close attempt happened (and failed)...
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(closeCountBefore + 1);
  // ...and a warning was emitted (not a success info).
  expect(notifyMessages.some((n) => n.level === "warning" && /close failed/i.test(n.msg))).toBe(true);
  expect(notifyMessages.some((n) => n.level === "info" && /^Chorus: closed session/i.test(n.msg))).toBe(false);

  // Now run session_shutdown — because the mapping was RETAINED, shutdown must
  // retry chorus_close_session on the same session. If the mapping had been
  // deleted (the pre-fix behavior), shutdown would not call close again.
  // Switch the close back to success so shutdown's retry completes cleanly.
  (globalThis as any).fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === "initialize") {
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { "mcp-session-id": "mcp-sess-1", "content-type": "application/json" },
      }) as unknown as Response;
    }
    if (body.method === "tools/call") {
      const name: string = body.params?.name ?? "";
      toolCalls.push(name);
      const text = name === "chorus_create_session" ? JSON.stringify({ uuid: "S-x" }) : "{}";
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    return new Response("", { status: 200 }) as unknown as Response;
  }) as any;

  const closeBeforeShutdown = toolCalls.filter((t) => t === "chorus_close_session").length;
  await handlers["session_shutdown"]({}, ctx);
  // shutdown retried the close → one more chorus_close_session call.
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(closeBeforeShutdown + 1);

  // Restore the file-level default mock for subsequent tests.
  globalThis.fetch = originalFetch as any;
  (globalThis as any).fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === "initialize") {
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { "mcp-session-id": "mcp-sess-1", "content-type": "application/json" },
      }) as unknown as Response;
    }
    if (body.method === "tools/call") {
      const name: string = body.params?.name ?? "";
      toolCalls.push(name);
      const text = name === "chorus_create_session" ? JSON.stringify({ uuid: "S-test-session" }) : closeSessionResult();
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    return new Response("", { status: 200 }) as unknown as Response;
  }) as any;
});

// ─── P2-1: only workers get a session (scout/planner/reviewer do not) ───────
test("P2-1: non-worker agents (scout, planner, reviewer) do NOT create a session", async () => {
  await resetState();
  for (const agent of ["scout", "planner", "reviewer", "chorus-proposal-reviewer"]) {
    toolCalls = [];
    await handlers["tool_call"](
      { toolName: "subagent_spawn", toolCallId: `tc-${agent}`, input: { agent, task: "explore" } },
      ctx,
    );
    // No session created for a read-only / reviewer agent.
    expect(toolCalls).not.toContain("chorus_create_session");
  }
  // And a real worker DOES create one.
  toolCalls = [];
  await handlers["tool_call"](
    { toolName: "subagent_spawn", toolCallId: "tc-worker", input: { agent: "worker", task: "build" } },
    ctx,
  );
  expect(toolCalls).toContain("chorus_create_session");
});

test("P1-3 control: successful close deletes the mapping (no retry on shutdown)", async () => {
  await resetState();
  // Successful close path — after a successful close, session_shutdown should
  // NOT call close again (mapping was deleted).
  await handlers["tool_call"](
    { toolName: "subagent_spawn", toolCallId: "tc-ok", input: { agent: "worker", task: "work" } },
    ctx,
  );
  await handlers["tool_result"](
    {
      toolName: "subagent_spawn",
      toolCallId: "tc-ok",
      isError: false,
      details: { agent: { id: "sa_ok" } },
      input: { agent: "worker", task: "work" },
    },
    ctx,
  );
  // Drain pendingSessions via tool_execution_end (sees spawnMapped, early-returns,
  // deleting the pending entry) so session_shutdown only iterates sessionMap.
  await handlers["tool_execution_end"](
    {
      toolName: "subagent_spawn",
      toolCallId: "tc-ok",
      isError: false,
      result: { details: { agent: { id: "sa_ok" } } },
    },
    ctx,
  );
  await handlers["tool_result"](
    {
      toolName: "subagent_manage",
      toolCallId: "tc-ok-close",
      isError: false,
      input: { action: "close", agentId: "sa_ok" },
    },
    ctx,
  );
  // close succeeded once for the manage call.
  const closesAfterManage = toolCalls.filter((t) => t === "chorus_close_session").length;
  expect(closesAfterManage).toBe(1);
  expect(notifyMessages.some((n) => n.level === "info" && /^Chorus: closed session/i.test(n.msg))).toBe(true);

  await handlers["session_shutdown"]({}, ctx);
  // No additional close — mapping was deleted on success.
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(closesAfterManage);
});
