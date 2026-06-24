import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====
// The bridge composes three services + the logger. Mock them all so this is a true
// unit test of the mapping / resolution / failure-isolation logic, with no DB.

const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForAgent: mockListConnectionsForAgent,
}));

const mockResolveOrCreateSession = vi.hoisted(() => vi.fn());
const mockCreatePendingTurn = vi.hoisted(() => vi.fn());
const mockResolveDirectIdeaUuid = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-session.service", () => ({
  resolveOrCreateSession: mockResolveOrCreateSession,
  createPendingTurn: mockCreatePendingTurn,
  resolveDirectIdeaUuid: mockResolveDirectIdeaUuid,
}));

// The task-assignment pin (T5) is read from the Task's targetHost/targetCwd columns,
// so the bridge touches prisma.task.findFirst for a task_assigned wake. The directed-
// delivery change ALSO reads prisma.daemonSession.findFirst to (a) resolve an
// elaboration_verified wake's existing idea-session origin and (b) detect a cross-cwd
// directed mention (existing session origin != resolved target). Mock both so these stay
// pure unit tests with no DB. Defaults: no Task pin (both null → online-first); no existing
// daemon session (null → no cross-cwd suffix, normal session, no elaboration upgrade).
const mockTaskFindFirst = vi.hoisted(() => vi.fn());
const mockDaemonSessionFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findFirst: mockTaskFindFirst },
    daemonSession: { findFirst: mockDaemonSessionFindFirst },
  },
}));

// The directed `deliver_turn` ping reuses `deliverTurnPing` from the daemon-instruction
// service (the human_instruction keystone). Mock that module so we can assert the ping is
// emitted to ONLY the resolved target for a directed wake — and NOT for un-pinned / offline
// wakes — without an event bus.
const mockDeliverTurnPing = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-instruction.service", () => ({
  deliverTurnPing: mockDeliverTurnPing,
}));

// Capture logger.error so we can assert the VISIBLE-failure (no silent swallow) rule.
// The child logger object is built at hoist time so the module-level
// `logger.child(...)` call (evaluated at import) returns a stable spy-bearing object.
const mockChildLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
const mockLoggerError = mockChildLogger.error;
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { ...mockLogger, child: () => mockChildLogger },
}));

import {
  maybeCreateTurnForWakeNotification,
  createTurnAndResolveTarget,
  triggerForAction,
  NOTIFICATION_ACTION_TO_TURN_TRIGGER,
  type WakeNotificationContext,
} from "@/services/notification-turn";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const ideaUuid = "idea-0000-0000-0000-000000000001";
const taskUuid = "task-0000-0000-0000-000000000001";
const sessionUuid = "session-0000-0000-0000-000000000001";

function onlineConn(overrides: Record<string, unknown> = {}) {
  return {
    uuid: connectionUuid,
    agentUuid,
    agentName: "Daemon Agent",
    clientType: "claude_code",
    clientVersion: null,
    host: "host-1",
    cwd: "/home/u/dev/chorus",
    startedAt: null,
    status: "online",
    effectiveStatus: "online" as const,
    connectedAt: "2026-06-19T00:00:00.000Z",
    lastSeenAt: "2026-06-19T00:00:00.000Z",
    disconnectedAt: null,
    ...overrides,
  };
}

function offlineConn(overrides: Record<string, unknown> = {}) {
  return onlineConn({ status: "offline", effectiveStatus: "offline", ...overrides });
}

