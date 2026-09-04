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

const mockReconcileOffline = vi.fn();
const mockPublishExecutionChange = vi.fn();
const mockListVisibleConnectionUuids = vi.fn();
const mockIsSessionVisibleToCaller = vi.fn();
const mockListVisibleRunningSessionActivities = vi.fn();
const mockReconcileOrphanTurns = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/lib/event-bus", () => ({
  eventBus: mockEventBus,
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

// The route now also resolves the caller's visible connections (to subscribe to
// their execution:{uuid} channels) and reconciles/publishes execution state on
// disconnect. Mock the execution service so the route test stays a unit test —
// executionEventName keeps the real `execution:{uuid}` channel-name convention so
// the subscription assertions exercise the actual channel string.
vi.mock("@/services/daemon-execution.service", () => ({
  reconcileOffline: (...args: unknown[]) => mockReconcileOffline(...args),
  publishExecutionChange: (...args: unknown[]) => mockPublishExecutionChange(...args),
  listVisibleConnectionUuids: (...args: unknown[]) => mockListVisibleConnectionUuids(...args),
  executionEventName: (connectionUuid: string) => `execution:${connectionUuid}`,
}));

// The route now also accepts `?sessionUuid=` and subscribes that session's
// `transcript:{sessionUuid}` channel — but ONLY after the visibility gate passes. Mock
// the session service so this stays a unit test; `transcriptEventName` keeps the real
// `transcript:{uuid}` channel-name convention so the subscription assertions exercise
// the actual channel string.
vi.mock("@/services/daemon-session.service", () => ({
  isSessionVisibleToCaller: (...args: unknown[]) => mockIsSessionVisibleToCaller(...args),
  listVisibleRunningSessionActivities: (...args: unknown[]) =>
    mockListVisibleRunningSessionActivities(...args),
  SESSION_ACTIVITY_EVENT_NAME: "session_activity",
  transcriptEventName: (sessionUuid: string) => `transcript:${sessionUuid}`,
  reconcileOrphanTurns: (...args: unknown[]) => mockReconcileOrphanTurns(...args),
}));

import { GET } from "@/app/api/events/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const actorUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
// registerConnection now returns a {uuid, connectedAt} handle (the connectedAt
// is a generation fence); touch/markDisconnected receive the whole handle.
const connHandle = { uuid: connectionUuid, connectedAt: new Date("2026-06-15T03:00:00.000Z") };

const agentAuth = { type: "agent", companyUuid, actorUuid, permissions: [] };
const userUuid = "user-0000-0000-0000-000000000001";
const userAuth = { type: "user", companyUuid, actorUuid: userUuid, permissions: [] };

function makeRequest(query = "", signal?: AbortSignal): NextRequest {
  const url = `http://localhost:3000/api/events${query ? `?${query}` : ""}`;
  return new NextRequest(new URL(url), signal ? { signal } : undefined);
}

/**
 * Drive the SSE response: start consuming the stream so its `start(controller)`
 * callback runs synchronously, and collect every chunk decoded to text.
 */
