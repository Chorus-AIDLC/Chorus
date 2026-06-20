// cli/__tests__/daemon-rest-client.test.mjs
// Covers the SHARED, host-agnostic daemon REST client (`cli/daemon-rest-client.mjs`) —
// the single source of truth for the `/api/daemon/*` payload shapes consumed by BOTH the
// chorus CLI daemon and the OpenClaw plugin. Two responsibilities are tested here:
//   1. PAYLOAD SHAPES — each operation hits the exact server endpoint, with Bearer auth,
//      the exact method, and the exact body the existing server route accepts.
//   2. ERROR SURFACING — a network error, a non-2xx response, an empty/bad body, or a
//      missing connectionUuid is LOGGED WITH CAUSE and SURFACED via the structured
//      result (`{ ok: false, error|skipped }`) — never swallowed into a silent success,
//      and never thrown (so a failed report can't crash the run).
import { describe, it, expect, vi } from "vitest";
import { createDaemonRestClient } from "../daemon-rest-client.mjs";

const silent = { info() {}, warn() {}, error() {} };

function okFetch(status = 200, jsonBody) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  }));
}

function makeClient(overrides = {}) {
  return createDaemonRestClient({
    url: "https://chorus.example.com/", // trailing slash exercised on purpose
    apiKey: "cho_secret",
    getConnectionUuid: () => "conn-1",
    logger: silent,
    fetchImpl: okFetch(),
    ...overrides,
  });
}

describe("createDaemonRestClient — payload shapes (single source of truth)", () => {
  it("turnAdvance POSTs the exact server contract with Bearer auth", async () => {
    const fetchImpl = okFetch();
    const client = makeClient({ fetchImpl });

    const result = await client.turnAdvance({
      sessionId: "idea-1",
      status: "running",
      entityType: "task",
      entityUuid: "task-9",
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    // Trailing slash on the base url is normalized away.
    expect(endpoint).toBe("https://chorus.example.com/api/daemon/turn-advance");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cho_secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      connectionUuid: "conn-1",
      sessionId: "idea-1",
      status: "running",
      entityType: "task",
      entityUuid: "task-9",
    });
  });

  it("turnAdvance omits entityType/entityUuid unless BOTH are present (no partial linkage)", async () => {
    const fetchImpl = okFetch();
    const client = makeClient({ fetchImpl });

    await client.turnAdvance({ sessionId: "idea-1", status: "ended", entityType: "task" }); // entityUuid missing
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({ connectionUuid: "conn-1", sessionId: "idea-1", status: "ended" });
    expect(body).not.toHaveProperty("entityType");
  });

  it("transcript POSTs { sessionId, messages } and needs no connectionUuid", async () => {
    const fetchImpl = okFetch();
    // No getConnectionUuid wired — transcript must still POST (agent key + sessionId
    // resolve the turn server-side).
    const client = createDaemonRestClient({
      url: "https://c",
      apiKey: "cho_x",
      logger: silent,
      fetchImpl,
    });

    const messages = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    const result = await client.transcript({ sessionId: "idea-1", messages });

    expect(result.ok).toBe(true);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("https://c/api/daemon/transcript");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cho_x");
    expect(JSON.parse(init.body)).toEqual({ sessionId: "idea-1", messages });
  });

  it("executionState POSTs { connectionUuid, executions } with the server snapshot shape", async () => {
    const fetchImpl = okFetch();
    const client = makeClient({ fetchImpl });

    const executions = [
      { entityType: "task", entityUuid: "task-1", rootIdeaUuid: "root-1", status: "running", startedAt: "2026-06-20T00:00:00.000Z" },
      { entityType: "task", entityUuid: "task-2", rootIdeaUuid: null, status: "queued", startedAt: null },
    ];
    const result = await client.executionState({ executions });

    expect(result.ok).toBe(true);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("https://chorus.example.com/api/daemon/execution-state");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ connectionUuid: "conn-1", executions });
  });

  it("reportInterrupt POSTs { connectionUuid, entityType, entityUuid, reason }", async () => {
    const fetchImpl = okFetch();
    const client = makeClient({ fetchImpl });

    const result = await client.reportInterrupt({
      entityType: "daemon_session",
      entityUuid: "sess-1",
      reason: "user",
    });

    expect(result.ok).toBe(true);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("https://chorus.example.com/api/daemon/report-interrupt");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cho_secret");
    expect(JSON.parse(init.body)).toEqual({
      connectionUuid: "conn-1",
      entityType: "daemon_session",
      entityUuid: "sess-1",
      reason: "user",
    });
  });

  it("readPendingTurns GETs ?connectionUuid=… (encoded) and returns the parsed turns", async () => {
    const turns = [
      { turnUuid: "t-1", sessionId: "idea-1", directIdeaUuid: "idea-1", trigger: "human_instruction", promptText: "do it" },
    ];
    const fetchImpl = okFetch(200, { success: true, data: { turns } });
    const client = makeClient({ fetchImpl, getConnectionUuid: () => "conn/1" });

    const result = await client.readPendingTurns();

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ turns });
    const [endpoint, init] = fetchImpl.mock.calls[0];
    // No explicit method on a GET; connectionUuid is URL-encoded.
    expect(endpoint).toBe("https://chorus.example.com/api/daemon/pending-turns?connectionUuid=conn%2F1");
    expect(init.method).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer cho_secret");
  });
});

