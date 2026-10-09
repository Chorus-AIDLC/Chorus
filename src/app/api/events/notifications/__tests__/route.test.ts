import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();

const mockEventBus = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
}));

const mockParseSelfReport = vi.fn();
const mockRegisterConnection = vi.fn();
const mockTouchConnection = vi.fn();
const mockMarkDisconnected = vi.fn();
const mockReconcileOrphanTurns = vi.fn();
const mockCanAgentReceiveTurn = vi.fn();
const mockGetWakeRecoveryDelivery = vi.fn();
const mockCanActorAccessProject = vi.fn();
vi.mock("@/services/project-access.service", () => ({
  canActorAccessProject: (...args: unknown[]) => mockCanActorAccessProject(...args),
  membershipPrincipal: (auth: { ownerUuid?: string; actorUuid: string; type: string }) =>
    auth.type === "user" ? auth.actorUuid : auth.ownerUuid,
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/lib/event-bus", () => ({
  eventBus: mockEventBus,
  // The route now also imports the per-connection control channel namer; provide
  // the real string contract so the test asserts the exact `control:{uuid}` key.
  controlEventName: (connectionUuid: string) => `control:${connectionUuid}`,
}));

vi.mock("@/services/daemon-connection.service", () => ({
  parseSelfReport: (...args: unknown[]) => mockParseSelfReport(...args),
  registerConnection: (...args: unknown[]) => mockRegisterConnection(...args),
  // Faithful re-implementation of the real guard: a conflict result carries a
  // `conflict` key (the route uses it to skip the per-connection lifecycle).
  isConnectionConflict: (result: unknown) =>
    result !== null && typeof result === "object" && "conflict" in (result as object),
  touchConnection: (...args: unknown[]) => mockTouchConnection(...args),
  markDisconnected: (...args: unknown[]) => mockMarkDisconnected(...args),
  STALE_THRESHOLD_MS: 90_000,
}));

// The route now defers an orphan-turn reconcile by the staleness window on abort.
// Mock the session service so this stays a unit test.
vi.mock("@/services/daemon-session.service", () => ({
  reconcileOrphanTurns: (...args: unknown[]) => mockReconcileOrphanTurns(...args),
  canAgentReceiveTurn: (...args: unknown[]) => mockCanAgentReceiveTurn(...args),
  getWakeRecoveryDelivery: (...args: unknown[]) => mockGetWakeRecoveryDelivery(...args),
}));
vi.mock("@/services/daemon-execution.service", () => ({
  reconcileOffline: vi.fn(async () => 0), publishExecutionChange: vi.fn(async () => undefined),
}));

import { GET } from "@/app/api/events/notifications/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const actorUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
// registerConnection now returns a {uuid, connectedAt} handle (the connectedAt
// is a generation fence); touch/markDisconnected receive the whole handle.
const connHandle = { uuid: connectionUuid, connectedAt: new Date("2026-06-15T03:00:00.000Z") };

const agentAuth = { type: "agent", companyUuid, actorUuid, permissions: [] };

function makeRequest(query = "", signal?: AbortSignal): NextRequest {
  const url = `http://localhost:3000/api/events/notifications${query ? `?${query}` : ""}`;
  return new NextRequest(new URL(url), signal ? { signal } : undefined);
}

async function startStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // reader cancelled / stream closed
    }
  })();
  await flush();
  return { chunks, reader };
}