async function startStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const pump = (async () => {
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
  // Let the start() microtask + first enqueue settle.
  await flush();
  return { chunks, pump, reader };
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
  // Default: behave as a daemon connection.
  mockParseSelfReport.mockReturnValue({ clientType: "claude_code", host: "h" });
  mockRegisterConnection.mockResolvedValue(connHandle);
  // Default: the caller sees no other connections (no execution channels).
  mockListVisibleConnectionUuids.mockResolvedValue([]);
  mockReconcileOffline.mockResolvedValue(0);
  mockPublishExecutionChange.mockResolvedValue(undefined);
  // Default: the requested session (when one is given) is visible to the caller.
  mockIsSessionVisibleToCaller.mockResolvedValue(true);
  mockListVisibleRunningSessionActivities.mockResolvedValue([]);
  mockReconcileOrphanTurns.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/events (change events SSE)", () => {
  it("returns 401 without registering when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRegisterConnection).not.toHaveBeenCalled();
    expect(mockParseSelfReport).not.toHaveBeenCalled();
  });

  it("registers on connect after auth using the authenticated company/actor (not query params)", async () => {
    const res = await GET(makeRequest("clientType=claude_code&host=h"));
    await startStream(res);

    expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
    expect(mockRegisterConnection).toHaveBeenCalledWith(
      companyUuid,
      actorUuid,
      { clientType: "claude_code", host: "h" },
    );
    // self-report is read from the request URL search params, after auth.
    expect(mockParseSelfReport).toHaveBeenCalledTimes(1);
    expect(mockParseSelfReport.mock.calls[0][0]).toBeInstanceOf(URLSearchParams);
  });

  it("touches the connection on each heartbeat tick (daemon clientType)", async () => {
    vi.useFakeTimers();
    const res = await GET(makeRequest("clientType=claude_code"));
    await startStream(res);

    expect(mockTouchConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(1);
    expect(mockTouchConnection).toHaveBeenCalledWith(companyUuid, connHandle);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTouchConnection).toHaveBeenCalledTimes(2);
  });

  it("marks disconnected on abort (daemon clientType)", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=claude_code", ac.signal));
    await startStream(res);

    expect(mockMarkDisconnected).not.toHaveBeenCalled();
    ac.abort();
    await Promise.resolve();

    expect(mockMarkDisconnected).toHaveBeenCalledTimes(1);
    expect(mockMarkDisconnected).toHaveBeenCalledWith(companyUuid, connHandle);
  });

  it("arms a DEFERRED orphan-turn reconcile on abort that fires only after the staleness window", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=claude_code", ac.signal));
    await startStream(res);

    ac.abort();
    await flush();

    // Executions reconcile immediately; turns do NOT — they get the full window.
    expect(mockReconcileOffline).toHaveBeenCalledTimes(1);
    expect(mockReconcileOrphanTurns).not.toHaveBeenCalled();

    // One tick before the window: still not fired.
    await vi.advanceTimersByTimeAsync(90_000 - 1);
    expect(mockReconcileOrphanTurns).not.toHaveBeenCalled();

    // Window elapsed: the deferred reconcile fires for this connection. (The age-only
    // no-op-when-reconnected verdict lives inside reconcileOrphanTurns itself.)
    await vi.advanceTimersByTimeAsync(1);
    expect(mockReconcileOrphanTurns).toHaveBeenCalledTimes(1);
    expect(mockReconcileOrphanTurns).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("does NOT arm the orphan reconcile for a non-daemon (browser) stream abort", async () => {
    vi.useFakeTimers();
    mockParseSelfReport.mockReturnValue(null);
    mockRegisterConnection.mockResolvedValue(null);
    const ac = new AbortController();
    const res = await GET(makeRequest("", ac.signal));
    await startStream(res);

    ac.abort();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockReconcileOrphanTurns).not.toHaveBeenCalled();
  });

  it("preserves projectUuid filtering: cross-project change events are dropped", async () => {
    const res = await GET(makeRequest("projectUuid=proj-1&clientType=claude_code"));
    const { chunks } = await startStream(res);

    // The route subscribed a change handler — grab it and exercise the filter.
    const changeCall = mockEventBus.on.mock.calls.find((c) => c[0] === "change");
    expect(changeCall).toBeDefined();
    const handler = changeCall![1] as (e: Record<string, unknown>) => void;

    const before = chunks.length;
    // Wrong project → dropped.
    handler({ companyUuid, projectUuid: "other", type: "x" });
    await flush();
    expect(chunks.length).toBe(before);
    // Matching project → delivered.
    handler({ companyUuid, projectUuid: "proj-1", type: "x" });
    await flush();
    expect(chunks.length).toBe(before + 1);
    expect(chunks[chunks.length - 1]).toContain("proj-1");
  });

  it("drops change events from a different company (multi-tenancy)", async () => {
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find((c) => c[0] === "change")![1] as (
      e: Record<string, unknown>,
    ) => void;

    const before = chunks.length;
    handler({ companyUuid: "other-company", type: "x" });
    await flush();
    expect(chunks.length).toBe(before);
  });

  describe("registration conflict (symmetric with the notification route)", () => {
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

    it("emits a connection_conflict event (with host+cwd) on conflict", async () => {
      const res = await GET(makeRequest("clientType=claude_code&host=mac.local&cwd=/work/alpha"));
      const { chunks } = await startStream(res);
      const joined = chunks.join("");
      expect(joined).toContain(": connected");
      expect(joined).toContain('"type":"connection_conflict"');
      expect(joined).toContain('"host":"mac.local"');
      expect(joined).toContain('"cwd":"/work/alpha"');
    });

    it("skips the per-connection lifecycle on conflict (no heartbeat touch, no markDisconnected)", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const res = await GET(makeRequest("clientType=claude_code", ac.signal));
      await startStream(res);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockTouchConnection).not.toHaveBeenCalled();

      ac.abort();
      await Promise.resolve();
      expect(mockMarkDisconnected).not.toHaveBeenCalled();
    });
  });

  describe("no-clientType / browser connection", () => {
    beforeEach(() => {
      mockParseSelfReport.mockReturnValue({ clientType: "", host: null });
      // registerConnection returns null for a non-daemon clientType.
      mockRegisterConnection.mockResolvedValue(null);
    });

    it("still streams (connected + heartbeat) but writes no registry row", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const res = await GET(makeRequest("", ac.signal));
      const { chunks } = await startStream(res);

      // registerConnection was still consulted (returned null), but no lifecycle fired.
      expect(mockRegisterConnection).toHaveBeenCalledTimes(1);
      expect(chunks.join("")).toContain(": connected");

      await vi.advanceTimersByTimeAsync(30_000);
      // Heartbeat still flows to the client...
      expect(chunks.join("")).toContain(": heartbeat");
      // ...but touch is skipped because connUuid is null.
      expect(mockTouchConnection).not.toHaveBeenCalled();

      ac.abort();
      await Promise.resolve();
      expect(mockMarkDisconnected).not.toHaveBeenCalled();
    });
  });

  it("does not break the stream when registerConnection rejects (it cannot — it swallows)", async () => {
    // The service never throws, but assert the route does not await-throw regardless.
    mockRegisterConnection.mockResolvedValue(null);
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    expect(res.status).toBe(200);
    expect(chunks.join("")).toContain(": connected");
  });
});

