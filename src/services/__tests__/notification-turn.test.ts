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

// The assignment pin is now INSTANCE-based (T11): the bridge reads the wake's Task row
// (`assigneeType`/`assigneeUuid`) and, for the same-agent inheritance, the root Idea's row
// — then resolves an `agent_instance` assignee to its `(host, cwd)` place via
// prisma.agentInstance.findFirst. The directed-delivery change ALSO reads
// prisma.daemonSession.findFirst to (a) resolve an elaboration_verified wake's existing
// idea-session origin and (b) detect a cross-cwd directed mention (existing session origin
// != resolved target). Mock all four so these stay pure unit tests with no DB. Defaults:
// no Task pin (plain `agent` assignee → no instance pin); no root-idea pin (idea row also a
// plain agent); no instance row; no existing daemon session.
const mockTaskFindFirst = vi.hoisted(() => vi.fn());
const mockIdeaFindFirst = vi.hoisted(() => vi.fn());
const mockAgentInstanceFindFirst = vi.hoisted(() => vi.fn());
const mockDaemonSessionFindFirst = vi.hoisted(() => vi.fn());
// fix-daemon-conversation-split-cwd-agent: a cross-cwd directed idea wake RE-POINTS the
// idea's canonical session (prisma.daemonSession.update) instead of forking a per-instance
// `${idea}::${conn}` thread. Mock update so we can assert the re-point without a DB.
const mockDaemonSessionUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findFirst: mockTaskFindFirst },
    idea: { findFirst: mockIdeaFindFirst },
    agentInstance: { findFirst: mockAgentInstanceFindFirst },
    daemonSession: { findFirst: mockDaemonSessionFindFirst, update: mockDaemonSessionUpdate },
  },
}));

// The instance-inheritance step resolves the wake's ROOT idea via the shared lineage
// resolver. Mock it so we control which idea the wake inherits a pin from (or none).
// Default: the entity's lineage roots at `ideaUuid` (the same idea the session anchors on).
const mockResolveRootIdea = vi.hoisted(() => vi.fn());
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: mockResolveRootIdea,
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
const instanceUuid = "instance-0000-0000-0000-000000000001";

/**
 * Pin the wake's TASK row to an `agent_instance` at `(host, cwd)`. Sets the Task's
 * `assigneeType`/`assigneeUuid` to point at an instance, and stubs the AgentInstance
 * lookup to resolve that instance to its place (owned by `agentUuid` by default — the
 * task-override resolution does NOT apply the same-agent guard, but supplying the owner
 * keeps fixtures realistic).
 */
function pinTaskToInstance(
  host: string,
  cwd: string | null,
  opts: { instanceAgentUuid?: string; uuid?: string } = {},
) {
  const uuid = opts.uuid ?? instanceUuid;
  mockTaskFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: uuid });
  mockAgentInstanceFindFirst.mockResolvedValue({
    host,
    cwd,
    agentUuid: opts.instanceAgentUuid ?? agentUuid,
  });
}

/**
 * Pin the wake's ROOT IDEA to an `agent_instance` at `(host, cwd)` — the inheritance
 * source. `instanceAgentUuid` controls the same-agent guard: equal to the wake's target
 * agent → inherits; different → does NOT inherit (resolves its own agent). The Task stays
 * a plain `agent` (no override) so the root-idea step is reached.
 */