/**
 * Drain the microtask queue so enqueued stream chunks are read by the pump.
 * Microtask-only (no setTimeout) so it works under vi.useFakeTimers().
 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockParseSelfReport.mockReturnValue({ clientType: "openclaw", host: "h" });
  mockRegisterConnection.mockResolvedValue(connHandle);
  mockCanActorAccessProject.mockResolvedValue(true);
  mockCanAgentReceiveTurn.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wake recovery SSE wire", () => {
  const context = { version: 1, notificationUuid: "source", notification: { uuid: "source", action: "mentioned" } };
  const event = { type: "new_notification", turnUuid: "turn", notificationUuid: "source", wakeContext: context, projectUuid: "project" };
  it("advertises v1 and projects freshly authorized persisted identity on both channels", async () => {
    const abort = new AbortController();
    const response = await GET(makeRequest("clientType=codex&wakeRecoveryProtocol=1", abort.signal));
    const { chunks } = await startStream(response);
    mockGetWakeRecoveryDelivery.mockResolvedValue({ turnUuid: "turn", wakeContext: context, targetConnectionUuid: connectionUuid, runtimeCwd: "/fixture" });
    const handler = mockEventBus.on.mock.calls.find(([channel]) => channel === `notification:agent:${actorUuid}`)![1];
    const control = mockEventBus.on.mock.calls.find(([channel]) => channel === `control:${connectionUuid}`)![1];
    handler(event);
    control({ type: "control", command: "deliver_turn", turnUuid: "turn" });
    await flush();
    await flush();
    const events = chunks.join("").split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    expect(events[0]).toMatchObject({ type: "connection_registered", wakeRecoveryProtocol: 1 });
    expect(events.slice(1)).toHaveLength(2);
    for (const delivered of events.slice(1)) expect(delivered).toMatchObject({ turnUuid: "turn", wakeContext: context, targetConnectionUuid: connectionUuid });
    expect(mockGetWakeRecoveryDelivery).toHaveBeenCalledWith(companyUuid, actorUuid, connectionUuid, "turn");
    abort.abort();
  });

  it("withholds inaccessible/stale-origin contexts and suppresses unpersisted wakes", async () => {
    const abort = new AbortController();
    const response = await GET(makeRequest("clientType=codex&wakeRecoveryProtocol=1", abort.signal));
    const { chunks } = await startStream(response);
    mockGetWakeRecoveryDelivery.mockResolvedValue(null);
    const handler = mockEventBus.on.mock.calls.find(([channel]) => channel === `notification:agent:${actorUuid}`)![1];
    handler(event);
    handler({ type: "new_notification", notificationUuid: "no-turn", action: "mentioned" });
    await flush();
    await flush();
    expect(chunks.join("")).not.toContain('"notificationUuid":"source"');
    expect(chunks.join("")).toContain('"suppressWake":true');
    expect(chunks.join("")).toContain('"wakeContext":null');
    abort.abort();
  });

  it("strips new recovery fields and secondary batch events from legacy streams", async () => {
    const abort = new AbortController();
    const response = await GET(makeRequest("clientType=codex", abort.signal));
    const { chunks } = await startStream(response);
    const handler = mockEventBus.on.mock.calls.find(([channel]) => channel === `notification:agent:${actorUuid}`)![1];
    handler(event);
    handler({ ...event, notificationUuid: "second", wakeRecoveryOnly: true });
    await flush();
    await flush();
    expect(chunks.join("")).toContain('"notificationUuid":"source"');
    expect(chunks.join("")).not.toContain('"wakeContext"');
    expect(chunks.join("")).not.toContain('"turnUuid"');
    expect(chunks.join("")).not.toContain('"second"');
    abort.abort();
  });

  it("rejects unknown protocol versions before registering a connection", async () => {
    const response = await GET(makeRequest("clientType=codex&wakeRecoveryProtocol=2"));
    expect(response.status).toBe(400);
    expect(mockRegisterConnection).not.toHaveBeenCalled();
  });
});

describe("GET /api/events/notifications (notification SSE)", () => {
  it("freshly withholds delayed notifications for a revoked project recipient", async () => {
    const ac = new AbortController();
    const { chunks } = await startStream(await GET(makeRequest("", ac.signal)));
    const handler = mockEventBus.on.mock.calls.find(([channel]) => String(channel).startsWith("notification:"))![1];
    mockCanActorAccessProject.mockResolvedValue(false);
    handler({ type: "new_notification", projectUuid: "secret", entityTitle: "Hidden title" });
    await flush();
    expect(chunks.join("")).not.toContain("Hidden title");
    expect(mockCanActorAccessProject).toHaveBeenCalledWith(companyUuid, { type: "agent", uuid: actorUuid }, "secret", "viewer");
    ac.abort();
  });

  it("rechecks a grant removal while a notification authorization query is pending", async () => {
    mockGetAuthContext.mockResolvedValue({ ...agentAuth, ownerUuid: "owner" });
    const ac = new AbortController();
    const { chunks } = await startStream(await GET(makeRequest("", ac.signal)));
    const handler = mockEventBus.on.mock.calls.find(([channel]) => String(channel).startsWith("notification:"))![1];
    const changed = mockEventBus.on.mock.calls.find(([channel]) => channel === "project_access_changed")![1];
    let release!: () => void;
    mockCanActorAccessProject.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    mockCanActorAccessProject.mockResolvedValue(false);
    handler({ type: "new_notification", projectUuid: "secret", entityTitle: "Hidden title" });
    await flush();
    changed({ companyUuid, projectUuid: "secret", userUuids: ["owner"] });
    release();
    await flush();
    expect(chunks.join("")).not.toContain("Hidden title");
    expect(mockCanActorAccessProject).toHaveBeenCalledTimes(2);
    ac.abort();
  });

  it("withholds a directed deliver_turn after the persisted turn loses project access", async () => {
    const ac = new AbortController();
    const { chunks } = await startStream(await GET(makeRequest("", ac.signal)));
    const control = mockEventBus.on.mock.calls.find(([channel]) => channel === `control:${connectionUuid}`)![1];
    mockCanAgentReceiveTurn.mockResolvedValue(false);
    control({ type: "control", command: "deliver_turn", targetConnectionUuid: connectionUuid, turnUuid: "turn-secret" });
    await flush();
    expect(chunks.join("")).not.toContain("turn-secret");
    expect(mockCanAgentReceiveTurn).toHaveBeenCalledWith(companyUuid, actorUuid, "turn-secret", connectionUuid, true);
    ac.abort();
  });
  it("returns 401 without registering when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRegisterConnection).not.toHaveBeenCalled();
    expect(mockParseSelfReport).not.toHaveBeenCalled();
  });

  it("registers on connect after auth using the authenticated company/actor (not query params)", async () => {
    const res = await GET(makeRequest("clientType=openclaw&host=h"));
    await startStream(res);

    expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
    expect(mockRegisterConnection).toHaveBeenCalledWith(
      companyUuid,
      actorUuid,
      { clientType: "openclaw", host: "h" },
    );
    expect(mockParseSelfReport).toHaveBeenCalledTimes(1);
    expect(mockParseSelfReport.mock.calls[0][0]).toBeInstanceOf(URLSearchParams);
  });

  it("emits a connection_registered data event carrying the connectionUuid for a daemon connection", async () => {
    const res = await GET(makeRequest("clientType=openclaw"));
    const { chunks } = await startStream(res);

    const joined = chunks.join("");
    expect(joined).toContain(": connected");
    // The daemon parses this to learn which DaemonConnection it registered as
    // (needed to attribute POST /api/daemon/execution-state snapshots).
    expect(joined).toContain('"type":"connection_registered"');
    expect(joined).toContain(`"connectionUuid":"${connectionUuid}"`);
    expect(joined).not.toContain('"connectedAt"');
  });

  it("emits connection_registered for a hermes (Hermes gateway plugin) connection", async () => {
    mockParseSelfReport.mockReturnValue({ clientType: "hermes", host: "h", cwd: "/srv/repo", livenessAck: "v1" });
    const res = await GET(makeRequest("clientType=hermes&livenessAck=v1&host=h&cwd=%2Fsrv%2Frepo"));
    const { chunks } = await startStream(res);

    expect(mockRegisterConnection).toHaveBeenCalledWith(
      companyUuid,
      actorUuid,
      expect.objectContaining({ clientType: "hermes" }),
    );
    const joined = chunks.join("");
    expect(joined).toContain('"type":"connection_registered"');
    expect(joined).toContain(`"connectionUuid":"${connectionUuid}"`);
  });

  it("negotiates exactly livenessAck=v1 and exposes the active generation fence", async () => {
    mockParseSelfReport.mockReturnValue({
      clientType: "openclaw",
      host: "h",
      livenessAck: "v1",
    });
    const res = await GET(makeRequest("clientType=openclaw&livenessAck=v1"));
    const { chunks } = await startStream(res);

    const joined = chunks.join("");
    expect(joined).toContain(`"connectionUuid":"${connectionUuid}"`);
    expect(joined).toContain(`"connectedAt":"${connHandle.connectedAt.toISOString()}"`);
  });

  it("subscribes to the per-user notification channel and delivers events", async () => {
    const res = await GET(makeRequest("clientType=openclaw"));
    const { chunks } = await startStream(res);

    const onCall = mockEventBus.on.mock.calls.find((c) =>
      String(c[0]).startsWith("notification:"),
    );
    expect(onCall).toBeDefined();
    expect(onCall![0]).toBe(`notification:agent:${actorUuid}`);

    const handler = onCall![1] as (e: Record<string, unknown>) => void;
    const before = chunks.length;
    handler({ type: "mention", id: 1 });
    await flush();
    expect(chunks.length).toBe(before + 1);
    expect(chunks[chunks.length - 1]).toContain("mention");
  });

  it("subscribes the per-connection control channel for a daemon connection and forwards control events", async () => {
    const res = await GET(makeRequest("clientType=openclaw"));
    const { chunks } = await startStream(res);

    // The control channel is keyed per connection (`control:{conn.uuid}`), NOT
    // per agent — so an interrupt reaches only the daemon stream holding the
    // subprocess.
    const onCall = mockEventBus.on.mock.calls.find(
      (c) => String(c[0]) === `control:${connectionUuid}`,
    );
    expect(onCall).toBeDefined();

    const controlHandler = onCall![1] as (e: Record<string, unknown>) => void;
    const before = chunks.length;
    controlHandler({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: connectionUuid,
      entityType: "task",
      entityUuid: "task-1",
    });
    await flush();
    expect(chunks.length).toBe(before + 1);
    expect(chunks[chunks.length - 1]).toContain('"type":"control"');
    expect(chunks[chunks.length - 1]).toContain('"command":"interrupt"');
  });

  it("tears down the per-connection control subscription on abort", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=openclaw", ac.signal));
    await startStream(res);

    ac.abort();
    await Promise.resolve();

    expect(mockEventBus.off).toHaveBeenCalledWith(
      `control:${connectionUuid}`,
      expect.any(Function),
    );
  });

  it("touches the connection on each heartbeat tick (daemon clientType)", async () => {
    vi.useFakeTimers();
    const res = await GET(makeRequest("clientType=openclaw"));
    await startStream(res);

    expect(mockTouchConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(1);
    expect(mockTouchConnection).toHaveBeenCalledWith(companyUuid, connHandle);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "v2", "V1", ""])(
    "retains legacy timer touches for absent or unknown livenessAck=%s",
    async (livenessAck) => {
      vi.useFakeTimers();
      mockParseSelfReport.mockReturnValue({
        clientType: "openclaw",
        host: "h",
        livenessAck,
      });
      const query =
        livenessAck === undefined
          ? "clientType=openclaw"
          : `clientType=openclaw&livenessAck=${encodeURIComponent(livenessAck)}`;
      const res = await GET(makeRequest(query));
      const { chunks } = await startStream(res);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(chunks.join("")).toContain(": heartbeat");
      expect(mockTouchConnection).toHaveBeenCalledTimes(4);
    },
  );

  it("keeps emitting heartbeat comments but does not timer-touch an opted-in stream", async () => {
    vi.useFakeTimers();
    mockParseSelfReport.mockReturnValue({
      clientType: "openclaw",
      host: "h",
      livenessAck: "v1",
    });
    const res = await GET(makeRequest("clientType=openclaw&livenessAck=v1"));
    const { chunks } = await startStream(res);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(chunks.join("")).toContain(": heartbeat");
    expect(mockTouchConnection).not.toHaveBeenCalled();
  });

  it("marks disconnected on abort and unsubscribes the handler", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=openclaw", ac.signal));
    await startStream(res);

    expect(mockMarkDisconnected).not.toHaveBeenCalled();
    ac.abort();
    await Promise.resolve();

    expect(mockMarkDisconnected).toHaveBeenCalledTimes(1);
    expect(mockMarkDisconnected).toHaveBeenCalledWith(companyUuid, connHandle);
    expect(mockEventBus.off).toHaveBeenCalledWith(
      `notification:agent:${actorUuid}`,
      expect.any(Function),
    );
  });

  it("arms a DEFERRED orphan-turn reconcile on abort that fires only after the staleness window", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=openclaw", ac.signal));
    await startStream(res);

    ac.abort();
    await flush();
    expect(mockReconcileOrphanTurns).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(90_000 - 1);
    expect(mockReconcileOrphanTurns).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockReconcileOrphanTurns).toHaveBeenCalledTimes(1);
    expect(mockReconcileOrphanTurns).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  describe("registration conflict (a live different-process daemon holds this (agent,host,cwd))", () => {
    const conflictResult = { conflict: true, host: "mac.local", cwd: "/work/alpha" };
    beforeEach(() => {
      mockParseSelfReport.mockReturnValue({
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/work/alpha",
        startedAt: new Date("2026-06-15T09:00:00.000Z"),
      });
      mockRegisterConnection.mockResolvedValue(conflictResult);
    });

    it("emits a single connection_conflict event (with host+cwd) and NOT connection_registered", async () => {
      const res = await GET(makeRequest("clientType=claude_code&host=mac.local&cwd=/work/alpha"));
      const { chunks } = await startStream(res);
      const joined = chunks.join("");

      expect(joined).toContain(": connected");
      expect(joined).toContain('"type":"connection_conflict"');
      expect(joined).toContain('"host":"mac.local"');
      expect(joined).toContain('"cwd":"/work/alpha"');
      // Must NOT also tell the daemon it registered — no row was written.
      expect(joined).not.toContain("connection_registered");
    });

    it("wires up NO per-connection lifecycle on conflict (no control sub, no heartbeat touch, no markDisconnected)", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const res = await GET(makeRequest("clientType=claude_code", ac.signal));
      await startStream(res);

      // No control channel subscription (that is keyed on a real connection uuid).
      const controlOn = mockEventBus.on.mock.calls.find((c) => String(c[0]).startsWith("control:"));
      expect(controlOn).toBeUndefined();

      // Heartbeat frame still flows (keep-alive) but it must NOT touch a registry row.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockTouchConnection).not.toHaveBeenCalled();

      // Abort must not mark a (nonexistent) row disconnected.
      ac.abort();
      await Promise.resolve();
      expect(mockMarkDisconnected).not.toHaveBeenCalled();
      const controlOff = mockEventBus.off.mock.calls.find((c) => String(c[0]).startsWith("control:"));
      expect(controlOff).toBeUndefined();
    });

    it("still subscribes the per-user notification channel on conflict (the user keeps getting notifications)", async () => {
      const res = await GET(makeRequest("clientType=claude_code"));
      await startStream(res);
      const onCall = mockEventBus.on.mock.calls.find((c) =>
        String(c[0]).startsWith("notification:"),
      );
      expect(onCall).toBeDefined();
      expect(onCall![0]).toBe(`notification:agent:${actorUuid}`);
    });
  });

  describe("no-clientType / browser connection", () => {
    beforeEach(() => {
      mockParseSelfReport.mockReturnValue({ clientType: "", host: null });
      mockRegisterConnection.mockResolvedValue(null);
    });

    it("still streams (connected + heartbeat) but writes no registry row", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const res = await GET(makeRequest("", ac.signal));
      const { chunks } = await startStream(res);

      expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
      expect(chunks.join("")).toContain(": connected");
      // No registry row (conn === null) → no connection_registered event emitted.
      expect(chunks.join("")).not.toContain("connection_registered");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(chunks.join("")).toContain(": heartbeat");
      expect(mockTouchConnection).not.toHaveBeenCalled();

      // No registry row (conn === null) → never subscribes a control channel.
      const controlOn = mockEventBus.on.mock.calls.find((c) =>
        String(c[0]).startsWith("control:"),
      );
      expect(controlOn).toBeUndefined();

      ac.abort();
      await Promise.resolve();
      expect(mockMarkDisconnected).not.toHaveBeenCalled();
      const controlOff = mockEventBus.off.mock.calls.find((c) =>
        String(c[0]).startsWith("control:"),
      );
      expect(controlOff).toBeUndefined();
    });
  });
});