function sessionView(overrides: Record<string, unknown> = {}) {
  return {
    uuid: sessionUuid,
    agentUuid,
    sessionId: ideaUuid,
    directIdeaUuid: ideaUuid,
    originConnectionUuid: connectionUuid,
    status: "active",
    title: null,
    lastTurnAt: "2026-06-19T00:00:00.000Z",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function turnView(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "turn-0000-0000-0000-000000000001",
    sessionUuid,
    seq: 1,
    trigger: "task_assigned",
    promptText: null,
    status: "pending",
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(overrides: Partial<WakeNotificationContext> = {}): WakeNotificationContext {
  return {
    companyUuid,
    recipientType: "agent",
    recipientUuid: agentUuid,
    entityType: "task",
    entityUuid: taskUuid,
    action: "task_assigned",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy path: one online connection, lineage resolves to an idea, session
  // resolves, turn created.
  mockListConnectionsForAgent.mockResolvedValue([onlineConn()]);
  mockResolveDirectIdeaUuid.mockResolvedValue(ideaUuid);
  mockResolveOrCreateSession.mockResolvedValue(sessionView());
  mockCreatePendingTurn.mockImplementation(async (p: { trigger: string; promptText?: string | null }) =>
    turnView({ trigger: p.trigger, promptText: p.promptText ?? null }),
  );
  // Default: the assigned Task records NO pin (both columns null) — the unchanged
  // online-first path. Pin-honoring tests override this per-case.
  mockTaskFindFirst.mockResolvedValue({ targetHost: null, targetCwd: null });
  // Default: no existing idea-anchored daemon session — so a directed wake creates a
  // normal session (no cross-cwd suffix) and an elaboration_verified wake has no origin to
  // upgrade to (online-first fallback). Cross-cwd / origin tests override per-case.
  mockDaemonSessionFindFirst.mockResolvedValue(null);
});

// ===== Action → trigger mapping =====
describe("triggerForAction / NOTIFICATION_ACTION_TO_TURN_TRIGGER", () => {
  it("maps @mention to the mentioned trigger", () => {
    expect(triggerForAction("mentioned")).toBe("mentioned");
  });

  it("maps elaboration request and answer to the elaboration trigger", () => {
    expect(triggerForAction("elaboration_requested")).toBe("elaboration");
    expect(triggerForAction("elaboration_answered")).toBe("elaboration");
  });

  it("maps the human-verify wake to the distinct elaboration_verified trigger (NOT elaboration)", () => {
    expect(triggerForAction("elaboration_verified")).toBe("elaboration_verified");
    // It must be its own trigger so the daemon prompt can tell "write the proposal"
    // apart from "answer the questions" — never collapsed into "elaboration".
    expect(triggerForAction("elaboration_verified")).not.toBe("elaboration");
  });

  it("maps the human-typed instruction to the human_instruction trigger", () => {
    expect(triggerForAction("human_instruction")).toBe("human_instruction");
  });

  it("maps every autonomous task-style dispatch to the task_assigned trigger", () => {
    for (const action of [
      "task_assigned",
      "task_reopened",
      "task_verified",
      "idea_claimed",
      "proposal_approved",
      "proposal_rejected",
    ]) {
      expect(triggerForAction(action)).toBe("task_assigned");
    }
  });

  it("returns null for non-wake-triggering notification actions", () => {
    for (const action of [
      "task_status_changed",
      "task_submitted_for_verify",
      "comment_added",
      "report_created",
      "count_update",
      "agent_checkin",
    ]) {
      expect(triggerForAction(action)).toBeNull();
    }
  });

  it("does NOT include resource_resumed (synthetic control-channel dispatch, never a persisted notification)", () => {
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER).not.toHaveProperty("resource_resumed");
    expect(triggerForAction("resource_resumed")).toBeNull();
  });

  it("every mapped trigger value is a member of the 6-value turn-trigger taxonomy", () => {
    const allowed = new Set([
      "task_assigned",
      "mentioned",
      "elaboration",
      "elaboration_verified",
      "resume",
      "human_instruction",
    ]);
    for (const trigger of Object.values(NOTIFICATION_ACTION_TO_TURN_TRIGGER)) {
      expect(allowed.has(trigger)).toBe(true);
    }
  });
});

// ===== maybeCreateTurnForWakeNotification — happy paths per wake kind =====
describe("maybeCreateTurnForWakeNotification — creates exactly one pending turn per wake kind", () => {
  const cases: { action: string; trigger: string }[] = [
    { action: "task_assigned", trigger: "task_assigned" },
    { action: "mentioned", trigger: "mentioned" },
    { action: "elaboration_requested", trigger: "elaboration" },
    { action: "elaboration_answered", trigger: "elaboration" },
    { action: "elaboration_verified", trigger: "elaboration_verified" },
    { action: "task_reopened", trigger: "task_assigned" },
    { action: "task_verified", trigger: "task_assigned" },
    { action: "idea_claimed", trigger: "task_assigned" },
    { action: "proposal_approved", trigger: "task_assigned" },
    { action: "proposal_rejected", trigger: "task_assigned" },
  ];

  for (const { action, trigger } of cases) {
    it(`action "${action}" → one pending turn with trigger "${trigger}"`, async () => {
      const result = await maybeCreateTurnForWakeNotification(ctx({ action }));

      expect(mockCreatePendingTurn).toHaveBeenCalledTimes(1);
      expect(mockCreatePendingTurn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionUuid, trigger }),
      );
      expect(result?.trigger).toBe(trigger);
      expect(result?.status).toBe("pending");
    });
  }

  it("resolves the session keyed on the entity's direct idea (lineage) and pins the online origin connection", async () => {
    await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(mockResolveDirectIdeaUuid).toHaveBeenCalledWith(companyUuid, "task", taskUuid);
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        agentUuid,
        sessionId: ideaUuid,
        directIdeaUuid: ideaUuid,
        originConnectionUuid: connectionUuid,
      }),
    );
  });

  it("falls back to the entity uuid as sessionId (ad-hoc) when lineage finds no idea", async () => {
    mockResolveDirectIdeaUuid.mockResolvedValue(null);

    await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: taskUuid, directIdeaUuid: null }),
    );
  });

  it("does NOT walk lineage for a non-lineage entityType (e.g. comment); uses the entity uuid as sessionId", async () => {
    await maybeCreateTurnForWakeNotification(
      ctx({ action: "mentioned", entityType: "comment", entityUuid: "comment-1" }),
    );

    expect(mockResolveDirectIdeaUuid).not.toHaveBeenCalled();
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "comment-1", directIdeaUuid: null }),
    );
  });

  it("idea-anchored elaboration_verified wake records a turn on the idea's session with the distinct trigger", async () => {
    // The verify wake targets the idea itself (entityType "idea"); lineage resolves
    // it to its own directIdeaUuid and the turn carries the distinct trigger so the
    // daemon knows to write the proposal (not answer questions).
    const result = await maybeCreateTurnForWakeNotification(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(mockResolveDirectIdeaUuid).toHaveBeenCalledWith(companyUuid, "idea", ideaUuid);
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: connectionUuid }),
    );
    expect(mockCreatePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid, trigger: "elaboration_verified", promptText: null }),
    );
    expect(result?.trigger).toBe("elaboration_verified");
    expect(result?.status).toBe("pending");
  });

  it("creates NO live turn for an offline agent on an elaboration_verified wake (notification persists for backfill)", async () => {
    // Mirrors the offline/backfill contract: no online connection ⇒ no turn now, but
    // the (already-created) notification survives for reconnect-backfill. No error.
    mockListConnectionsForAgent.mockResolvedValue([offlineConn()]);

    const result = await maybeCreateTurnForWakeNotification(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(result).toBeNull();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("picks the first online connection when several connections exist (origin-pinned)", async () => {
    const fresh = "conn-fresh";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: fresh }),
      onlineConn({ uuid: "conn-older" }),
      offlineConn({ uuid: "conn-offline" }),
    ]);

    await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: fresh }),
    );
  });
});

