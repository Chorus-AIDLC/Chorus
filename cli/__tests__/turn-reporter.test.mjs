// cli/__tests__/turn-reporter.test.mjs
// Covers the daemon → server turn-lifecycle reporter (子1 —
// daemon-session-conversation): REST POST to /api/daemon/turn-advance, Bearer auth,
// zero new deps, fire-and-forget never-throws.
import { describe, it, expect, vi } from "vitest";
import { createTurnReporter, TURN_STATUSES } from "../turn-reporter.mjs";

const silent = { info() {}, warn() {}, error() {} };

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

describe("createTurnReporter", () => {
  it("POSTs to /api/daemon/turn-advance with Bearer auth, connection + session + status", async () => {
    const fetchImpl = okFetch();
    const advance = createTurnReporter({
      url: "https://chorus.example.com/",
      apiKey: "cho_secret",
      getConnectionUuid: () => "conn-1",
      logger: silent,
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "running", entityType: "task", entityUuid: "task-9" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    // Trailing slash on the base url is normalized away.
    expect(endpoint).toBe("https://chorus.example.com/api/daemon/turn-advance");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cho_secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      connectionUuid: "conn-1",
      sessionId: "idea-1",
      status: "running",
      entityType: "task",
      entityUuid: "task-9",
    });
  });

  it("omits entityType/entityUuid when not both supplied (no partial linkage)", async () => {
    const fetchImpl = okFetch();
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: silent,
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "ended", entityType: "task" }); // entityUuid missing
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({ connectionUuid: "conn-1", sessionId: "idea-1", status: "ended" });
    expect(body).not.toHaveProperty("entityType");
  });

  it("skips (logged, no fetch) when the connection uuid is not known yet", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => null, // SSE handshake hasn't reported it
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "running" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/no connection uuid yet/);
  });

  it("refuses a bad status / missing sessionId (logged, no fetch)", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "pending-typo" });
    await advance({ sessionId: "", status: "running" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/bad sessionId\/status/);
  });

  it("never throws on a network error — logs and resolves", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const warns = [];
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    await expect(advance({ sessionId: "idea-1", status: "running" })).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/turn-advance request failed/);
  });

  it("logs a non-2xx response (no throw)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409 }));
    const warns = [];
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "ended" });
    expect(warns.join("")).toMatch(/turn-advance returned 409/);
  });

  it("TURN_STATUSES is the strict lifecycle set", () => {
    expect([...TURN_STATUSES].sort()).toEqual(["ended", "pending", "running"]);
  });
});
