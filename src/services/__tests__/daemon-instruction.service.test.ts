import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonSession: {
    findFirst: vi.fn(),
  },
  daemonConnection: {
    findMany: vi.fn(),
  },
  agent: {
    count: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ===== Composed-service mocks (子1 + execution) =====
// daemon-session.service: keep the REAL typed errors + STALE_THRESHOLD_MS so `instanceof`
// checks and the staleness rule are exercised against the genuine artifacts; stub only the
// functions this module composes.
const mockResolveOrCreateSession = vi.fn();
const mockAssertContinuable = vi.fn();
const mockGetVisibleSessions = vi.fn();
vi.mock("@/services/daemon-session.service", () => {
  // Defined inside the factory (hoisted with the mock) so the class is initialized
  // before the SUT imports it. Mirrors the real SessionReadOnlyError shape.
  class SessionReadOnlyError extends Error {
    readonly code = "session_read_only";
    readonly originConnectionUuid: string;
    constructor(originConnectionUuid: string) {
      super("read only");
      this.name = "SessionReadOnlyError";
      this.originConnectionUuid = originConnectionUuid;
    }
  }
  return {
    resolveOrCreateSession: (...a: unknown[]) => mockResolveOrCreateSession(...a),
    assertContinuable: (...a: unknown[]) => mockAssertContinuable(...a),
    getVisibleSessions: (...a: unknown[]) => mockGetVisibleSessions(...a),
    SessionReadOnlyError,
    STALE_THRESHOLD_MS: 90_000,
  };
});

// The SUT now calls `createReturningTurn` so it receives the EXACT turn the chokepoint
// created (no `seq desc` read-back race). One spy backs both exports: the call-arg
// assertions below inspect the notification params it is handed; its resolved value is the
// `{ notification, turn }` shape `createReturningTurn` returns.
const mockNotificationCreate = vi.fn();
vi.mock("@/services/notification.service", () => ({
  create: (...a: unknown[]) => mockNotificationCreate(...a),
  createReturningTurn: (...a: unknown[]) => mockNotificationCreate(...a),
}));

const mockConnectionBelongsToAgent = vi.fn();
const mockIsConnectionLive = vi.fn();
vi.mock("@/services/daemon-execution.service", () => ({
  connectionBelongsToAgent: (...a: unknown[]) => mockConnectionBelongsToAgent(...a),
  isConnectionLive: (...a: unknown[]) => mockIsConnectionLive(...a),
}));

// daemon-control.service: stub dispatchControl so the test can assert the origin-only
// `deliver_turn` live ping is emitted after turn creation, and that a dispatch failure is
// NON-fatal to the send (the turn is persisted; reconnect-backfill is the durability net).
const mockDispatchControl = vi.fn();
vi.mock("@/services/daemon-control.service", () => ({
  dispatchControl: (...a: unknown[]) => mockDispatchControl(...a),
}));

// randomUUID — stub so the ad-hoc sessionId is deterministic in assertions.
const STUB_SESSION_ID = "adhoc-0000-0000-0000-000000000abc";
vi.mock("crypto", () => ({ randomUUID: () => STUB_SESSION_ID }));

import {
  MAX_INSTRUCTION_CHARS,
  AD_HOC_ENTITY_TYPE,
  validateInstructionText,
  InstructionTextError,
  SessionNotVisibleError,
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  sendInstruction,
  createAdHocSessionWithInstruction,
  getVisibleSessionsWithOrigin,
} from "@/services/daemon-instruction.service";
// The mocked SessionReadOnlyError class (defined in the vi.mock factory above), imported
// so the offline-origin test can construct + assert against the same class the SUT sees.
import { SessionReadOnlyError } from "@/services/daemon-session.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
// A DIFFERENT connection than the session's origin — used to prove the live ping targets
// ONLY the origin connection, never another connection of the same agent.
const otherConnectionUuid = "conn-0000-0000-0000-0000000000ff";
const sessionUuid = "sess-0000-0000-0000-000000000001";
const ideaUuid = "idea-0000-0000-0000-000000000001";
const adHocSessionId = "adhoc-sid-0000-0000-0000-00000001";
const turnUuid = "turn-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid };

// The `TurnView` shape `createReturningTurn` resolves with (ISO-string dates) — the exact
// turn the chokepoint created, returned to the send path without a read-back.
function turnView(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uuid: turnUuid,
    sessionUuid,
    seq: 1,
    trigger: "human_instruction",
    promptText: "do the thing",
    status: "pending",
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: "2026-06-19T03:00:00.000Z",
    ...overrides,
  };
}