function pinIdeaToInstance(
  host: string,
  cwd: string | null,
  opts: { instanceAgentUuid?: string; uuid?: string } = {},
) {
  const uuid = opts.uuid ?? instanceUuid;
  mockIdeaFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: uuid });
  mockAgentInstanceFindFirst.mockResolvedValue({
    host,
    cwd,
    agentUuid: opts.instanceAgentUuid ?? agentUuid,
  });
}

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
  // Default: the assigned Task is a plain `agent` (un-pinned) — the unchanged online-first
  // path, no instance pin. Pin-honoring tests override per-case.
  mockTaskFindFirst.mockResolvedValue({ assigneeType: "agent", assigneeUuid: agentUuid });
  // Default: the wake's root idea is also a plain `agent` (no instance to inherit).
  mockIdeaFindFirst.mockResolvedValue({ assigneeType: "agent", assigneeUuid: agentUuid });
  // Default: no AgentInstance row resolves (no test pins to one unless it overrides).
  mockAgentInstanceFindFirst.mockResolvedValue(null);
  // Default: the entity's lineage roots at `ideaUuid` (the canonical idea anchor).
  mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: ideaUuid });
  // Default: no existing idea-anchored daemon session — so a directed wake creates the
  // canonical session fresh and an elaboration_verified wake has no origin to upgrade to
  // (online-first fallback). Cross-cwd / origin tests override per-case.
  mockDaemonSessionFindFirst.mockResolvedValue(null);
  // Default: the canonical-session re-point update resolves (no-op body) unless a case
  // asserts on its args.
  mockDaemonSessionUpdate.mockResolvedValue({});
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

  it("maps the human start-development wake to the distinct start_development trigger (NOT task_assigned)", () => {
    expect(triggerForAction("start_development")).toBe("start_development");
    // Its own trigger — never collapsed into task_assigned (that collapse was the
    // anti-pattern behind the 0.13.0 random-cwd wake defect).
    expect(triggerForAction("start_development")).not.toBe("task_assigned");
  });

  it("every mapped trigger value is a member of the turn-trigger taxonomy", () => {
    const allowed = new Set([
      "task_assigned",
      "mentioned",
      "elaboration",
      "elaboration_verified",
      "start_development",
      "yolo_requested",
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
    { action: "start_development", trigger: "start_development" },
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

// ===== Pinned-target instance routing (cwd-addressable instances, T11) =====
//
// The wake honors a pinned (host, cwd): a `mentioned` wake carries the pin on the
// context (threaded from the mention markup by mention.service); an assignment wake
// (task_assigned / idea_claimed) reads it from the Task's / root Idea's `agent_instance`
// assignee, resolved to its place. ALL pins are HARD now (owner choice B,
// pin-cwd-before-wake) — there is no SOFT assignment pin any more. ONLINE-ONLY selection:
//   - pin matches an ONLINE connection       → pin the session origin THERE (not [0])
//   - HARD pin matches NO online connection   → offline_pin: notify-only, NO wake (#354),
//                                               NEVER re-routed (mention AND assignment)
//   - no pin at all                           → online-first (unchanged)
//   - no online connection at all             → no turn (the notification stands)
// DEC-5: the cwd is ONLY ever the explicit pin — never inferred from the project.
describe("maybeCreateTurnForWakeNotification — pinned-target instance routing (T11)", () => {
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

  // ----- task_assigned wake: HARD pin read from the Task's agent_instance assignee -----

  it("reads the Task's agent_instance override and pins the matching LIVE connection for a task_assigned wake (HARD)", async () => {
    pinTaskToInstance(pinnedHost, pinnedCwd);
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
    // The Task's agent_instance assigneeUuid is resolved to its (host, cwd) place.
    expect(mockAgentInstanceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uuid: instanceUuid, companyUuid }),
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

  // ----- HARD assignment pin offline = notify-only, NO re-route (owner choice B) -----
  //
  // An assignment pin (Task agent_instance override / inherited idea instance) is now HARD
  // (owner choice B, pin-cwd-before-wake), identical to a mention pin: when its instance has
  // no online connection the wake is offline_pin (notify-only, suppressWake TRUE) — it is
  // NEVER re-routed to the agent's online-first connection. This INVERTS the former SOFT
  // "degrade to online-first" behavior.

  it("offline HARD Task pin (place not registered): notify-only, suppressWake TRUE, NO re-route to online-first", async () => {
    // Task pinned to an instance whose place is not registered online for this agent at all.
    pinTaskToInstance("ghost-host", "/no/such/path");
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    // HARD offline pin → notify-only: NO turn, NO ping, NO target.
    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    // Crucially it must NOT re-route to the agent's online-first connection.
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    // The offline-pin discriminator: suppressWake TRUE so every connection suppresses.
    expect(suppressWake).toBe(true);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("offline HARD Task pin matching an OFFLINE connection (online-elsewhere): notify-only, NO re-route", async () => {
    // The pinned instance is OFFLINE; another instance is online. A HARD pin is notify-only
    // and NEVER re-routes to the online-elsewhere connection (routing to an unchosen cwd is
    // the defect).
    pinTaskToInstance(pinnedHost, pinnedCwd);
    const onlineElsewhere = "conn-online-elsewhere";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineElsewhere, host: "other-host", cwd: "/home/u/dev/other" }),
      offlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd }),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    expect(turn).toBeNull();
    expect(targetConnectionUuid).toBeNull();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    // Must NOT re-route to the online-elsewhere connection.
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(suppressWake).toBe(true);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("a mention pin matching an OFFLINE connection (online-elsewhere) creates NO turn, NO ping, NO target (no silent re-route)", async () => {
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

  it("a HARD Task pin whose only connection is the offline pinned one → offline_pin, suppressWake TRUE", async () => {
    // The pinned instance is offline and it is the agent's ONLY connection. With a HARD pin
    // this is still offline_pin (a pin was present and matched no ONLINE connection), NOT
    // `none` — so suppressWake is TRUE. `none` is reserved for a genuinely UN-pinned wake
    // with no online connection. NO turn either way — the notification stands.
    pinTaskToInstance(pinnedHost, pinnedCwd);
    mockListConnectionsForAgent.mockResolvedValue([
      offlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd }),
    ]);

    const { turn, suppressWake } = await createTurnAndResolveTarget(ctx({ action: "task_assigned" }));

    expect(turn).toBeNull();
    expect(suppressWake).toBe(true);
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

  it("a task_assigned wake whose Task is a plain agent (no instance) uses online-first, unchanged", async () => {
    // mockTaskFindFirst default returns { assigneeType: "agent" } and the root idea is a
    // plain agent too — so no pin is resolved and the wake stays online-first.
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
    pinTaskToInstance(pinnedHost, pinnedCwd);
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
    // Defaults: Task and root idea are both plain `agent` → no instance pin resolved.
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

  // ----- (4b) start_development → same session-origin upgrade as elaboration_verified ----

  it("start_development resolves the idea's EXISTING ONLINE session origin → ping + target", async () => {
    // Q2: the start-development wake lands where the idea's conversation already
    // runs, never an arbitrary online cwd.
    const ideaOriginConn = "conn-idea-origin";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: ideaOriginConn, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaOriginConn });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "start_development", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
    );
    // The pending turn carries the dedicated trigger, not task_assigned.
    expect(mockCreatePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "start_development" }),
    );
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn, turnUuid: turn?.uuid }),
    );
    expect(targetConnectionUuid).toBe(ideaOriginConn);
  });

  it("start_development whose idea session origin is OFFLINE falls back to online-first (no ping, no target)", async () => {
    // Residual divergence (proposal review note 3): the server action validated
    // "any connection online", but the idea's session ORIGIN may still be offline.
    // The wake must then fall back to online-first instead of pinging a dead origin.
    const onlineFirst = "conn-online-first";
    const offlineIdeaOrigin = "conn-idea-origin-offline";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      offlineConn({ uuid: offlineIdeaOrigin, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: offlineIdeaOrigin });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "start_development", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  it("start_development with NO existing idea session falls back to online-first (no ping, no target)", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);
    // Default mockDaemonSessionFindFirst → null (no existing idea session).

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "start_development", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  // ----- (5) cross-cwd directed idea wake → RE-POINT the canonical session, never fork -----
  // fix-daemon-conversation-split-cwd-agent (idea 2ddd1d11): the old behavior forked a
  // per-instance `${idea}::${conn}` session (splitting the user's turn from the AI's replies
  // → no interrupt). The new behavior keeps ONE conversation per idea and re-points its
  // origin to the resolved online connection.

  it("a cross-cwd mention (pin differs from the idea's existing session origin) RE-POINTS the canonical session, never forking a per-instance thread", async () => {
    // The idea's canonical session (sessionId === ideaUuid) lives on conn-idea-origin
    // (/dev/ai-pm). A mention pins a DIFFERENT online instance (/dev/strands). The wake must
    // re-point that SAME session's origin to the resolved connection — keeping sessionId ===
    // ideaUuid and directIdeaUuid non-null — and NEVER mint an `${idea}::${conn}` thread.
    const ideaSessionOrigin = "conn-idea-origin";
    const ideaSessionUuid = "sess-idea-canonical";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: ideaSessionOrigin, host: pinnedHost, cwd: "/home/u/dev/ai-pm" }),
      pinnedConn(),
    ]);
    // The existing idea-anchored session (sessionId === ideaUuid) lives on a DIFFERENT cwd.
    mockDaemonSessionFindFirst.mockResolvedValue({
      uuid: ideaSessionUuid,
      originConnectionUuid: ideaSessionOrigin,
    });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({
        action: "mentioned",
        entityType: "idea",
        entityUuid: ideaUuid,
        pinnedHost,
        pinnedCwd,
      }),
    );

    // The canonical session's origin is RE-POINTED (companyUuid-scoped update on its uuid).
    expect(mockDaemonSessionUpdate).toHaveBeenCalledWith({
      where: { uuid: ideaSessionUuid, companyUuid: companyUuid },
      data: { originConnectionUuid: pinnedConnUuid },
    });
    // The turn lands on the SAME canonical session: sessionId === ideaUuid, directIdeaUuid
    // non-null, origin = the resolved (pinned) connection. NO `::` per-instance thread.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: ideaUuid,
        directIdeaUuid: ideaUuid,
        originConnectionUuid: pinnedConnUuid,
      }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: `${ideaUuid}::${pinnedConnUuid}` }),
    );
    // Directed delivery to the resolved connection (where the conversation now lives).
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
    mockDaemonSessionFindFirst.mockResolvedValue({
      uuid: "sess-idea-canonical",
      originConnectionUuid: pinnedConnUuid,
    });

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
    // Origin already matches → NO re-point (scoped to origin !== resolved).
    expect(mockDaemonSessionUpdate).not.toHaveBeenCalled();
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

  it("a directed cross-cwd human_instruction RE-POINTS the canonical session, never forking (AC-2 headline bug)", async () => {
    // The headline bug: a human types an instruction on an idea whose canonical session
    // lives on /dev/ai-pm, but the idea is instance-pinned to a DIFFERENT online cwd
    // (/dev/strands). The wake resolves `directed` on the pinned instance, so this MUST
    // re-point the canonical session (NOT fork `${idea}::${conn}`, which sent the user's
    // turn to a residual thread while the AI replied on the old one → could not interrupt).
    const ideaSessionOrigin = "conn-idea-origin";
    const ideaSessionUuid = "sess-idea-canonical";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: ideaSessionOrigin, host: pinnedHost, cwd: "/home/u/dev/ai-pm" }),
      pinnedConn(),
    ]);
    // The idea is instance-pinned to the (pinned) /dev/strands instance → resolves directed.
    mockIdeaFindFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: "inst-strands",
    });
    mockAgentInstanceFindFirst.mockResolvedValue({
      agentUuid,
      host: pinnedHost,
      cwd: pinnedCwd,
    });
    // The idea's canonical session lives on the OTHER cwd.
    mockDaemonSessionFindFirst.mockResolvedValue({
      uuid: ideaSessionUuid,
      originConnectionUuid: ideaSessionOrigin,
    });

    const { turn } = await createTurnAndResolveTarget(
      ctx({
        action: "human_instruction",
        entityType: "idea",
        entityUuid: ideaUuid,
        instructionText: "please continue over here",
      }),
    );

    // Re-point the canonical session — NOT a per-instance fork.
    expect(mockDaemonSessionUpdate).toHaveBeenCalledWith({
      where: { uuid: ideaSessionUuid, companyUuid: companyUuid },
      data: { originConnectionUuid: pinnedConnUuid },
    });
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: ideaUuid,
        directIdeaUuid: ideaUuid,
        originConnectionUuid: pinnedConnUuid,
      }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: `${ideaUuid}::${pinnedConnUuid}` }),
    );
    // The turn's canonical instruction body still lands on the (re-pointed) session.
    expect(turn?.promptText).toBe("please continue over here");
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

