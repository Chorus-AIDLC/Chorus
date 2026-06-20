import { describe, it, expect, vi } from "vitest";
import { createDaemonRestClient } from "../daemon-rest-client.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A fetch fake that records calls and returns a configurable response. */
function makeFetch(impl?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (impl) return impl(url, init);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const BASE = { url: "https://chorus.example.com/", apiKey: "cho_test" };

describe("createDaemonRestClient — payload shapes (single source of truth)", () => {
  it("turnAdvance POSTs { connectionUuid, sessionId, status } + entity link + Bearer auth", async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = createDaemonRestClient({
      ...BASE,
      getConnectionUuid: () => "conn-1",
      fetchImpl,
      logger: makeLogger(),
    });
    const res = await client.turnAdvance({
      sessionId: "idea-9",
      status: "running",
      entityType: "task",
      entityUuid: "task-3",
    });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://chorus.example.com/api/daemon/turn-advance");
    expect((calls[0].init as RequestInit).method).toBe("POST");
    const headers = (calls[0].init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cho_test");
    expect(JSON.parse((calls[0].init as RequestInit).body as string)).toEqual({
      connectionUuid: "conn-1",
      sessionId: "idea-9",
      status: "running",
      entityType: "task",
      entityUuid: "task-3",
    });
  });

  it("turnAdvance omits the entity link when either field is missing", async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "conn-1", fetchImpl });
    await client.turnAdvance({ sessionId: "s", status: "ended" });
    expect(JSON.parse((calls[0].init as RequestInit).body as string)).toEqual({
      connectionUuid: "conn-1",
      sessionId: "s",
      status: "ended",
    });
  });

  it("transcript POSTs { sessionId, messages } and needs no connectionUuid", async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => null, fetchImpl });
    const res = await client.transcript({
      sessionId: "idea-9",
      messages: [{ role: "assistant", text: "hi" }],
    });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://chorus.example.com/api/daemon/transcript");
    expect(JSON.parse((calls[0].init as RequestInit).body as string)).toEqual({
      sessionId: "idea-9",
      messages: [{ role: "assistant", text: "hi" }],
    });
  });

  it("executionState POSTs { connectionUuid, executions } in the server row shape", async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "conn-1", fetchImpl });
    await client.executionState({
      executions: [
        { entityType: "task", entityUuid: "task-3", rootIdeaUuid: "idea-root", status: "running", startedAt: "2026-06-20T00:00:00Z" },
      ],
    });
    expect(calls[0].url).toBe("https://chorus.example.com/api/daemon/execution-state");
    expect(JSON.parse((calls[0].init as RequestInit).body as string)).toEqual({
      connectionUuid: "conn-1",
      executions: [
        { entityType: "task", entityUuid: "task-3", rootIdeaUuid: "idea-root", status: "running", startedAt: "2026-06-20T00:00:00Z" },
      ],
    });
  });

  it("reportInterrupt POSTs { connectionUuid, entityType, entityUuid, reason }", async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "conn-1", fetchImpl });
    await client.reportInterrupt({ entityType: "task", entityUuid: "task-3", reason: "user" });
    expect(calls[0].url).toBe("https://chorus.example.com/api/daemon/report-interrupt");
    expect(JSON.parse((calls[0].init as RequestInit).body as string)).toEqual({
      connectionUuid: "conn-1",
      entityType: "task",
      entityUuid: "task-3",
      reason: "user",
    });
  });

  it("readPendingTurns GETs ?connectionUuid=… and unwraps { data: { turns } }", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      new Response(JSON.stringify({ success: true, data: { turns: [{ turnUuid: "t1", sessionId: "s", directIdeaUuid: null, trigger: "human_instruction", promptText: "do it" }] } }), { status: 200 }),
    );
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "conn-1", fetchImpl });
    const res = await client.readPendingTurns();
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://chorus.example.com/api/daemon/pending-turns?connectionUuid=conn-1");
    expect(res.data?.turns[0].turnUuid).toBe("t1");
  });
});

describe("createDaemonRestClient — no-silent-errors + connectionUuid guard", () => {
  it("skips connection-scoped ops (and logs turnAdvance/reportInterrupt) when no connection uuid", async () => {
    const { fetchImpl, calls } = makeFetch();
    const logger = makeLogger();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => null, fetchImpl, logger });

    const ta = await client.turnAdvance({ sessionId: "s", status: "running" });
    const es = await client.executionState({ executions: [] });
    const ri = await client.reportInterrupt({ entityType: "task", entityUuid: "t", reason: "crash" });
    const pt = await client.readPendingTurns();

    expect(ta.skipped).toBe(true);
    expect(es.skipped).toBe(true);
    expect(ri.skipped).toBe(true);
    expect(pt.skipped).toBe(true);
    expect(calls.length).toBe(0); // no HTTP issued
    // turnAdvance + reportInterrupt log their skip (an unexpected absence); executionState
    // + readPendingTurns skip silently (a normal early state).
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no connection uuid yet"));
  });

  it("surfaces a non-2xx with status (logged, not swallowed) and never rejects", async () => {
    const { fetchImpl } = makeFetch(() => new Response("nope", { status: 500 }));
    const logger = makeLogger();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "c", fetchImpl, logger });
    const res = await client.turnAdvance({ sessionId: "s", status: "running" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("turn-advance returned 500"));
  });

  it("surfaces a network error with cause (logged) and never rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const logger = makeLogger();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "c", fetchImpl, logger });
    const res = await client.transcript({ sessionId: "s", messages: [{ role: "user", text: "x" }] });
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("transcript upload request failed"));
  });

  it("surfaces a missing turns array as a failure (no silent empty success)", async () => {
    const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
    const logger = makeLogger();
    const client = createDaemonRestClient({ ...BASE, getConnectionUuid: () => "c", fetchImpl, logger });
    const res = await client.readPendingTurns();
    expect(res.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no turns array"));
  });
});