function sessionView(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uuid: sessionUuid,
    agentUuid,
    sessionId: ideaUuid,
    directIdeaUuid: ideaUuid,
    originConnectionUuid: connectionUuid,
    status: "active",
    title: null,
    lastTurnAt: "2026-06-19T03:00:00.000Z",
    createdAt: "2026-06-19T03:00:00.000Z",
    updatedAt: "2026-06-19T03:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  // Default: idea-anchored session visible to the caller, origin online, turn created.
  mockPrisma.daemonSession.findFirst.mockResolvedValue({
    agentUuid,
    sessionId: ideaUuid,
    directIdeaUuid: ideaUuid,
    originConnectionUuid: connectionUuid,
  });
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.agent.count.mockResolvedValue(1);
  mockAssertContinuable.mockResolvedValue(connectionUuid);
  // createReturningTurn returns the notification + the EXACT turn the chokepoint created.
  mockNotificationCreate.mockResolvedValue({ notification: { uuid: "notif-1" }, turn: turnView() });
  mockResolveOrCreateSession.mockResolvedValue(sessionView({ directIdeaUuid: null, sessionId: STUB_SESSION_ID }));
  mockConnectionBelongsToAgent.mockResolvedValue(true);
  mockIsConnectionLive.mockResolvedValue(true);
  mockGetVisibleSessions.mockResolvedValue([]);
});

// ===== Constants =====
describe("constants", () => {
  it("MAX_INSTRUCTION_CHARS is a single positive named constant (4000)", () => {
    expect(typeof MAX_INSTRUCTION_CHARS).toBe("number");
    expect(MAX_INSTRUCTION_CHARS).toBe(4000);
  });

  it("AD_HOC_ENTITY_TYPE is OUTSIDE the lineage set (no lineage walk for ad-hoc)", () => {
    expect(["task", "document", "proposal", "idea"]).not.toContain(AD_HOC_ENTITY_TYPE);
  });
});

// ===== validateInstructionText =====
describe("validateInstructionText", () => {
  it("trims and returns the canonical text", () => {
    expect(validateInstructionText("  hello  ")).toBe("hello");
  });

  it("rejects empty string as `empty`", () => {
    try {
      validateInstructionText("");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InstructionTextError);
      expect((e as InstructionTextError).reason).toBe("empty");
    }
  });

  it("rejects whitespace-only as `empty`", () => {
    expect(() => validateInstructionText("   \n\t ")).toThrowError(InstructionTextError);
    try {
      validateInstructionText("   ");
    } catch (e) {
      expect((e as InstructionTextError).reason).toBe("empty");
    }
  });

  it("accepts text at exactly MAX_INSTRUCTION_CHARS (boundary inclusive)", () => {
    const atCap = "x".repeat(MAX_INSTRUCTION_CHARS);
    expect(validateInstructionText(atCap)).toHaveLength(MAX_INSTRUCTION_CHARS);
  });

  it("rejects text longer than MAX_INSTRUCTION_CHARS as `too_long`", () => {
    const over = "x".repeat(MAX_INSTRUCTION_CHARS + 1);
    try {
      validateInstructionText(over);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InstructionTextError);
      expect((e as InstructionTextError).reason).toBe("too_long");
    }
  });

  it("measures length on the TRIMMED text (whitespace not counted toward the cap)", () => {
    const padded = `  ${"x".repeat(MAX_INSTRUCTION_CHARS)}  `;
    expect(validateInstructionText(padded)).toHaveLength(MAX_INSTRUCTION_CHARS);
  });
});