describe("GET /api/events (execution-state SSE)", () => {
  const connA = "conn-a";
  const connB = "conn-b";

  it("subscribes to execution:{uuid} for every visible connection at stream-start", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue([connA, connB]);
    const res = await GET(makeRequest("clientType=claude_code"));
    await startStream(res);

    expect(mockListVisibleConnectionUuids).toHaveBeenCalledWith(agentAuth);
    const channels = mockEventBus.on.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`execution:${connA}`);
    expect(channels).toContain(`execution:${connB}`);
  });

  it("subscribes to no execution channel when the caller sees no connections", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue([]);
    const res = await GET(makeRequest("clientType=claude_code"));
    await startStream(res);
    const channels = mockEventBus.on.mock.calls.map((c) => c[0]);
    expect(channels.some((ch) => typeof ch === "string" && ch.startsWith("execution:"))).toBe(false);
  });

  it("forwards a same-company execution event tagged type:execution", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue([connA]);
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);

    const execCall = mockEventBus.on.mock.calls.find((c) => c[0] === `execution:${connA}`);
    expect(execCall).toBeDefined();
    const handler = execCall![1] as (e: Record<string, unknown>) => void;

    const before = chunks.length;
    handler({ companyUuid, connectionUuid: connA, executions: [{ entityType: "task", entityUuid: "t1" }] });
    await flush();
    expect(chunks.length).toBe(before + 1);
    const last = chunks[chunks.length - 1];
    expect(last).toContain('"type":"execution"');
    expect(last).toContain(connA);
  });

  it("drops execution events from a different company (multi-tenancy)", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue([connA]);
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find((c) => c[0] === `execution:${connA}`)![1] as (
      e: Record<string, unknown>,
    ) => void;

    const before = chunks.length;
    handler({ companyUuid: "other-company", connectionUuid: connA, executions: [] });
    await flush();
    expect(chunks.length).toBe(before);
  });

  it("unsubscribes every execution channel on abort", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue([connA, connB]);
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=claude_code", ac.signal));
    await startStream(res);

    ac.abort();
    await Promise.resolve();

    const offChannels = mockEventBus.off.mock.calls.map((c) => c[0]);
    expect(offChannels).toContain(`execution:${connA}`);
    expect(offChannels).toContain(`execution:${connB}`);
  });

  it("reconciles + publishes execution on disconnect for the registered connection", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=claude_code", ac.signal));
    await startStream(res);

    ac.abort();
    // Let the markDisconnected → reconcileOffline → publish chain settle.
    await flush();

    expect(mockReconcileOffline).toHaveBeenCalledWith(companyUuid, connectionUuid);
    expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });
});