// ===== Pinned-target instance routing (cwd-addressable instances, T5) =====
//
// The wake honors a pinned (host, cwd): a `mentioned` wake carries the pin on the
// context (threaded from the mention markup by mention.service); a `task_assigned`
// wake reads it from the Task's targetHost/targetCwd columns. ONLINE-ONLY selection:
//   - pin matches an ONLINE connection       → pin the session origin THERE (not [0])
//   - pin matches an OFFLINE connection       → NOT wakeable (no durable queue) →
//                                              online-first fallback
//   - pin matches NO connection / no pin      → online-first fallback (unchanged)
//   - no online connection at all             → no turn (the notification stands)
// DEC-5: the cwd is ONLY ever the explicit pin — never inferred from the project.
describe("maybeCreateTurnForWakeNotification — pinned-target instance routing (T5)", () => {
  const pinnedHost = "Laptop-Q3";
  const pinnedCwd = "/home/u/dev/payments";
  const pinnedConnUuid = "conn-pinned-target";

  function pinnedConn(overrides: Record<string, unknown> = {}) {
    return onlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd, ...overrides });
  }

  // ----- mentioned wake: pin carried on the context -----

  it("pins the session origin to the (host, cwd)-matching LIVE connection (not online-first) for a mentioned wake", async () => {
    // Online-first would pick `conn-online-first`; the pin must override that and
    // select the pinned-target connection even though it is NOT first in the list.
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "other-host", cwd: "/home/u/dev/other" }),
      pinnedConn(),
    ]);

    const result = await maybeCreateTurnForWakeNotification(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid }),
    );
    expect(result?.trigger).toBe("mentioned");
    expect(result?.status).toBe("pending");
    expect(mockLoggerError).not.toHaveBeenCalled();
    // A mentioned wake reads its pin from the context, NOT from the Task table.
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  it("does NOT read the Task pin for a mentioned wake (pin is context-only)", async () => {
    await maybeCreateTurnForWakeNotification(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd, entityType: "task", entityUuid: taskUuid }),
    );
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  // ----- task_assigned wake: pin read from the Task columns -----

  it("reads the Task targetHost/targetCwd and pins the matching LIVE connection for a task_assigned wake", async () => {
    mockTaskFindFirst.mockResolvedValue({ targetHost: pinnedHost, targetCwd: pinnedCwd });
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "other-host", cwd: "/home/u/dev/other" }),
      pinnedConn(),
    ]);

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(mockTaskFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uuid: taskUuid, companyUuid }),
      }),
    );
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid }),
    );
    expect(result?.status).toBe("pending");
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  // ----- OFFLINE PIN = notify-only, NO wake (deliberate REVERSAL of #354) -----
  //
  // fix-pinned-wake-directed-delivery (T1) REVERSES #354's "offline pin → online-first":
  // a PINNED wake whose pin matches NO online connection now creates NO turn, emits NO
  // ping, and surfaces NO target. The already-created Notification stands as the plain
  // record. Silently re-routing a pinned wake to a cwd the user did NOT choose is the
  // user-visible defect this change fixes, so there is NO online-first fallback for a
  // pinned wake (an UN-pinned wake still goes online-first, tested below).

  it("offline pin (place not registered): creates NO turn, NO ping, NO target (notify-only — REVERSAL of #354)", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      offlineConn({ uuid: "conn-offline", host: "host-B", cwd: "/home/u/dev/b" }),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      // Pin to a place that is not registered for this agent at all.
      ctx({ action: "mentioned", pinnedHost: "ghost-host", pinnedCwd: "/no/such/path" }),
    );

    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    // It must NOT fall back to the online-first instance (the defect being fixed).
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    // A notify-only offline pin is normal, not an error.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("offline Task pin (place not registered): creates NO turn, NO ping, NO target (task_assigned)", async () => {
    mockTaskFindFirst.mockResolvedValue({ targetHost: "ghost-host", targetCwd: "/no/such/path" });
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("a pin matching an OFFLINE connection (online-elsewhere) creates NO turn, NO ping, NO target (no silent re-route)", async () => {
    // The pinned (host, cwd) instance is OFFLINE; another instance is online. The wake must
    // NOT fall back to that online-elsewhere instance — routing to an unchosen cwd is the
    // defect. Notify-only, no wake anywhere.
    const onlineElsewhere = "conn-online-elsewhere";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineElsewhere, host: "other-host", cwd: "/home/u/dev/other" }),
      offlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd }),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd }),
    );

    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    // It must NOT have routed to the online-elsewhere connection.
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    // A notify-only offline pin is normal, not an error.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("an OFFLINE Task pin with NO online connection at all creates NO turn (the notification stands as the plain record)", async () => {
    // Agent is fully offline; the pinned instance exists (offline). An offline place is
    // not wakeable and there is no durable queue, so NO turn is created — the already-
    // created Notification stands as the plain record. This is the durable-queue removal.
    mockTaskFindFirst.mockResolvedValue({ targetHost: pinnedHost, targetCwd: pinnedCwd });
    mockListConnectionsForAgent.mockResolvedValue([
      offlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd }),
    ]);

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(result).toBeNull();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    // Not an error — a fully-offline target is a notification-only event.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  // ----- un-pinned: unchanged online-first -----

  it("an un-pinned mentioned wake uses online-first exactly as before (no Task read, no pin narrowing)", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: "conn-older", host: "host-B", cwd: "/home/u/dev/b" }),
    ]);

    await maybeCreateTurnForWakeNotification(ctx({ action: "mentioned" }));

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    // No pin on a mentioned wake → never reads the Task table.
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  it("a task_assigned wake whose Task records no pin (both columns null) uses online-first, unchanged", async () => {
    // mockTaskFindFirst default already returns { targetHost: null, targetCwd: null }.
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      offlineConn({ uuid: "conn-offline", host: pinnedHost, cwd: pinnedCwd }),
    ]);

    await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
  });

  it("treats an unknown-host + unknown-path pin (host '' + cwd null) as no pin → online-first (no false narrowing)", async () => {
    // A pin carrying no disambiguating info matches any legacy/unknown instance, so it
    // is NOT used to narrow — the wake stays online-first.
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    await maybeCreateTurnForWakeNotification(
      ctx({ action: "mentioned", pinnedHost: "", pinnedCwd: null }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
  });

  it("matches a pin against the registry's sentinels: host-only pin (unknown-path cwd null) on an ONLINE instance", async () => {
    // The owner pinned a host but the instance has an unknown path (legacy null cwd).
    // The pin's cwd normalizes to null and must match the connection's null cwd. The
    // matched instance is ONLINE, so the pin wins over the online-first entry.
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: "conn-nullcwd", host: pinnedHost, cwd: null }),
    ]);

    await maybeCreateTurnForWakeNotification(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd: null }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: "conn-nullcwd" }),
    );
  });
});

