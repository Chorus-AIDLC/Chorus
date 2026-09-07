// Extension-event tests for the session lifecycle in extensions/chorus.ts,
// EPHEMERAL subagent model (official pi `subagent` tool).
//
// These exercise the actual extension factory with a fake `pi` (handlers captured
// off pi.on) and a mocked global fetch (so mcpCall never hits the network). The
// official subagent children are ephemeral (spawn → run → exit within one tool
// call), so the lifecycle is: create a Chorus session per WORKER task when the
// `subagent` tool call starts (tool_call, mutable input → inject the workflow),
// close it when the tool call returns (tool_result, tool_execution_end fallback).
//
// Coverage:
//   - worker dispatch creates + closes a session; the worker task is mutated
//     in place with the injected session workflow
//   - parallel dispatch creates one session per worker task and closes them all
//   - non-worker agents (scout/planner/reviewer/chorus-*-reviewer) get NO session
//   - a failed close is retained so session_shutdown retries it (no leak)
//   - tool_execution_end is an idempotent fallback close
//   - reviewer nudges still fire on chorus_submit_for_verify
//
// Module-scope state (callSessions) is reset between tests by invoking the
// session_shutdown handler, which clears it (mirroring real session end).

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
let sessionCounter = 0;
// Per-close result factory: default returns "{}" (success). Tests override to
// make chorus_close_session fail (by throwing → the fetch rejects → mcpCall fails).
let closeSessionResult: () => string = () => "{}";

function resetFetch(closeResult?: () => string): void {
  toolCalls = [];
  closeSessionResult = closeResult ?? (() => "{}");
}