describe("createDaemonRestClient — connectionUuid guards", () => {
  it("turnAdvance skips (logged, no fetch) without a connection uuid", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const client = makeClient({
      fetchImpl,
      getConnectionUuid: () => null,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    const result = await client.turnAdvance({ sessionId: "idea-1", status: "running" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(warns.join("")).toMatch(/no connection uuid yet/);
  });

  it("reportInterrupt skips (logged, no fetch) without a connection uuid", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const client = makeClient({
      fetchImpl,
      getConnectionUuid: () => null,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    const result = await client.reportInterrupt({ entityType: "task", entityUuid: "task-9", reason: "user" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(warns.join("")).toMatch(/no connection uuid yet/);
  });

  it("executionState skips silently (NOT an error) without a connection uuid", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const client = makeClient({
      fetchImpl,
      getConnectionUuid: () => null,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    const result = await client.executionState({ executions: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true });
    // A pre-handshake snapshot is a normal early state — no warn noise.
    expect(warns).toEqual([]);
  });

  it("readPendingTurns skips silently (NOT an error) without a connection uuid", async () => {
    const fetchImpl = okFetch(200, { success: true, data: { turns: [] } });
    const warns = [];
    const client = makeClient({
      fetchImpl,
      getConnectionUuid: () => null,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    const result = await client.readPendingTurns();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(warns).toEqual([]);
  });
});

describe("createDaemonRestClient — error surfacing (no silent errors)", () => {
  it("a network error is logged WITH cause and surfaced, never thrown", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const warns = [];
    const client = makeClient({ fetchImpl, logger: { ...silent, warn: (m) => warns.push(m) } });

    const promise = client.turnAdvance({ sessionId: "idea-1", status: "running" });
    await expect(promise).resolves.toBeTruthy(); // never rejects
    const result = await promise;
    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.error).toMatch(/turn-advance request failed/);
    expect(result.error).toMatch(/ECONNREFUSED/); // the underlying cause is preserved
    expect(warns.join("")).toMatch(/turn-advance request failed.*ECONNREFUSED/);
  });

  it("a non-2xx response is logged with its status and surfaced", async () => {
    const fetchImpl = okFetch(409);
    const warns = [];
    const client = makeClient({ fetchImpl, logger: { ...silent, warn: (m) => warns.push(m) } });

    const result = await client.turnAdvance({ sessionId: "idea-1", status: "ended" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.error).toMatch(/turn-advance returned 409/);
    expect(warns.join("")).toMatch(/turn-advance returned 409/);
  });

  it("each POST op uses its own log label on failure", async () => {
    const status = 404;
    const cases = [
      ["transcript", (c) => c.transcript({ sessionId: "s", messages: [{ role: "user", text: "x" }] }), /transcript upload returned 404/],
      ["executionState", (c) => c.executionState({ executions: [] }), /execution-state upload returned 404/],
      ["reportInterrupt", (c) => c.reportInterrupt({ entityType: "task", entityUuid: "t-1", reason: "crash" }), /report-interrupt returned 404/],
    ];
    for (const [, call, pattern] of cases) {
      const warns = [];
      const client = makeClient({ fetchImpl: okFetch(status), logger: { ...silent, warn: (m) => warns.push(m) } });
      const result = await call(client);
      expect(result).toMatchObject({ ok: false, status: 404 });
      expect(warns.join("")).toMatch(pattern);
    }
  });

  it("readPendingTurns surfaces a non-2xx with cause", async () => {
    const warns = [];
    const client = makeClient({ fetchImpl: okFetch(404), logger: { ...silent, warn: (m) => warns.push(m) } });
    const result = await client.readPendingTurns();
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(result.error).toMatch(/pending-turns backfill returned 404/);
    expect(warns.join("")).toMatch(/pending-turns backfill returned 404/);
    expect(result.data).toBeUndefined(); // no silent empty success
  });

  it("readPendingTurns surfaces a bad JSON body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }));
    const warns = [];
    const client = makeClient({ fetchImpl, logger: { ...silent, warn: (m) => warns.push(m) } });
    const result = await client.readPendingTurns();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/pending-turns backfill: bad JSON/);
    expect(warns.join("")).toMatch(/bad JSON/);
  });

  it("readPendingTurns surfaces a missing turns array (no silent empty result)", async () => {
    const warns = [];
    const client = makeClient({
      fetchImpl: okFetch(200, { success: true, data: {} }), // no turns
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    const result = await client.readPendingTurns();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/no turns array/);
    expect(warns.join("")).toMatch(/no turns array/);
    expect(result.data).toBeUndefined();
  });

  it("a network error never throws for ANY op (a failed report cannot crash the run)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = makeClient({ fetchImpl });
    await expect(client.turnAdvance({ sessionId: "s", status: "running" })).resolves.toBeTruthy();
    await expect(client.transcript({ sessionId: "s", messages: [{ role: "user", text: "x" }] })).resolves.toBeTruthy();
    await expect(client.executionState({ executions: [] })).resolves.toBeTruthy();
    await expect(client.reportInterrupt({ entityType: "task", entityUuid: "t", reason: "crash" })).resolves.toBeTruthy();
    await expect(client.readPendingTurns()).resolves.toBeTruthy();
  });
});