// ===== Directed live delivery (fix-pinned-wake-directed-delivery, T1) =====
//
// The five behavioral branches the spec delta defines for the LIVE wake:
//   1. pinned-online   → turn created on the pinned connection + `deliver_turn` ping to it
//                        + the resolved target SURFACED (transport-only) for suppression.
//   2. offline-pin     → NO turn, NO ping, NO target (notify-only; REVERSES #354 — see the
//                        OFFLINE-PIN block above for the no-fallback assertions).
//   3. un-pinned       → NO ping, NO target → broadcast → online-first, byte-identical.
//   4. elaboration_verified → directed to the idea's EXISTING online session origin (ping
//                        + target); no session / offline origin → no target (online-first).
//   5. cross-cwd mention → a pin resolving to a (host,cwd) different from the idea's
//                        existing session origin creates a PER-INSTANCE session (own
//                        transcript); the existing session's origin is never re-pointed.
describe("createTurnAndResolveTarget — directed live delivery", () => {
  const pinnedHost = "Laptop-Q3";
  const pinnedCwd = "/home/u/dev/payments";
  const pinnedConnUuid = "conn-pinned-target";

  function pinnedConn(overrides: Record<string, unknown> = {}) {
    return onlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd, ...overrides });
  }

  // ----- (1) pinned-online → turn + ping + target -----

  it("a pinned mentioned wake matching an ONLINE connection: creates the turn, PINGS that connection, and surfaces it as the target", async () => {
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "other-host", cwd: "/home/u/dev/other" }),
      pinnedConn(),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd }),
    );

    // Turn created on the pinned connection.
    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid }),
    );
    // deliver_turn ping emitted to ONLY the resolved target, carrying the precise turnUuid.
    expect(mockDeliverTurnPing).toHaveBeenCalledTimes(1);
    expect(mockDeliverTurnPing).toHaveBeenCalledWith({
      companyUuid,
      originConnectionUuid: pinnedConnUuid,
      turnUuid: turn?.uuid,
    });
    // The resolved target is surfaced transport-only (for non-target broadcast suppression).
    expect(targetConnectionUuid).toBe(pinnedConnUuid);
    // A directed wake does NOT set suppressWake — the target wakes (others suppress by target).
    expect(suppressWake).toBe(false);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("a pinned task_assigned wake matching an ONLINE connection: creates the turn, PINGS it, surfaces the target", async () => {
    mockTaskFindFirst.mockResolvedValue({ targetHost: pinnedHost, targetCwd: pinnedCwd });
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "other-host", cwd: "/home/u/dev/other" }),
      pinnedConn(),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid }),
    );
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid, turnUuid: turn?.uuid }),
    );
    expect(targetConnectionUuid).toBe(pinnedConnUuid);
  });

  // ----- (2) offline-pin → none -----

  it("an offline pin emits NO ping and surfaces NO target, but STAMPS suppressWake (notify-only, distinguishable from un-pinned)", async () => {
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-elsewhere", host: "other-host", cwd: "/home/u/dev/other" }),
      offlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd }),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd }),
    );

    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    // The offline-pin discriminator: suppressWake is TRUE so the daemon suppresses on EVERY
    // connection (an online-elsewhere instance must NOT be silently re-woken). This is what
    // makes an offline-pin distinguishable from an un-pinned wake (both carry null target).
    expect(suppressWake).toBe(true);
  });

  it("a fully-offline agent (none — no online connection at all) does NOT set suppressWake", async () => {
    // `none` (the agent has NO online connection) differs from `offline_pin`: nobody is
    // connected to receive the broadcast, and an un-pinned momentary-no-online wake must stay
    // byte-identical to before. So suppressWake stays FALSE — only a real offline-PIN suppresses.
    mockListConnectionsForAgent.mockResolvedValue([
      offlineConn({ uuid: "conn-offline-only", host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned" }),
    );

    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(suppressWake).toBe(false);
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
  });

  // ----- (3) un-pinned → no ping, no target (broadcast → online-first, unchanged) -----

  it("an un-pinned mentioned wake emits NO ping and surfaces NO target (broadcast → online-first, unchanged)", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: "conn-older", host: "host-B", cwd: "/home/u/dev/b" }),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned" }),
    );

    // Turn IS created (online-first), but NO directed delivery — exactly as before.
    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
    // An un-pinned wake does NOT suppress — the daemon broadcast wakes online-first,
    // byte-identical to before. This is the other half of the offline-pin discriminator.
    expect(suppressWake).toBe(false);
  });

  it("an un-pinned task_assigned wake (no Task pin) emits NO ping and surfaces NO target", async () => {
    // mockTaskFindFirst default returns { targetHost: null, targetCwd: null }.
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  // ----- (4) elaboration_verified → idea's existing online session origin + fallbacks ----

  it("elaboration_verified resolves the idea's EXISTING ONLINE session origin → ping + target", async () => {
    // The idea already has a daemon session whose origin lives on a SPECIFIC online
    // connection (NOT the online-first entry). The verify wake must be directed there.
    const ideaOriginConn = "conn-idea-origin";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: ideaOriginConn, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    // The idea-anchored session (sessionId === ideaUuid) lives on ideaOriginConn.
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaOriginConn });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    // The session lookup is keyed on the idea anchor.
    expect(mockDaemonSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyUuid, agentUuid, sessionId: ideaUuid }),
      }),
    );
    // Directed to the idea's existing origin, NOT online-first.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
    );
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn, turnUuid: turn?.uuid }),
    );
    expect(targetConnectionUuid).toBe(ideaOriginConn);
  });

  it("elaboration_verified with NO existing session falls back to online-first (no ping, no target)", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);
    // Default mockDaemonSessionFindFirst → null (no existing idea session).

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    // Turn IS created online-first (the pre-change behavior), but no directed delivery.
    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  it("elaboration_verified whose idea session origin is OFFLINE falls back to online-first (no ping, no target)", async () => {
    const onlineFirst = "conn-online-first";
    const offlineIdeaOrigin = "conn-idea-origin-offline";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      offlineConn({ uuid: offlineIdeaOrigin, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    // The idea session exists but its origin connection is OFFLINE → not wakeable.
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: offlineIdeaOrigin });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    // Offline origin is not wakeable → online-first fallback, no directed delivery.
    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  // ----- (5) cross-cwd mention → per-instance session, never re-point -----

  it("a cross-cwd mention (pin differs from the idea's existing session origin) creates a PER-INSTANCE session, never re-pointing", async () => {
    // The idea's canonical session lives on conn-idea-origin (/dev/ai-pm). A mention pins a
    // DIFFERENT online instance (/dev/strands). The wake must open a per-instance session
    // keyed on (idea, resolved connection) with directIdeaUuid = null (its own thread), and
    // pin its origin to the resolved connection — NEVER re-pointing the idea's session.
    const ideaSessionOrigin = "conn-idea-origin";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: ideaSessionOrigin, host: pinnedHost, cwd: "/home/u/dev/ai-pm" }),
      pinnedConn(),
    ]);
    // The existing idea-anchored session (sessionId === ideaUuid) lives on a DIFFERENT cwd.
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaSessionOrigin });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({
        action: "mentioned",
        entityType: "idea",
        entityUuid: ideaUuid,
        pinnedHost,
        pinnedCwd,
      }),
    );

    // Per-instance session: keyed on (idea, resolved connection), directIdeaUuid null,
    // origin = the resolved (pinned) connection — its OWN cwd-bound transcript.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: `${ideaUuid}::${pinnedConnUuid}`,
        directIdeaUuid: null,
        originConnectionUuid: pinnedConnUuid,
      }),
    );
    // The existing idea session's origin is NEVER re-pointed (no resolve on its origin/key).
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaSessionOrigin }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ideaUuid }),
    );
    // Directed delivery to the resolved (per-instance) connection.
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid, turnUuid: turn?.uuid }),
    );
    expect(targetConnectionUuid).toBe(pinnedConnUuid);
  });

  it("a pinned mention whose pin EQUALS the idea's existing session origin reuses the idea session (no per-instance suffix)", async () => {
    // When the pin resolves to the SAME connection the idea's session already lives on,
    // there is no cross-cwd divergence — the canonical idea session is reused (sessionId ===
    // ideaUuid, directIdeaUuid === ideaUuid), still directed.
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "other-host", cwd: "/home/u/dev/other" }),
      pinnedConn(),
    ]);
    // The idea's existing session already lives on the pinned connection.
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: pinnedConnUuid });

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({
        action: "mentioned",
        entityType: "idea",
        entityUuid: ideaUuid,
        pinnedHost,
        pinnedCwd,
      }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: ideaUuid,
        directIdeaUuid: ideaUuid,
        originConnectionUuid: pinnedConnUuid,
      }),
    );
    expect(targetConnectionUuid).toBe(pinnedConnUuid);
  });

  it("does NOT emit a directed ping for human_instruction (the keystone path is unchanged here)", async () => {
    // human_instruction's directed delivery is owned by daemon-instruction.service, not
    // this chokepoint — so createTurnAndResolveTarget must NOT also ping for it (no double
    // delivery) and surfaces no target.
    mockListConnectionsForAgent.mockResolvedValue([onlineConn()]);

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "human_instruction", instructionText: "do it" }),
    );

    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  it("emits exactly ONE directed ping per directed wake (the precise turn, not a connection sweep)", async () => {
    // deliverTurnPing is non-throwing by contract (its own try/catch swallows + logs), so a
    // directed wake always returns the turn + target, with a single ping carrying the
    // PRECISE turnUuid (never a connection-wide sweep that would drag other pending turns).
    mockListConnectionsForAgent.mockResolvedValue([pinnedConn()]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned", pinnedHost, pinnedCwd }),
    );

    expect(mockDeliverTurnPing).toHaveBeenCalledTimes(1);
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ turnUuid: turn?.uuid }),
    );
    expect(turn?.status).toBe("pending");
    expect(targetConnectionUuid).toBe(pinnedConnUuid);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