const defaultFetchMock = async (_url: any, init: any) => {
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
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    if (name === "chorus_create_session") {
      const text = JSON.stringify({ uuid: `S-${++sessionCounter}` });
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
};

function installDefaultFetch(): void {
  globalThis.fetch = defaultFetchMock as any;
}
installDefaultFetch();

// ─── fake pi + load extension ───────────────────────────────────────────────
const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
const notifyMessages: { msg: string; level: string }[] = [];
const userMessages: string[] = [];
const eventBus: Record<string, (data: unknown) => void> = {};
const pi: any = {
  on: (ev: string, fn: (event: any, ctx: any) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
  events: {
    on: (name: string, fn: (data: unknown) => void) => {
      eventBus[name] = fn;
    },
    emit: () => {},
  },
  sendUserMessage: (msg: string) => {
    userMessages.push(msg);
  },
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

async function resetState(): Promise<void> {
  notifyMessages.length = 0;
  userMessages.length = 0;
  installDefaultFetch();
  if (handlers["session_shutdown"]) await handlers["session_shutdown"]({}, ctx);
  resetFetch();
}

// ─── worker dispatch: session created + task injected + closed ──────────────
test("worker subagent: session created on tool_call, task injected, closed on tool_result", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "build the thing" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-1", input }, ctx);

  // A session was created and the worker's task was mutated in place with the workflow.
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);
  expect(input.task).toContain("build the thing");
  expect(input.task).toContain("Chorus session (auto-injected");
  expect(input.task).toMatch(/Session UUID: S-\d+/);
  expect(toolCalls).not.toContain("chorus_close_session");

  // tool_result closes the ephemeral worker session.
  await handlers["tool_result"]({ toolName: "subagent", toolCallId: "tc-1", isError: false, input, content: [] }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
  expect(notifyMessages.some((n) => n.level === "info" && /^Chorus: closed session/i.test(n.msg))).toBe(true);

  // tool_execution_end is an idempotent no-op (entry already deleted on success).
  await handlers["tool_execution_end"]({ toolName: "subagent", toolCallId: "tc-1", isError: false, result: {} }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);

  // Nothing left for session_shutdown to close.
  await handlers["session_shutdown"]({}, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

// ─── parallel dispatch: one session per worker task, all closed ─────────────
test("parallel subagent: a session per worker task, all closed on tool_result", async () => {
  await resetState();
  const input: any = {
    tasks: [
      { agent: "worker", task: "task A" },
      { agent: "worker", task: "task B" },
    ],
  };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-par", input }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(2);
  expect(input.tasks[0].task).toContain("Session UUID:");
  expect(input.tasks[1].task).toContain("Session UUID:");

  await handlers["tool_result"]({ toolName: "subagent", toolCallId: "tc-par", isError: false, input, content: [] }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(2);
});

// ─── non-worker agents get NO session ───────────────────────────────────────
test("non-worker agents (scout, planner, reviewer, chorus-*-reviewer) do NOT create a session", async () => {
  await resetState();
  for (const agent of ["scout", "planner", "reviewer", "chorus-proposal-reviewer", "chorus-task-reviewer"]) {
    toolCalls = [];
    const input: any = { agent, task: "review or explore" };
    await handlers["tool_call"]({ toolName: "subagent", toolCallId: `tc-${agent}`, input }, ctx);
    expect(toolCalls).not.toContain("chorus_create_session");
    // The task must NOT be mutated for a non-worker.
    expect(input.task).toBe("review or explore");
  }
  // A real worker DOES create one.
  toolCalls = [];
  const wi: any = { agent: "worker", task: "build" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-w", input: wi }, ctx);
  expect(toolCalls).toContain("chorus_create_session");
});

// ─── mixed parallel: only worker tasks get a session ────────────────────────
test("mixed parallel: only worker tasks get a session (reviewer skipped)", async () => {
  await resetState();
  const input: any = {
    tasks: [
      { agent: "worker", task: "impl" },
      { agent: "chorus-task-reviewer", task: "review" },
    ],
  };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-mix", input }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);
  expect(input.tasks[0].task).toContain("Session UUID:"); // worker injected
  expect(input.tasks[1].task).toBe("review"); // reviewer untouched
  await handlers["tool_result"]({ toolName: "subagent", toolCallId: "tc-mix", isError: false, input, content: [] }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

// ─── failed close retained → session_shutdown retries (no leak) ─────────────
test("failed close is retained and retried on session_shutdown", async () => {
  await resetState();
  const closeUuids: string[] = [];
  try {
    // create ok; close FAILS (JSON-RPC error → mcpCall rejects).
    (globalThis as any).fetch = (async (_url: any, init: any) => {
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
          closeUuids.push(body.params?.arguments?.sessionUuid);
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "server boom" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ) as unknown as Response;
        }
        const text = name === "chorus_create_session" ? JSON.stringify({ uuid: "S-retain" }) : "{}";
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as unknown as Response;
      }
      return new Response("", { status: 200 }) as unknown as Response;
    }) as any;

    const input: any = { agent: "worker", task: "work" };
    await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-fail", input }, ctx);
    expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);

    // tool_result close fails → session retained.
    await handlers["tool_result"]({ toolName: "subagent", toolCallId: "tc-fail", isError: false, input, content: [] }, ctx);
    expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
    expect(notifyMessages.some((n) => n.level === "warning" && /close failed/i.test(n.msg))).toBe(true);
    expect(notifyMessages.some((n) => n.level === "info" && /^Chorus: closed session/i.test(n.msg))).toBe(false);

    // Switch close to success, then session_shutdown must retry the retained session.
    (globalThis as any).fetch = (async (_url: any, init: any) => {
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
        if (name === "chorus_close_session") closeUuids.push(body.params?.arguments?.sessionUuid);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "{}" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as unknown as Response;
      }
      return new Response("", { status: 200 }) as unknown as Response;
    }) as any;

    const before = toolCalls.filter((t) => t === "chorus_close_session").length;
    await handlers["session_shutdown"]({}, ctx);
    expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(before + 1);
    // both closes targeted the SAME retained session.
    expect(closeUuids).toEqual(["S-retain", "S-retain"]);
  } finally {
    installDefaultFetch();
  }
});

// ─── tool_execution_end fallback close when tool_result never fired ─────────
test("tool_execution_end closes the worker session if tool_result did not fire", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-onlyend", input }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);
  // Skip tool_result; only tool_execution_end fires.
  await handlers["tool_execution_end"]({ toolName: "subagent", toolCallId: "tc-onlyend", isError: false, result: {} }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

// ─── subagent error still closes the created session (no leak) ──────────────
test("subagent tool error still closes the worker session", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-err", input }, ctx);
  // tool_result with isError:true — sessions were created at start, must still close.
  await handlers["tool_result"]({ toolName: "subagent", toolCallId: "tc-err", isError: true, input, content: [] }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

// ─── reviewer nudges still fire on chorus_* submit/verify ───────────────────
test("reviewer nudge fires on chorus_submit_for_verify (direct mode)", async () => {
  await resetState();
  await handlers["tool_result"](
    { toolName: "chorus_submit_for_verify", toolCallId: "tc-verify", isError: false, input: {}, content: [] },
    ctx,
  );
  expect(userMessages.some((m) => /chorus-task-reviewer/.test(m))).toBe(true);
});

test("reviewer nudge fires on chorus_pm_submit_proposal via gateway (event.input.tool)", async () => {
  await resetState();
  await handlers["tool_result"](
    {
      toolName: "mcp",
      toolCallId: "tc-prop",
      isError: false,
      input: { tool: "chorus_chorus_pm_submit_proposal" },
      content: [],
    },
    ctx,
  );
  expect(userMessages.some((m) => /chorus-proposal-reviewer/.test(m))).toBe(true);
});

test("no nudge for a non-trigger chorus tool", async () => {
  await resetState();
  await handlers["tool_result"](
    { toolName: "chorus_get_task", toolCallId: "tc-get", isError: false, input: {}, content: [] },
    ctx,
  );
  expect(userMessages.length).toBe(0);
});

// ─── async (nicobailon pi-subagents) lifecycle ────────────────────

test("async subagent: session deferred on tool_result and closed on async-complete", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "do async work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-a1", input }, ctx);
  // tool_result carries details.asyncId → session NOT closed, moved to runIdToSid.
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-a1", isError: false, input, details: { asyncId: "RUN-A" }, content: [] },
    ctx,
  );
  expect(toolCalls).not.toContain("chorus_close_session");
  // async-complete closes it.
  eventBus["subagent:async-complete"]!({ runId: "RUN-A" });
  await new Promise((r) => setTimeout(r, 20));
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

test("async subagent: process-terminal also closes the deferred session", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "do async work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-a2", input }, ctx);
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-a2", isError: false, input, details: { asyncId: "RUN-B" }, content: [] },
    ctx,
  );
  eventBus["subagent:process-terminal"]!({ runId: "RUN-B" });
  await new Promise((r) => setTimeout(r, 20));
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

test("async subagent: duplicate events close only once", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "do async work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-a3", input }, ctx);
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-a3", isError: false, input, details: { asyncId: "RUN-C" }, content: [] },
    ctx,
  );
  eventBus["subagent:async-complete"]!({ runId: "RUN-C" });
  eventBus["subagent:process-terminal"]!({ runId: "RUN-C" });
  await new Promise((r) => setTimeout(r, 20));
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

test("manual session marker in task suppresses double injection", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "--- Chorus session (managed by main agent) ---\nSession UUID: 00000000-0000-0000-0000-000000000000\ndo work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-mk", input }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(0);
  expect(input.task).toContain("managed by main agent");
});

test("process-terminal closes via the {id} shape (runId absent)", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "do async work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-id", input }, ctx);
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-id", isError: false, input, details: { asyncId: "RUN-ID" }, content: [] },
    ctx,
  );
  eventBus["subagent:process-terminal"]!({ id: "RUN-ID" });
  await new Promise((r) => setTimeout(r, 20));
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(1);
});