describe("GET /api/events (session activity SSE)", () => {
  const publishedActivity = {
    type: "session_started",
    companyUuid,
    sessionUuid: "session-a",
    activityUuid: "turn-a",
    directIdeaUuid: "idea-a",
    agentUuid: actorUuid,
    originConnectionUuid: "conn-a",
    agentOwnerUuid: userUuid,
  };
  const bootstrapActivity = {
    ...publishedActivity,
    canOpen: true,
    agentOwnerUuid: undefined,
  };

  it("subscribes before querying and replays caller-visible running activities", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue(["conn-a"]);
    mockListVisibleRunningSessionActivities.mockImplementation(async () => {
      expect(
        mockEventBus.on.mock.calls.some((call) => call[0] === "session_activity"),
      ).toBe(true);
      return [bootstrapActivity];
    });

    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);

    expect(mockListVisibleRunningSessionActivities).toHaveBeenCalledWith(agentAuth);
    expect(chunks.join("")).toContain('"type":"session_started"');
    expect(chunks.join("")).toContain('"activityUuid":"turn-a"');
  });

  it("buffers a concurrent end until after snapshot replay so the end wins", async () => {
    mockListVisibleConnectionUuids.mockResolvedValue(["conn-a"]);
    let resolveSnapshot!: (events: unknown[]) => void;
    mockListVisibleRunningSessionActivities.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const res = await GET(makeRequest("clientType=claude_code"));
    const streamPromise = startStream(res);
    await flush();
    const handler = mockEventBus.on.mock.calls.find(
      (call) => call[0] === "session_activity",
    )![1] as (event: Record<string, unknown>) => void;
    handler({ ...publishedActivity, type: "session_ended" });
    resolveSnapshot([bootstrapActivity]);
    const { chunks } = await streamPromise;
    await flush();

    const body = chunks.join("");
    expect(body.indexOf('"type":"session_started"')).toBeGreaterThan(-1);
    expect(body.indexOf('"type":"session_ended"')).toBeGreaterThan(
      body.indexOf('"type":"session_started"'),
    );
  });

  it("forwards a user's same-company other-user activity with canOpen false and owned activity with true", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find(
      (call) => call[0] === "session_activity",
    )![1] as (event: Record<string, unknown>) => void;
    const before = chunks.length;

    handler({
      ...publishedActivity,
      agentUuid: "other-user-agent",
      agentOwnerUuid: "other-user",
    });
    handler(publishedActivity);
    await flush();
    expect(chunks.length).toBe(before + 2);
    const body = chunks.slice(before).join("");
    expect(body).toContain('"agentUuid":"other-user-agent"');
    expect(body).toContain('"canOpen":false');
    expect(body).toContain(`"agentUuid":"${actorUuid}"`);
    expect(body).toContain('"canOpen":true');
    expect(body).not.toContain("agentOwnerUuid");
  });

  it("keeps agent-key subscribers self-only", async () => {
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find(
      (call) => call[0] === "session_activity",
    )![1] as (event: Record<string, unknown>) => void;
    const before = chunks.length;

    handler({ ...publishedActivity, agentUuid: "other-agent" });
    handler(publishedActivity);
    await flush();
    expect(chunks.length).toBe(before + 1);
    expect(chunks.at(-1)).toContain('"canOpen":true');
  });

  it("drops cross-company live activity", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);
    const res = await GET(makeRequest("clientType=claude_code"));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find(
      (call) => call[0] === "session_activity",
    )![1] as (event: Record<string, unknown>) => void;
    const before = chunks.length;
    handler({ ...publishedActivity, companyUuid: "other-company" });
    await flush();
    expect(chunks.length).toBe(before);
  });

  it("unsubscribes the activity channel on abort", async () => {
    const ac = new AbortController();
    const res = await GET(makeRequest("clientType=claude_code", ac.signal));
    await startStream(res);
    ac.abort();
    await flush();
    expect(mockEventBus.off).toHaveBeenCalledWith(
      "session_activity",
      expect.any(Function),
    );
  });
});