// ===== Instance-based pin LINEAGE: HARD pins, same-agent guard, idea inheritance (T11) =====
//
// resolvePinnedTarget resolves the pin from an INSTANCE lineage. ALL pins are HARD now
// (owner choice B, pin-cwd-before-wake), so selectOriginConnection applies the uniform
// offline policy (offline_pin / suppressWake — never a degrade to online-first):
//   1. mention pin (HARD, soft:false)             — covered above (offline_pin / suppressWake)
//   2. task override (HARD, soft:false)           — Task's own agent_instance assignee
//   3. root-idea inheritance (HARD, soft:false)   — root Idea's instance, SAME-AGENT only
//   4. else null → online-first
// This block exercises the lineage priority order, the same-agent guard, the idea-instance
// priority over the elaboration_verified session-origin heuristic, and idea_claimed (which
// now gains pin-reading via the root-idea step).
describe("createTurnAndResolveTarget — instance-based pin lineage (T11)", () => {
  const ideaHost = "idea-host";
  const ideaCwd = "/home/u/dev/idea-pin";
  const ideaConnUuid = "conn-idea-instance";
  const taskHost = "task-host";
  const taskCwd = "/home/u/dev/task-pin";
  const taskConnUuid = "conn-task-instance";
  const otherAgentUuid = "agent-OTHER-0000-0000-000000000099";

  function ideaInstanceConn(overrides: Record<string, unknown> = {}) {
    return onlineConn({ uuid: ideaConnUuid, host: ideaHost, cwd: ideaCwd, ...overrides });
  }
  function taskInstanceConn(overrides: Record<string, unknown> = {}) {
    return onlineConn({ uuid: taskConnUuid, host: taskHost, cwd: taskCwd, ...overrides });
  }

  // ----- (2) task override beats the inherited idea instance -----

  it("task override (agent_instance) beats the root-idea instance: targets the TASK's instance", async () => {
    // Both the Task and the root Idea are pinned to DIFFERENT instances. The task's own
    // override must win — the per-task agent_instance assignee is resolved first and the
    // root-idea step is never consulted for the place.
    mockTaskFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "task-inst" });
    mockIdeaFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "idea-inst" });
    // The instance lookup returns the TASK place first (task override), then the idea place
    // (only consulted if task had none — it shouldn't be here).
    mockAgentInstanceFindFirst.mockImplementation(
      async ({ where }: { where: { uuid: string } }) => {
        if (where.uuid === "task-inst") return { host: taskHost, cwd: taskCwd, agentUuid };
        if (where.uuid === "idea-inst") return { host: ideaHost, cwd: ideaCwd, agentUuid };
        return null;
      },
    );
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      ideaInstanceConn(),
      taskInstanceConn(),
    ]);

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    // Directed to the TASK's instance, not the idea's.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: taskConnUuid }),
    );
    expect(targetConnectionUuid).toBe(taskConnUuid);
  });

  // ----- (3) root-idea inheritance WITH the same-agent guard -----

  it("inherits the root-idea instance (SAME agent) when the Task has no override → targets the idea's instance", async () => {
    // Task is a plain `agent` (no override) so the root-idea step is reached; the idea is
    // pinned to an instance OWNED BY THE WAKE'S TARGET AGENT → inherit it.
    pinIdeaToInstance(ideaHost, ideaCwd); // instanceAgentUuid defaults to agentUuid (same)
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      ideaInstanceConn(),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    // The root idea was resolved and its instance inherited (directed there, not online-first).
    expect(mockResolveRootIdea).toHaveBeenCalledWith(companyUuid, "task", taskUuid);
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid }),
    );
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid, turnUuid: turn?.uuid }),
    );
    expect(targetConnectionUuid).toBe(ideaConnUuid);
  });

  // ----- (3) cross-agent → NO inherit (the same-agent guard blocks it) -----

  it("does NOT inherit the root-idea instance when it belongs to a DIFFERENT agent (same-agent guard) → online-first", async () => {
    // The idea is pinned to an instance of ANOTHER agent. The wake's target is `agentUuid`,
    // so the guard blocks inheritance and the wake resolves against its OWN agent (online-first).
    pinIdeaToInstance(ideaHost, ideaCwd, { instanceAgentUuid: otherAgentUuid });
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      // Even though the idea's instance place is online here, it must NOT be selected.
      ideaInstanceConn(),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    // No pin inherited → un-pinned online-first, NOT the idea's instance.
    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid }),
    );
    // The same-agent guard blocked inheritance → genuinely un-pinned → online-first, no
    // directed delivery (this is NOT a HARD-pin offline_pin: no pin was ever resolved).
    expect(targetConnectionUuid).toBeNull();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
  });

  // ----- a stale instance row (assignment points at a deleted instance) → online-first -----

  it("treats a missing AgentInstance row (stale assignment) as no pin → online-first", async () => {
    mockTaskFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "ghost-inst" });
    mockAgentInstanceFindFirst.mockResolvedValue(null); // instance row no longer exists
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(targetConnectionUuid).toBeNull();
  });

  // ----- idea_claimed gains pin-reading via the own-idea step (2.5) -----

  it("idea_claimed reads the idea's agent_instance pin and targets that instance (NEW: it had none before)", async () => {
    // An idea_claimed wake on an idea entity: the own-idea step (2.5) reads the idea's
    // OWN assignee via its direct anchor. Pinned to a same-agent instance → directed there.
    pinIdeaToInstance(ideaHost, ideaCwd);
    mockResolveDirectIdeaUuid.mockResolvedValue(ideaUuid);
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      ideaInstanceConn(),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "idea_claimed", entityType: "idea", entityUuid: ideaUuid }),
    );

    // The own-idea step resolves the idea's direct anchor (not the lineage root walk).
    expect(mockResolveDirectIdeaUuid).toHaveBeenCalledWith(companyUuid, "idea", ideaUuid);
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid }),
    );
    expect(targetConnectionUuid).toBe(ideaConnUuid);
    expect(turn?.status).toBe("pending");
  });

  // ----- multi-level lineage: a child idea's OWN pin beats its ancestor's (finding #2) -----

  it("a directly-pinned CHILD idea targets its OWN instance, NOT the root ancestor's (same agent)", async () => {
    // A child idea pinned to instance B; its lineage ROOT is pinned to a DIFFERENT
    // instance A of the SAME agent. The own-idea step (2.5) must win over root inheritance.
    const childIdeaUuid = "idea-child-0000-0000-0000-00000000c1";
    const rootIdeaUuid = "idea-root-0000-0000-0000-00000000a1";
    const childInstanceUuid = "instance-child-B";
    const rootInstanceUuid = "instance-root-A";
    const childHost = "child-host";
    const childCwd = "/home/u/dev/child";
    const childConnUuid = "conn-child-instance";

    // The wake is anchored on the CHILD idea; its direct anchor is itself, its root is the parent.
    mockResolveDirectIdeaUuid.mockResolvedValue(childIdeaUuid);
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid });

    // Idea lookups: child → instance B, root → instance A.
    mockIdeaFindFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) => {
      if (where.uuid === childIdeaUuid)
        return { assigneeType: "agent_instance", assigneeUuid: childInstanceUuid };
      if (where.uuid === rootIdeaUuid)
        return { assigneeType: "agent_instance", assigneeUuid: rootInstanceUuid };
      return null;
    });
    // Instance lookups: B = child place, A = root place — both owned by the SAME target agent.
    mockAgentInstanceFindFirst.mockImplementation(
      async ({ where }: { where: { uuid: string } }) => {
        if (where.uuid === childInstanceUuid) return { host: childHost, cwd: childCwd, agentUuid };
        if (where.uuid === rootInstanceUuid) return { host: ideaHost, cwd: ideaCwd, agentUuid };
        return null;
      },
    );
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      ideaInstanceConn(), // root A's connection (must NOT be chosen)
      onlineConn({ uuid: childConnUuid, host: childHost, cwd: childCwd }),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "idea_claimed", entityType: "idea", entityUuid: childIdeaUuid }),
    );

    // Directed to the CHILD's own instance B, NOT the root ancestor A.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: childConnUuid }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid }),
    );
    expect(targetConnectionUuid).toBe(childConnUuid);
    expect(turn?.status).toBe("pending");
  });

  it("a plain-agent CHILD idea (no own pin) INHERITS its root ancestor's instance (same agent)", async () => {
    // The child idea has no instance pin → own-idea step (2.5) yields nothing → falls
    // through to root inheritance, which targets the root's instance A.
    const childIdeaUuid = "idea-child-0000-0000-0000-00000000c2";
    const rootIdeaUuid = "idea-root-0000-0000-0000-00000000a2";
    const rootInstanceUuid = "instance-root-A2";

    mockResolveDirectIdeaUuid.mockResolvedValue(childIdeaUuid);
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid });
    mockIdeaFindFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) => {
      if (where.uuid === childIdeaUuid) return { assigneeType: "agent", assigneeUuid: agentUuid };
      if (where.uuid === rootIdeaUuid)
        return { assigneeType: "agent_instance", assigneeUuid: rootInstanceUuid };
      return null;
    });
    mockAgentInstanceFindFirst.mockResolvedValue({ host: ideaHost, cwd: ideaCwd, agentUuid });
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      ideaInstanceConn(),
    ]);

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "idea_claimed", entityType: "idea", entityUuid: childIdeaUuid }),
    );

    // Inherited the ROOT ancestor's instance A (no own pin to win).
    expect(targetConnectionUuid).toBe(ideaConnUuid);
  });

  // ----- elaboration_verified: idea-instance pin takes PRIORITY over the session-origin heuristic -----

  it("elaboration_verified targets the idea's INSTANCE pin OVER the existing session-origin heuristic", async () => {
    // The idea is pinned to instance A (online). It ALSO has an existing session whose origin
    // is a DIFFERENT online connection. The instance pin must WIN — the session-origin upgrade
    // is skipped because the selection is already `directed` on the instance.
    pinIdeaToInstance(ideaHost, ideaCwd);
    const sessionOrigin = "conn-session-origin";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      onlineConn({ uuid: sessionOrigin, host: "session-host", cwd: "/session" }),
      ideaInstanceConn(),
    ]);
    // The idea's existing session lives on a DIFFERENT connection than the instance pin.
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: sessionOrigin });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    // Directed to the INSTANCE pin, NOT the session origin.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: sessionOrigin }),
    );
    expect(targetConnectionUuid).toBe(ideaConnUuid);
    expect(turn?.status).toBe("pending");
  });

  it("elaboration_verified with NO idea-instance pin falls to the session-origin heuristic (then online-first)", async () => {
    // The idea is a plain `agent` (no instance pin) → the root-idea step yields no pin →
    // selection stays online_first → the LOWER-priority session-origin upgrade applies.
    // (mockIdeaFindFirst default is a plain agent.)
    const sessionOrigin = "conn-session-origin";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      onlineConn({ uuid: sessionOrigin, host: "session-host", cwd: "/session" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: sessionOrigin });

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "elaboration_verified", entityType: "idea", entityUuid: ideaUuid }),
    );

    // Falls to the session origin (the un-pinned heuristic), NOT online-first.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: sessionOrigin }),
    );
    expect(targetConnectionUuid).toBe(sessionOrigin);
    expect(turn?.status).toBe("pending");
  });

  // ----- a non-lineage entity (e.g. comment) skips the assignment-lineage reads entirely -----

  it("does NOT read Task/Idea/Instance/lineage for a non-lineage entity (mentioned comment) — pin is context-only", async () => {
    mockListConnectionsForAgent.mockResolvedValue([onlineConn()]);

    await createTurnAndResolveTarget(
      ctx({ action: "task_assigned", entityType: "comment", entityUuid: "comment-1" }),
    );

    // task_assigned on a non-lineage entity → no assignment-lineage reads at all.
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
    expect(mockIdeaFindFirst).not.toHaveBeenCalled();
    expect(mockAgentInstanceFindFirst).not.toHaveBeenCalled();
    expect(mockResolveRootIdea).not.toHaveBeenCalled();
  });

  // ----- a task override resolving to a no-info place falls THROUGH to root-idea inherit -----

  it("a Task agent_instance whose place carries no disambiguating info (host '' + cwd null) falls through to root-idea inheritance", async () => {
    // The Task IS pinned to an instance, but that instance resolves to (host '', cwd null) —
    // no disambiguating info → makePinnedTarget returns null → the task override yields no
    // pin and the resolver continues to the root-idea step, which inherits a real instance.
    mockTaskFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "blank-inst" });
    mockIdeaFindFirst.mockResolvedValue({ assigneeType: "agent_instance", assigneeUuid: "idea-inst" });
    mockAgentInstanceFindFirst.mockImplementation(
      async ({ where }: { where: { uuid: string } }) => {
        if (where.uuid === "blank-inst") return { host: "", cwd: null, agentUuid };
        if (where.uuid === "idea-inst") return { host: ideaHost, cwd: ideaCwd, agentUuid };
        return null;
      },
    );
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      ideaInstanceConn(),
    ]);

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    // The blank task override was skipped; the root-idea instance was inherited instead.
    expect(mockResolveRootIdea).toHaveBeenCalledWith(companyUuid, "task", taskUuid);
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaConnUuid }),
    );
    expect(targetConnectionUuid).toBe(ideaConnUuid);
  });

  // ----- a HARD idea-inherited pin that is OFFLINE is notify-only, NEVER re-routed -----

  it("an inherited (HARD) idea-instance pin that is OFFLINE is notify-only, suppressWake TRUE, NO re-route", async () => {
    // The inherited idea-instance pin is now HARD (owner choice B): when its instance is
    // offline the wake is offline_pin (notify-only, suppressWake TRUE) even though the agent
    // has another online connection — it is NEVER re-routed to online-first. This INVERTS
    // the former SOFT degrade-to-online-first behavior.
    pinIdeaToInstance(ideaHost, ideaCwd); // same agent → inherited, but offline below
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      offlineConn({ uuid: ideaConnUuid, host: ideaHost, cwd: ideaCwd }),
    ]);

    const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned" }),
    );

    // HARD offline pin → notify-only: NO turn, NO re-route to the online-first connection.
    expect(turn).toBeNull();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockCreatePendingTurn).not.toHaveBeenCalled();
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
    // HARD → notify-only, suppress on every connection.
    expect(suppressWake).toBe(true);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