test("async-complete ignores id-only payloads (runId must be present)", async () => {
  await resetState();
  const input: any = { agent: "worker", task: "do async work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-idonly", input }, ctx);
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-idonly", isError: false, input, details: { asyncId: "RUN-IO" }, content: [] },
    ctx,
  );
  eventBus["subagent:async-complete"]!({ id: "RUN-IO" });
  await new Promise((r) => setTimeout(r, 20));
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(0);
});

test("parallel async: one runId maps several session ids, all closed once", async () => {
  await resetState();
  const tasks = [
    { agent: "worker", task: "build a" },
    { agent: "worker", task: "build b" },
  ];
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-parasync", input: { tasks } }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(2);
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-parasync", isError: false, input: { tasks }, details: { asyncId: "RUN-PAR" }, content: [] },
    ctx,
  );
  expect(toolCalls).not.toContain("chorus_close_session");
  eventBus["subagent:async-complete"]!({ runId: "RUN-PAR" });
  await new Promise((r) => setTimeout(r, 20));
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBe(2);
});

test("parallel async: marker on one task suppresses only that session", async () => {
  await resetState();
  const tasks = [
    { agent: "worker", task: "--- Chorus session (managed by main agent) ---\nSession UUID: 00000000-0000-0000-0000-000000000000\ndo a" },
    { agent: "worker", task: "build b" },
  ];
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-parmix", input: { tasks } }, ctx);
  expect(toolCalls.filter((t) => t === "chorus_create_session").length).toBe(1);
});

test("async close failure is re-added and the shutdown sweep retries it", async () => {
  await resetState();
  const closeUuids: string[] = [];
  (globalThis as any).fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.method === "initialize") {
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200, headers: { "mcp-session-id": "mcp-sess-1", "content-type": "application/json" },
      }) as unknown as Response;
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 200 }) as unknown as Response;
    if (body.method === "tools/call") {
      const name: string = body.params?.name ?? "";
      toolCalls.push(name);
      if (name === "chorus_close_session") {
        closeUuids.push(body.params?.arguments?.sessionUuid);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "server boom" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ) as unknown as Response;
      }
      const text = name === "chorus_create_session" ? JSON.stringify({ uuid: "S-pfail" }) : "{}";
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response;
    }
    return new Response("", { status: 200 }) as unknown as Response;
  }) as any;
  const input: any = { agent: "worker", task: "do async work" };
  await handlers["tool_call"]({ toolName: "subagent", toolCallId: "tc-pfail", input }, ctx);
  await handlers["tool_result"](
    { toolName: "subagent", toolCallId: "tc-pfail", isError: false, input, details: { asyncId: "RUN-FAIL" }, content: [] },
    ctx,
  );
  eventBus["subagent:async-complete"]!({ runId: "RUN-FAIL" });
  await new Promise((r) => setTimeout(r, 20));
  expect(closeUuids.length).toBe(1); // attempted, failed
  // restore a working close and let the shutdown sweep retry the retained sid
  installDefaultFetch();
  await handlers["session_shutdown"]({}, ctx);
  expect(toolCalls.filter((t) => t === "chorus_close_session").length).toBeGreaterThan(1);
});