describe("GET /api/events (transcript SSE — open-session subscription)", () => {
  const sessionUuid = "sess-aaaa";

  it("subscribes no transcript channel when no ?sessionUuid is given", async () => {
    const res = await GET(makeRequest("clientType=claude_code"));
    await startStream(res);
    // The visibility gate is never consulted, and no transcript channel is bound.
    expect(mockIsSessionVisibleToCaller).not.toHaveBeenCalled();
    const channels = mockEventBus.on.mock.calls.map((c) => c[0]);
    expect(channels.some((ch) => typeof ch === "string" && ch.startsWith("transcript:"))).toBe(
      false,
    );
  });

  it("subscribes transcript:{sessionUuid} ONLY after the visibility gate passes", async () => {
    mockIsSessionVisibleToCaller.mockResolvedValue(true);
    const res = await GET(makeRequest(`sessionUuid=${sessionUuid}&clientType=claude_code`));
    await startStream(res);

    // Gate consulted with the caller's auth + the requested session.
    expect(mockIsSessionVisibleToCaller).toHaveBeenCalledWith(agentAuth, sessionUuid);
    const channels = mockEventBus.on.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`transcript:${sessionUuid}`);
  });

  it("VISIBILITY GATE: a non-visible session is silently NOT subscribed (never confirmed)", async () => {
    mockIsSessionVisibleToCaller.mockResolvedValue(false);
    const res = await GET(makeRequest(`sessionUuid=${sessionUuid}&clientType=claude_code`));
    const { chunks } = await startStream(res);

    expect(mockIsSessionVisibleToCaller).toHaveBeenCalledWith(agentAuth, sessionUuid);
    // No transcript channel was bound...
    const channels = mockEventBus.on.mock.calls.map((c) => c[0]);
    expect(channels.some((ch) => typeof ch === "string" && ch.startsWith("transcript:"))).toBe(
      false,
    );
    // ...and the stream gave no signal that the session exists (non-disclosure): it
    // opened normally with just the connection confirmation.
    expect(chunks.join("")).toContain(": connected");
  });

  it("forwards a same-company transcript event tagged type:transcript", async () => {
    mockIsSessionVisibleToCaller.mockResolvedValue(true);
    const res = await GET(makeRequest(`sessionUuid=${sessionUuid}&clientType=claude_code`));
    const { chunks } = await startStream(res);

    const tCall = mockEventBus.on.mock.calls.find((c) => c[0] === `transcript:${sessionUuid}`);
    expect(tCall).toBeDefined();
    const handler = tCall![1] as (e: Record<string, unknown>) => void;

    const before = chunks.length;
    handler({
      companyUuid,
      sessionUuid,
      trigger: "transcript_appended",
      turn: { uuid: "turn-1" },
      messages: [{ uuid: "m1", turnUuid: "turn-1", role: "assistant", text: "hi", seq: 1 }],
    });
    await flush();
    expect(chunks.length).toBe(before + 1);
    const last = chunks[chunks.length - 1];
    expect(last).toContain('"type":"transcript"');
    expect(last).toContain(sessionUuid);
    // The appended message tail rides on the wire.
    expect(last).toContain('"messages"');
  });

  it("drops transcript events from a different company (multi-tenancy)", async () => {
    mockIsSessionVisibleToCaller.mockResolvedValue(true);
    const res = await GET(makeRequest(`sessionUuid=${sessionUuid}&clientType=claude_code`));
    const { chunks } = await startStream(res);
    const handler = mockEventBus.on.mock.calls.find(
      (c) => c[0] === `transcript:${sessionUuid}`,
    )![1] as (e: Record<string, unknown>) => void;

    const before = chunks.length;
    handler({ companyUuid: "other-company", sessionUuid, trigger: "turn_created", turn: {}, messages: [] });
    await flush();
    expect(chunks.length).toBe(before);
  });

  it("unsubscribes the transcript channel on abort (teardown)", async () => {
    mockIsSessionVisibleToCaller.mockResolvedValue(true);
    const ac = new AbortController();
    const res = await GET(makeRequest(`sessionUuid=${sessionUuid}&clientType=claude_code`, ac.signal));
    await startStream(res);

    ac.abort();
    await Promise.resolve();

    const offChannels = mockEventBus.off.mock.calls.map((c) => c[0]);
    expect(offChannels).toContain(`transcript:${sessionUuid}`);
  });
});

