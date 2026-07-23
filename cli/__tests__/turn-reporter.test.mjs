// cli/__tests__/turn-reporter.test.mjs
// Covers the daemon → server turn-lifecycle reporter (子1 —
// daemon-session-conversation): REST POST to /api/daemon/turn-advance, Bearer auth,
// zero new deps, fire-and-forget never-throws.
import { describe, it, expect, vi } from "vitest";
import { createTurnReporter, TURN_STATUSES, TURN_INTERRUPT_REASONS } from "../turn-reporter.mjs";

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

  it("forwards transcriptRelayError into the POST body on a terminal edge (fix #444 follow-up)", async () => {
    // Guards the daemon→server hop end-to-end: the reporter MUST NOT drop the relay-error
    // field (an earlier version destructured only 5 fields, so it never reached the wire).
    const fetchImpl = okFetch();
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: silent,
      fetchImpl,
    });

    await advance({
      sessionId: "idea-1",
      status: "ended",
      transcriptRelayError: "transcript upload returned 502",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.transcriptRelayError).toBe("transcript upload returned 502");
  });

  it("omits transcriptRelayError from the body when null/absent (clean relay)", async () => {
    const fetchImpl = okFetch();
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: silent,
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "ended", transcriptRelayError: null });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("transcriptRelayError");
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
    expect([...TURN_STATUSES].sort()).toEqual(["ended", "interrupted", "pending", "running"]);
  });

  it("TURN_INTERRUPT_REASONS is the daemon-reportable subset (no offline)", () => {
    expect([...TURN_INTERRUPT_REASONS].sort()).toEqual(["crash", "shutdown", "user"]);
  });

  it("sends interruptedReason alongside status=interrupted", async () => {
    const fetchImpl = okFetch();
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: silent,
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "interrupted", interruptedReason: "shutdown" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      connectionUuid: "conn-1",
      sessionId: "idea-1",
      status: "interrupted",
      interruptedReason: "shutdown",
    });
  });

  it("refuses interruptedReason=offline (server-reconcile verdict) — logged, no fetch", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "interrupted", interruptedReason: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/bad interruptedReason/);
  });

  it("refuses an interruptedReason on a non-interrupted status — logged, no fetch", async () => {
    const fetchImpl = okFetch();
    const warns = [];
    const advance = createTurnReporter({
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    await advance({ sessionId: "idea-1", status: "ended", interruptedReason: "crash" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/bad interruptedReason/);
  });
});