// ===== Generalized idea-session-origin upgrade (fix-proposal-wake-session-origin) =====
//
// The session-origin upgrade — re-pointing an `online_first` selection to the idea's
// existing DaemonSession origin — used to be gated on `trigger === "elaboration_verified"`
// ONLY, so a proposal_approved / proposal_rejected wake (mapped to task_assigned) fanned out
// to an arbitrary online cwd. It is now generalized to the AUTONOMOUS IDEA-ANCHORED trigger
// family `{ task_assigned, elaboration, elaboration_verified }`, still gated on
// `selection.kind === "online_first"` so it never overrides a hard/soft pin, and STILL
// EXCLUDING `mentioned` (broadcast / no-target contract) and `human_instruction` (owns its
// own directed delivery in daemon-instruction.service).
describe("createTurnAndResolveTarget — generalized idea-session-origin upgrade", () => {
  const ideaOriginConn = "conn-idea-origin";

  // Two online connections; the idea's session lives on the SECOND (not online-first), so a
  // correct upgrade must select it over the first entry.
  function twoOnlineWithIdeaOrigin() {
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: ideaOriginConn, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaOriginConn });
  }

  // ----- proposal_approved / proposal_rejected → directed to the idea session origin -----

  for (const action of ["proposal_approved", "proposal_rejected"]) {
    it(`${action} routes an un-pinned idea's wake to its existing ONLINE session origin (ping + target)`, async () => {
      twoOnlineWithIdeaOrigin();

      const { turn, targetConnectionUuid, suppressWake } = await createTurnAndResolveTarget(
        ctx({ action, entityType: "proposal", entityUuid: "proposal-1" }),
      );

      // The session lookup is keyed on the idea anchor derived from the proposal lineage.
      expect(mockDaemonSessionFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyUuid, agentUuid, sessionId: ideaUuid }),
        }),
      );
      // Directed to the idea's existing origin, NOT the online-first entry.
      expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
      );
      expect(mockDeliverTurnPing).toHaveBeenCalledWith(
        expect.objectContaining({ originConnectionUuid: ideaOriginConn, turnUuid: turn?.uuid }),
      );
      expect(targetConnectionUuid).toBe(ideaOriginConn);
      expect(suppressWake).toBe(false);
      expect(mockLoggerError).not.toHaveBeenCalled();
    });
  }

  // ----- idea_claimed (no instance pin) → directed to the idea session origin -----

  it("idea_claimed routes to the idea's existing session origin when the idea has no instance pin", async () => {
    // idea entity, plain-agent assignee (default) → no pin → online_first → upgrade applies.
    twoOnlineWithIdeaOrigin();

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "idea_claimed", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
    );
    expect(targetConnectionUuid).toBe(ideaOriginConn);
  });

  // ----- plain idea-anchored task_assigned → directed to the idea session origin -----

  it("a plain idea-anchored task_assigned (task lineage → idea) routes to the idea's session origin", async () => {
    // Task and root idea are both plain agents (defaults) → no pin → online_first → upgrade.
    twoOnlineWithIdeaOrigin();

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned", entityType: "task", entityUuid: taskUuid }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
    );
    expect(mockDeliverTurnPing).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn, turnUuid: turn?.uuid }),
    );
    expect(targetConnectionUuid).toBe(ideaOriginConn);
  });

  // ----- PRIORITY PRESERVED: an instance pin still beats the session-origin upgrade -----

  it("an instance-pinned idea takes the pin over the session origin for proposal_approved (upgrade skipped)", async () => {
    // The root idea is pinned to an ONLINE instance; its existing session lives on a DIFFERENT
    // online connection. The pin must win — selection is already `directed` so the upgrade is
    // skipped (it only runs in the online_first branch).
    const pinnedHost = "pin-host";
    const pinnedCwd = "/home/u/dev/pinned";
    const pinnedConnUuid = "conn-pinned";
    pinIdeaToInstance(pinnedHost, pinnedCwd);
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: "conn-online-first", host: "x", cwd: "/x" }),
      onlineConn({ uuid: ideaOriginConn, host: "host-B", cwd: "/home/u/dev/idea" }),
      onlineConn({ uuid: pinnedConnUuid, host: pinnedHost, cwd: pinnedCwd }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaOriginConn });

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "proposal_approved", entityType: "proposal", entityUuid: "proposal-1" }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: pinnedConnUuid }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
    );
    expect(targetConnectionUuid).toBe(pinnedConnUuid);
  });

  // ----- FALLBACKS: no session / offline origin → online-first, no target -----

  it("proposal_approved with NO existing idea session falls back to online-first (no ping, no target)", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);
    // Default mockDaemonSessionFindFirst → null (no existing idea session).

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "proposal_approved", entityType: "proposal", entityUuid: "proposal-1" }),
    );

    expect(turn?.status).toBe("pending");
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  it("proposal_approved whose idea session origin is OFFLINE falls back to online-first (no ping, no target)", async () => {
    const onlineFirst = "conn-online-first";
    const offlineOrigin = "conn-idea-origin-offline";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      offlineConn({ uuid: offlineOrigin, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: offlineOrigin });

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "proposal_approved", entityType: "proposal", entityUuid: "proposal-1" }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  // ----- NO-LINEAGE NO-OP: a standalone task_assigned (directIdeaUuid null) stays online-first -----

  it("a standalone task_assigned with NO idea lineage (directIdeaUuid null) stays online-first (null-guard)", async () => {
    // The entity resolves to no idea anchor. Even with an (irrelevant) session row present,
    // resolveIdeaSessionOriginTarget's null-guard short-circuits → online-first, no target.
    mockResolveDirectIdeaUuid.mockResolvedValue(null);
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
    ]);

    const { turn, targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "task_assigned", entityType: "task", entityUuid: taskUuid }),
    );

    expect(turn?.status).toBe("pending");
    // Ad-hoc session keyed on the entity uuid, pinned online-first.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: taskUuid, directIdeaUuid: null, originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  // ----- EXCLUSIONS: mentioned + human_instruction are NOT upgraded even with a session -----

  it("an un-pinned mentioned wake is NOT redirected to the idea session origin (broadcast, no target)", async () => {
    // A resolvable idea session exists, but `mentioned` is excluded from the upgrade set: the
    // wake must stay online-first with no target (the un-pinned broadcast contract).
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: ideaOriginConn, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaOriginConn });

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "mentioned", entityType: "idea", entityUuid: ideaUuid }),
    );

    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockResolveOrCreateSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: ideaOriginConn }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });

  it("a human_instruction wake is NOT upgraded to the idea session origin even when one exists", async () => {
    const onlineFirst = "conn-online-first";
    mockListConnectionsForAgent.mockResolvedValue([
      onlineConn({ uuid: onlineFirst, host: "host-A", cwd: "/home/u/dev/a" }),
      onlineConn({ uuid: ideaOriginConn, host: "host-B", cwd: "/home/u/dev/idea" }),
    ]);
    mockDaemonSessionFindFirst.mockResolvedValue({ originConnectionUuid: ideaOriginConn });

    const { targetConnectionUuid } = await createTurnAndResolveTarget(
      ctx({ action: "human_instruction", entityType: "idea", entityUuid: ideaUuid, instructionText: "do it" }),
    );

    // human_instruction resolves its own delivery elsewhere; the chokepoint must not upgrade it.
    expect(mockResolveOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ originConnectionUuid: onlineFirst }),
    );
    expect(mockDeliverTurnPing).not.toHaveBeenCalled();
    expect(targetConnectionUuid).toBeNull();
  });
});