// ===== human_instruction — promptText denormalization =====
describe("maybeCreateTurnForWakeNotification — human_instruction promptText", () => {
  it("sets the turn's promptText to the notification's instructionText (canonical lives on the turn)", async () => {
    await maybeCreateTurnForWakeNotification(
      ctx({ action: "human_instruction", instructionText: "Please update the README" }),
    );

    expect(mockCreatePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "human_instruction",
        promptText: "Please update the README",
      }),
    );
  });

  it("leaves promptText null for autonomous (non-human_instruction) triggers even if instructionText is somehow present", async () => {
    await maybeCreateTurnForWakeNotification(
      ctx({ action: "task_assigned", instructionText: "ignored for autonomous wakes" }),
    );

    expect(mockCreatePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "task_assigned", promptText: null }),
    );
  });

  it("tolerates a missing instructionText on a human_instruction (promptText null)", async () => {
    await maybeCreateTurnForWakeNotification(ctx({ action: "human_instruction" }));

    expect(mockCreatePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "human_instruction", promptText: null }),
    );
  });
});

// ===== Skip conditions (no turn, no error) =====
describe("maybeCreateTurnForWakeNotification — skips without creating a turn", () => {
  it("skips a human recipient (only agents can be daemons)", async () => {
    const result = await maybeCreateTurnForWakeNotification(
      ctx({ recipientType: "user", recipientUuid: "user-1", action: "task_assigned" }),
    );

    expect(result).toBeNull();
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
  });

  it("skips a non-wake-triggering action before touching any service", async () => {
    const result = await maybeCreateTurnForWakeNotification(
      ctx({ action: "comment_added" }),
    );

    expect(result).toBeNull();
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
  });

  it("skips when the agent has no online connection (no daemon to wake)", async () => {
    mockListConnectionsForAgent.mockResolvedValue([offlineConn()]);

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(result).toBeNull();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    // A skip is NOT an error — nothing logged.
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("skips when the agent has no connections at all", async () => {
    mockListConnectionsForAgent.mockResolvedValue([]);

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(result).toBeNull();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
  });
});

// ===== Failure isolation (no silent errors; never aborts the notification) =====
describe("maybeCreateTurnForWakeNotification — failure isolation", () => {
  it("logs visibly and returns null (does not throw) when connection resolution throws", async () => {
    mockListConnectionsForAgent.mockRejectedValue(new Error("db down"));

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), action: "task_assigned", agentUuid }),
      expect.stringContaining("Failed to create DaemonSessionTurn"),
    );
  });

  it("logs visibly and returns null when lineage resolution throws", async () => {
    mockResolveDirectIdeaUuid.mockRejectedValue(new Error("lineage walk failed"));

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("logs visibly and returns null when session resolution throws", async () => {
    mockResolveOrCreateSession.mockRejectedValue(new Error("upsert conflict"));

    const result = await maybeCreateTurnForWakeNotification(ctx({ action: "mentioned" }));

    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("logs visibly and returns null when turn creation itself throws (the failure being isolated)", async () => {
    mockCreatePendingTurn.mockRejectedValue(new Error("turn create failed"));

    const result = await maybeCreateTurnForWakeNotification(
      ctx({ action: "human_instruction", instructionText: "do it" }),
    );

    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    // The thrown error never escapes — the caller (notification chokepoint) is unaffected.
  });

  it("does not log on a successful turn creation", async () => {
    await maybeCreateTurnForWakeNotification(ctx({ action: "task_assigned" }));

    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