// ===== sendInstruction =====
describe("sendInstruction", () => {
  it("idea-anchored session: creates one human_instruction turn via the chokepoint, session-key aligned to entityType:idea / entityUuid:directIdeaUuid", async () => {
    const { turn } = await sendInstruction(userAuth, {
      sessionUuid,
      instructionText: "  do the thing  ",
    });

    // notification.service.create is the single chokepoint that creates the turn.
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    const arg = mockNotificationCreate.mock.calls[0][0];
    expect(arg.action).toBe("human_instruction");
    expect(arg.recipientType).toBe("agent");
    expect(arg.recipientUuid).toBe(agentUuid);
    // Canonical text is the TRIMMED instruction.
    expect(arg.instructionText).toBe("do the thing");
    // Session-key alignment: idea-anchored → idea / directIdeaUuid (identity lineage).
    expect(arg.entityType).toBe("idea");
    expect(arg.entityUuid).toBe(ideaUuid);

    // No NEW session is created on the send path — the existing row is reused.
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();

    // Returns the created turn view (read back from the canonical turn table).
    expect(turn.uuid).toBe(turnUuid);
    expect(turn.trigger).toBe("human_instruction");
    expect(turn.status).toBe("pending");
  });

  it("ad-hoc session (directIdeaUuid=null): aligns on a NON-lineage entityType + entityUuid:sessionId", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      agentUuid,
      sessionId: adHocSessionId,
      directIdeaUuid: null,
      originConnectionUuid: connectionUuid,
    });
    await sendInstruction(userAuth, { sessionUuid, instructionText: "go" });
    const arg = mockNotificationCreate.mock.calls[0][0];
    expect(arg.entityType).toBe(AD_HOC_ENTITY_TYPE);
    expect(arg.entityUuid).toBe(adHocSessionId);
  });

  it("validates text BEFORE any lookup/turn — empty → InstructionTextError, no session lookup, no create", async () => {
    await expect(
      sendInstruction(userAuth, { sessionUuid, instructionText: "   " }),
    ).rejects.toBeInstanceOf(InstructionTextError);
    expect(mockPrisma.daemonSession.findFirst).not.toHaveBeenCalled();
    expect(mockAssertContinuable).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("over-length text → InstructionTextError before any turn", async () => {
    await expect(
      sendInstruction(userAuth, {
        sessionUuid,
        instructionText: "x".repeat(MAX_INSTRUCTION_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(InstructionTextError);
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("not-visible session → SessionNotVisibleError, no online check, no create", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    await expect(
      sendInstruction(userAuth, { sessionUuid, instructionText: "go" }),
    ).rejects.toBeInstanceOf(SessionNotVisibleError);
    expect(mockAssertContinuable).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("offline origin → SessionReadOnlyError propagates, no turn created, never re-routed", async () => {
    mockAssertContinuable.mockRejectedValue(new SessionReadOnlyError(connectionUuid));
    await expect(
      sendInstruction(userAuth, { sessionUuid, instructionText: "go" }),
    ).rejects.toBeInstanceOf(SessionReadOnlyError);
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("agent-key caller is owner/self-scoped on the session lookup (agentUuid filter)", async () => {
    await sendInstruction(agentAuth, { sessionUuid, instructionText: "go" });
    const where = mockPrisma.daemonSession.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ uuid: sessionUuid, companyUuid, agentUuid });
  });

  it("user caller is owner-scoped on the session lookup (agent.ownerUuid filter)", async () => {
    await sendInstruction(userAuth, { sessionUuid, instructionText: "go" });
    const where = mockPrisma.daemonSession.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ uuid: sessionUuid, companyUuid, agent: { ownerUuid } });
  });

  it("surfaces a clear error (no fabricated turn) if the chokepoint created no turn", async () => {
    mockNotificationCreate.mockResolvedValue({ notification: { uuid: "notif-1" }, turn: null });
    await expect(
      sendInstruction(userAuth, { sessionUuid, instructionText: "go" }),
    ).rejects.toThrow(/not created/i);
  });

  it("actorType reflects the caller kind (agent caller → actorType:agent)", async () => {
    await sendInstruction(agentAuth, { sessionUuid, instructionText: "go" });
    expect(mockNotificationCreate.mock.calls[0][0].actorType).toBe("agent");
  });
});

// ===== createAdHocSessionWithInstruction =====
describe("createAdHocSessionWithInstruction", () => {
  it("creates a session pinned to the chosen connection (directIdeaUuid=null, server-generated sessionId) + first turn", async () => {
    const { session, turn } = await createAdHocSessionWithInstruction(userAuth, {
      agentUuid,
      connectionUuid,
      instructionText: "kick off",
    });

    // resolveOrCreateSession composed with the SERVER-generated sessionId + null idea.
    expect(mockResolveOrCreateSession).toHaveBeenCalledTimes(1);
    const roc = mockResolveOrCreateSession.mock.calls[0][0];
    expect(roc.directIdeaUuid).toBeNull();
    expect(roc.sessionId).toBe(STUB_SESSION_ID);
    expect(roc.originConnectionUuid).toBe(connectionUuid);
    expect(roc.agentUuid).toBe(agentUuid);
    expect(roc.companyUuid).toBe(companyUuid);

    // First turn via the chokepoint, ad-hoc aligned (non-lineage entityType, entityUuid=sessionId).
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    const notif = mockNotificationCreate.mock.calls[0][0];
    expect(notif.action).toBe("human_instruction");
    expect(notif.entityType).toBe(AD_HOC_ENTITY_TYPE);
    expect(notif.entityUuid).toBe(STUB_SESSION_ID);
    expect(notif.instructionText).toBe("kick off");

    expect(session).toBeDefined();
    expect(turn.uuid).toBe(turnUuid);
  });

  it("unowned agent → ConnectionNotVisibleError, no session/turn created", async () => {
    mockPrisma.agent.count.mockResolvedValue(0);
    await expect(
      createAdHocSessionWithInstruction(userAuth, {
        agentUuid,
        connectionUuid,
        instructionText: "go",
      }),
    ).rejects.toBeInstanceOf(ConnectionNotVisibleError);
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("connection not belonging to the agent → ConnectionNotVisibleError (non-disclosure)", async () => {
    mockConnectionBelongsToAgent.mockResolvedValue(false);
    await expect(
      createAdHocSessionWithInstruction(userAuth, {
        agentUuid,
        connectionUuid,
        instructionText: "go",
      }),
    ).rejects.toBeInstanceOf(ConnectionNotVisibleError);
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
  });

  it("offline connection → ConnectionOfflineError, no session/turn created", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    await expect(
      createAdHocSessionWithInstruction(userAuth, {
        agentUuid,
        connectionUuid,
        instructionText: "go",
      }),
    ).rejects.toBeInstanceOf(ConnectionOfflineError);
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("empty text → InstructionTextError before any ownership/liveness check", async () => {
    await expect(
      createAdHocSessionWithInstruction(userAuth, {
        agentUuid,
        connectionUuid,
        instructionText: "  ",
      }),
    ).rejects.toBeInstanceOf(InstructionTextError);
    expect(mockConnectionBelongsToAgent).not.toHaveBeenCalled();
    expect(mockIsConnectionLive).not.toHaveBeenCalled();
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
  });

  it("agent-key caller may only target ITSELF (own agentUuid) — no agent.count query", async () => {
    await createAdHocSessionWithInstruction(agentAuth, {
      agentUuid,
      connectionUuid,
      instructionText: "go",
    });
    // self-scope short-circuits the ownership query.
    expect(mockPrisma.agent.count).not.toHaveBeenCalled();
    expect(mockResolveOrCreateSession).toHaveBeenCalledTimes(1);
  });

  it("agent-key caller targeting a DIFFERENT agent → ConnectionNotVisibleError", async () => {
    await expect(
      createAdHocSessionWithInstruction(agentAuth, {
        agentUuid: "some-other-agent",
        connectionUuid,
        instructionText: "go",
      }),
    ).rejects.toBeInstanceOf(ConnectionNotVisibleError);
    expect(mockResolveOrCreateSession).not.toHaveBeenCalled();
  });
});

// ===== Origin-only live delivery (子2 keystone — deliver_turn ping) =====
describe("origin-only live delivery (deliver_turn ping after turn creation)", () => {
  it("sendInstruction: dispatches deliver_turn targeting ONLY the session's origin connection, AFTER the turn is created", async () => {
    // Session's origin is `connectionUuid`; the agent also has another connection. The ping
    // must go to the origin ONLY (never the other connection / agent-wide fan-out).
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      agentUuid,
      sessionId: ideaUuid,
      directIdeaUuid: ideaUuid,
      originConnectionUuid: connectionUuid,
    });

    const order: string[] = [];
    mockNotificationCreate.mockImplementation(async () => {
      order.push("create");
      return { notification: { uuid: "notif-1" }, turn: turnView() };
    });
    mockDispatchControl.mockImplementation(() => {
      order.push("dispatch");
    });

    await sendInstruction(userAuth, { sessionUuid, instructionText: "go" });

    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "deliver_turn",
      // The PRECISE turn just created — so the daemon runs ONLY this turn, not a
      // connection-wide sweep of every still-pending turn.
      turnUuid,
    });
    // No entity, no instruction text on the wire (the daemon reads the turn by uuid).
    const arg = mockDispatchControl.mock.calls[0][0];
    expect(arg).not.toHaveProperty("entityType");
    expect(arg).not.toHaveProperty("entityUuid");
    expect(arg).not.toHaveProperty("instructionText");
    // Ordering: the turn is created (notification chokepoint) BEFORE the live ping.
    expect(order).toEqual(["create", "dispatch"]);
  });

  it("sendInstruction: the ping targets the ORIGIN connection even when it differs from the caller's view (never another connection of the agent)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      agentUuid,
      sessionId: ideaUuid,
      directIdeaUuid: ideaUuid,
      originConnectionUuid: otherConnectionUuid,
    });
    await sendInstruction(userAuth, { sessionUuid, instructionText: "go" });
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: otherConnectionUuid,
      command: "deliver_turn",
      turnUuid,
    });
  });

  it("sendInstruction: a deliver_turn dispatch FAILURE does NOT fail the send (turn already persisted; non-fatal)", async () => {
    mockDispatchControl.mockImplementation(() => {
      throw new Error("event bus down");
    });
    // The send still resolves with the created turn — the ping failure is swallowed + logged.
    const { turn } = await sendInstruction(userAuth, { sessionUuid, instructionText: "go" });
    expect(turn.uuid).toBe(turnUuid);
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
  });

  it("sendInstruction: does NOT dispatch when no turn was created (chokepoint bailed) — error surfaces first", async () => {
    mockNotificationCreate.mockResolvedValue({ notification: { uuid: "notif-1" }, turn: null });
    await expect(
      sendInstruction(userAuth, { sessionUuid, instructionText: "go" }),
    ).rejects.toThrow(/not created/i);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("createAdHocSessionWithInstruction: dispatches deliver_turn targeting the chosen (origin) connection after the first turn", async () => {
    await createAdHocSessionWithInstruction(userAuth, {
      agentUuid,
      connectionUuid,
      instructionText: "kick off",
    });
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "deliver_turn",
      turnUuid,
    });
  });

  it("createAdHocSessionWithInstruction: a dispatch failure does NOT fail the create-and-send (non-fatal)", async () => {
    mockDispatchControl.mockImplementation(() => {
      throw new Error("event bus down");
    });
    const { session, turn } = await createAdHocSessionWithInstruction(userAuth, {
      agentUuid,
      connectionUuid,
      instructionText: "kick off",
    });
    expect(session).toBeDefined();
    expect(turn.uuid).toBe(turnUuid);
  });

  it("no deliver_turn ping is emitted when validation fails before any turn (empty text)", async () => {
    await expect(
      sendInstruction(userAuth, { sessionUuid, instructionText: "   " }),
    ).rejects.toBeInstanceOf(InstructionTextError);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
});

// ===== getVisibleSessionsWithOrigin =====
describe("getVisibleSessionsWithOrigin", () => {
  it("returns [] without querying connections when there are no sessions", async () => {
    mockGetVisibleSessions.mockResolvedValue([]);
    const out = await getVisibleSessionsWithOrigin(userAuth);
    expect(out).toEqual([]);
    expect(mockPrisma.daemonConnection.findMany).not.toHaveBeenCalled();
  });

  it("derives originOnline per row using the STALE_THRESHOLD_MS verdict (online vs offline)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T03:00:00.000Z"));
    const onlineConn = "conn-online";
    const staleConn = "conn-stale";
    const offlineConn = "conn-offline";
    mockGetVisibleSessions.mockResolvedValue([
      sessionView({ uuid: "s1", originConnectionUuid: onlineConn }),
      sessionView({ uuid: "s2", originConnectionUuid: staleConn }),
      sessionView({ uuid: "s3", originConnectionUuid: offlineConn }),
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      // fresh, online → online
      { uuid: onlineConn, status: "online", lastSeenAt: new Date("2026-06-19T02:59:59.000Z") },
      // online but stale (> 90s) → offline
      { uuid: staleConn, status: "online", lastSeenAt: new Date("2026-06-19T02:58:00.000Z") },
      // fresh but status offline → offline
      { uuid: offlineConn, status: "offline", lastSeenAt: new Date("2026-06-19T03:00:00.000Z") },
    ]);

    const out = await getVisibleSessionsWithOrigin(userAuth);
    expect(out.find((s) => s.uuid === "s1")?.originOnline).toBe(true);
    expect(out.find((s) => s.uuid === "s2")?.originOnline).toBe(false);
    expect(out.find((s) => s.uuid === "s3")?.originOnline).toBe(false);

    // Connection liveness is batched: one query for the distinct origin uuids.
    expect(mockPrisma.daemonConnection.findMany).toHaveBeenCalledTimes(1);
    const where = mockPrisma.daemonConnection.findMany.mock.calls[0][0].where;
    expect(where.companyUuid).toBe(companyUuid);
    expect(where.uuid.in.sort()).toEqual([onlineConn, staleConn, offlineConn].sort());
    vi.useRealTimers();
  });

  it("a deleted/absent origin connection is treated as offline", async () => {
    mockGetVisibleSessions.mockResolvedValue([
      sessionView({ uuid: "s1", originConnectionUuid: "gone" }),
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
    const out = await getVisibleSessionsWithOrigin(userAuth);
    expect(out[0].originOnline).toBe(false);
  });

  it("returns NO turn/transcript bodies — only session metadata + originOnline", async () => {
    mockGetVisibleSessions.mockResolvedValue([sessionView({ uuid: "s1" })]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
    const out = await getVisibleSessionsWithOrigin(userAuth);
    expect(out[0]).not.toHaveProperty("turns");
    expect(out[0]).not.toHaveProperty("messages");
    expect(out[0]).toHaveProperty("sessionId");
    expect(out[0]).toHaveProperty("directIdeaUuid");
    expect(out[0]).toHaveProperty("originConnectionUuid");
    expect(out[0]).toHaveProperty("status");
    expect(out[0]).toHaveProperty("lastTurnAt");
    expect(out[0]).toHaveProperty("originOnline");
  });
});