describe("GET /api/events (browser notification forwarding)", () => {
  beforeEach(() => {
    mockGetAuthContext.mockResolvedValue(userAuth);
    mockParseSelfReport.mockReturnValue(null);
    mockRegisterConnection.mockResolvedValue(null);
  });

  it("subscribes only the authenticated browser user's channel and forwards payloads unchanged", async () => {
    const res = await GET(makeRequest());
    const { chunks } = await startStream(res);
    const channel = `notification:user:${userUuid}`;
    const notificationCall = mockEventBus.on.mock.calls.find(
      ([candidate]) => candidate === channel,
    );

    expect(notificationCall).toBeDefined();
    expect(
      mockEventBus.on.mock.calls.some(
        ([candidate]) => candidate === "notification:user:another-user",
      ),
    ).toBe(false);

    const payload = {
      type: "new_notification",
      notificationUuid: "notification-1",
      unreadCount: 4,
      action: "mentioned",
    };
    const before = chunks.length;
    notificationCall![1](payload);
    await flush();

    expect(chunks).toHaveLength(before + 1);
    expect(chunks.at(-1)).toBe(`data: ${JSON.stringify(payload)}\n\n`);
  });

  it("removes the browser notification listener on abort", async () => {
    const abortController = new AbortController();
    const res = await GET(makeRequest("", abortController.signal));
    await startStream(res);

    abortController.abort();
    await flush();

    expect(mockEventBus.off).toHaveBeenCalledWith(
      `notification:user:${userUuid}`,
      expect.any(Function),
    );
  });

  it("does not add browser notification forwarding to a registered daemon stream", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    mockParseSelfReport.mockReturnValue({ clientType: "claude_code" });
    mockRegisterConnection.mockResolvedValue(connHandle);

    const res = await GET(makeRequest("clientType=claude_code"));
    await startStream(res);

    expect(
      mockEventBus.on.mock.calls.some(([channel]) =>
        String(channel).startsWith("notification:"),
      ),
    ).toBe(false);
  });
});
