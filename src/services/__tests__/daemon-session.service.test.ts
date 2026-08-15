import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonSession: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  daemonSessionTurn: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  daemonTranscriptMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
  },
  daemonConnection: {
    findFirst: vi.fn(),
  },
  daemonExecution: {
    findFirst: vi.fn(),
  },
  // The usage-write path (daemon-token-usage) batches the turn update + the session rollup
  // increment in one $transaction. The mock resolves the array of operations in order — the
  // service reads the first element (the turn row).
  $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

// Mock the EventBus so the unit test does not pull the real event-bus → redis →
// logger.child() chain and can assert the publish emit shape directly.
const mockEventBus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

// Mock lineage.service so resolveDirectIdeaUuid's reuse is asserted in isolation
// (no idea/task DB walk).
const mockResolveRootIdea = vi.hoisted(() => vi.fn());
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: mockResolveRootIdea,
}));

// Mock the connection registry module so importing STALE_THRESHOLD_MS does not pull
// its (logger-using) body; the real value is asserted against the literal below.
vi.mock("@/services/daemon-connection.service", () => ({
  STALE_THRESHOLD_MS: 90_000,
}));

import {
  TURN_TRIGGERS,
  TURN_STATUSES,
  MERGED_TURN_STATUS,
  SESSION_STATUSES,
  TRANSCRIPT_ROLES,
  MAX_TRANSCRIPT_MESSAGES_PER_SESSION,
  DEFAULT_TRANSCRIPT_MESSAGE_PAGE,
  STALE_THRESHOLD_MS,
  resolveOrCreateSession,
  resolveDirectIdeaUuid,
  createPendingTurn,
  findReusablePendingInstructionTurn,
  advanceTurn,
  getVisibleSessions,
  getSessionTurns,
  getSessionDetail,
  isSessionVisibleToCaller,
  assertContinuable,
  appendTranscriptMessages,
  advanceTurnForWake,
  getPendingTurnsForConnection,
  reconcileOrphanTurns,
  SessionReadOnlyError,
  transcriptEventName,
} from "@/services/daemon-session.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const otherCompanyUuid = "company-0000-0000-0000-000000000002";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const sessionUuid = "sess-0000-0000-0000-000000000001";
const sessionId = "idea-0000-0000-0000-000000000001"; // directIdeaUuid as session id
const turnUuid = "turn-0000-0000-0000-000000000001";

function sessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uuid: sessionUuid,
    agentUuid,
    sessionId,
    backendSessionId: null,
    directIdeaUuid: sessionId,
    originConnectionUuid: connectionUuid,
    status: "active",
    title: null,
    lastTurnAt: new Date("2026-06-15T03:00:00.000Z"),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    createdAt: new Date("2026-06-15T03:00:00.000Z"),
    updatedAt: new Date("2026-06-15T03:00:00.000Z"),
    ...overrides,
  };
}

function turnRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uuid: turnUuid,
    sessionUuid,
    seq: 1,
    trigger: "task_assigned",
    promptText: null,
    status: "pending",
    interruptedReason: null,
    relayError: null,
    usage: null,
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: new Date("2026-06-15T03:00:00.000Z"),
    ...overrides,
  };
}

let transcriptSeqCounter = 0;
function transcriptMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  transcriptSeqCounter += 1;
  return {
    uuid: `msg-${transcriptSeqCounter}`,
    turnUuid,
    role: "assistant",
    text: "hello",
    seq: transcriptSeqCounter,
    createdAt: new Date("2026-06-15T03:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockPrisma.daemonSession.upsert.mockResolvedValue(sessionRow());
  mockPrisma.daemonSession.findUnique.mockResolvedValue({ uuid: sessionUuid, companyUuid });
  mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
  mockPrisma.daemonSession.findMany.mockResolvedValue([]);
  mockPrisma.daemonSession.update.mockResolvedValue(sessionRow());
  mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(null);
  mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue(null);
  mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
  mockPrisma.daemonSessionTurn.create.mockResolvedValue(turnRow());
  mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow());
  mockPrisma.daemonSessionTurn.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.daemonTranscriptMessage.findFirst.mockResolvedValue(null);
  mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);
  mockPrisma.daemonTranscriptMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    transcriptMessageRow(data),
  );
  mockPrisma.daemonTranscriptMessage.count.mockResolvedValue(0);
  mockPrisma.daemonTranscriptMessage.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
  transcriptSeqCounter = 0;
  mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" });
});

// ===== Constants =====
describe("constants", () => {
  it("TURN_TRIGGERS covers the eight wake kinds (incl. the distinct elaboration_verified, start_development, and yolo_requested)", () => {
    expect([...TURN_TRIGGERS].sort()).toEqual(
      [
        "elaboration",
        "elaboration_verified",
        "human_instruction",
        "mentioned",
        "resume",
        "start_development",
        "yolo_requested",
        "task_assigned",
      ].sort(),
    );
  });

  it("TURN_TRIGGERS includes elaboration_verified as a member distinct from elaboration", () => {
    expect(TURN_TRIGGERS).toContain("elaboration_verified");
    expect(TURN_TRIGGERS).toContain("elaboration");
  });

  it("TURN_TRIGGERS includes start_development as a member distinct from task_assigned", () => {
    expect(TURN_TRIGGERS).toContain("start_development");
    expect(TURN_TRIGGERS).toContain("task_assigned");
  });

  it("TURN_TRIGGERS includes yolo_requested as a member distinct from task_assigned", () => {
    expect(TURN_TRIGGERS).toContain("yolo_requested");
    expect(TURN_TRIGGERS).toContain("task_assigned");
  });

  it("TURN_STATUSES are the strict forward lifecycle pending/running/ended|interrupted", () => {
    expect([...TURN_STATUSES]).toEqual(["pending", "running", "ended", "interrupted"]);
  });

  it("MERGED_TURN_STATUS is 'merged' and is a SERVER-ONLY settlement status — NOT in the daemon-reportable TURN_STATUSES", () => {
    // A coalesced-away pending turn is settled to this terminal status by the server; the
    // daemon never reports it, so it must stay out of the turn-advance lifecycle enum.
    expect(MERGED_TURN_STATUS).toBe("merged");
    expect([...TURN_STATUSES]).not.toContain(MERGED_TURN_STATUS);
  });

  it("SESSION_STATUSES are active/ended", () => {
    expect([...SESSION_STATUSES]).toEqual(["active", "ended"]);
  });

  it("re-exports the registry's STALE_THRESHOLD_MS (no second constant)", () => {
    expect(STALE_THRESHOLD_MS).toBe(90_000);
  });

  it("transcriptEventName keys per session", () => {
    expect(transcriptEventName(sessionUuid)).toBe(`transcript:${sessionUuid}`);
  });

  it("TRANSCRIPT_ROLES are exactly user/assistant (no tool/thinking)", () => {
    expect([...TRANSCRIPT_ROLES]).toEqual(["user", "assistant"]);
  });

  it("MAX_TRANSCRIPT_MESSAGES_PER_SESSION is a positive named constant", () => {
    expect(typeof MAX_TRANSCRIPT_MESSAGES_PER_SESSION).toBe("number");
    expect(MAX_TRANSCRIPT_MESSAGES_PER_SESSION).toBeGreaterThan(0);
  });
});

// ===== resolveOrCreateSession =====
describe("resolveOrCreateSession", () => {
  it("upserts on (agentUuid, sessionId) — the stable conversation key", async () => {
    await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId,
      directIdeaUuid: sessionId,
      originConnectionUuid: connectionUuid,
    });
    const arg = mockPrisma.daemonSession.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ agentUuid_sessionId: { agentUuid, sessionId } });
  });

  it("CREATE fixes originConnectionUuid + directIdeaUuid + companyUuid at creation", async () => {
    await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId,
      directIdeaUuid: sessionId,
      originConnectionUuid: connectionUuid,
    });
    const create = mockPrisma.daemonSession.upsert.mock.calls[0][0].create;
    expect(create.originConnectionUuid).toBe(connectionUuid);
    expect(create.directIdeaUuid).toBe(sessionId);
    expect(create.companyUuid).toBe(companyUuid);
    expect(create.status).toBe("active");
  });

  it("UPDATE re-affirms companyUuid but does NOT touch originConnectionUuid/directIdeaUuid (write-once)", async () => {
    await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId,
      directIdeaUuid: "a-different-idea",
      originConnectionUuid: "a-different-connection",
    });
    const update = mockPrisma.daemonSession.upsert.mock.calls[0][0].update;
    expect(update.companyUuid).toBe(companyUuid);
    // The origin connection + direct idea are write-once: never in the UPDATE branch,
    // so a later wake cannot move the origin (continuation is cwd-bound).
    expect(update).not.toHaveProperty("originConnectionUuid");
    expect(update).not.toHaveProperty("directIdeaUuid");
  });

  it("REUSES the existing row on a second wake (upsert resolves to the same uuid)", async () => {
    // upsert is the resolve-or-create primitive; the mock returns the existing row.
    mockPrisma.daemonSession.upsert.mockResolvedValue(sessionRow({ uuid: sessionUuid }));
    const first = await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId,
      directIdeaUuid: sessionId,
      originConnectionUuid: connectionUuid,
    });
    const second = await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId,
      directIdeaUuid: sessionId,
      originConnectionUuid: connectionUuid,
    });
    expect(first.uuid).toBe(second.uuid);
    // Both calls key on the SAME (agentUuid, sessionId) — no second business key.
    expect(mockPrisma.daemonSession.upsert.mock.calls[0][0].where).toEqual(
      mockPrisma.daemonSession.upsert.mock.calls[1][0].where,
    );
  });

  it("coerces a missing directIdeaUuid to null (ad-hoc session)", async () => {
    await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId: "adhoc-uuid",
      originConnectionUuid: connectionUuid,
    });
    expect(mockPrisma.daemonSession.upsert.mock.calls[0][0].create.directIdeaUuid).toBeNull();
  });

  it("projects ISO-8601 timestamps in the view", async () => {
    const view = await resolveOrCreateSession({
      companyUuid,
      agentUuid,
      sessionId,
      directIdeaUuid: sessionId,
      originConnectionUuid: connectionUuid,
    });
    expect(view.lastTurnAt).toBe("2026-06-15T03:00:00.000Z");
    expect(view.createdAt).toBe("2026-06-15T03:00:00.000Z");
    expect(view.directIdeaUuid).toBe(sessionId);
  });

  it("PROPAGATES a write failure (does not swallow — session must exist before a turn)", async () => {
    mockPrisma.daemonSession.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      resolveOrCreateSession({ companyUuid, agentUuid, sessionId, originConnectionUuid: connectionUuid }),
    ).rejects.toThrow("db down");
  });
});

// ===== resolveDirectIdeaUuid (lineage reuse) =====
describe("resolveDirectIdeaUuid", () => {
  it("delegates to lineage.service.resolveRootIdea and returns its directIdeaUuid", async () => {
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: "root-i",
      directIdeaUuid: "direct-i",
      lineage: [],
      resolvedVia: "via_proposal",
    });
    const result = await resolveDirectIdeaUuid(companyUuid, "task", "task-1");
    expect(mockResolveRootIdea).toHaveBeenCalledWith(companyUuid, "task", "task-1");
    expect(result).toBe("direct-i");
  });

  it("returns null when the entity has no idea ancestor (a success, not an error)", async () => {
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: null,
      directIdeaUuid: null,
      lineage: [],
      resolvedVia: "no_proposal",
    });
    await expect(resolveDirectIdeaUuid(companyUuid, "task", "task-1")).resolves.toBeNull();
  });

  it("PROPAGATES a lineage query failure", async () => {
    mockResolveRootIdea.mockRejectedValue(new Error("db down"));
    await expect(resolveDirectIdeaUuid(companyUuid, "task", "task-1")).rejects.toThrow("db down");
  });
});

// ===== createPendingTurn =====
describe("createPendingTurn", () => {
  it("assigns seq=1 for the first turn (no prior turns), status=pending", async () => {
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(null);
    mockPrisma.daemonSessionTurn.create.mockResolvedValue(turnRow({ seq: 1 }));
    const view = await createPendingTurn({ sessionUuid, trigger: "task_assigned" });
    const createArg = mockPrisma.daemonSessionTurn.create.mock.calls[0][0];
    expect(createArg.data.seq).toBe(1);
    expect(createArg.data.status).toBe("pending");
    expect(createArg.data.trigger).toBe("task_assigned");
    expect(view.seq).toBe(1);
  });

  it("assigns a MONOTONIC seq = max(existing) + 1", async () => {
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ seq: 7 });
    mockPrisma.daemonSessionTurn.create.mockResolvedValue(turnRow({ seq: 8 }));
    await createPendingTurn({ sessionUuid, trigger: "mentioned" });
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[0][0].data.seq).toBe(8);
    // The max read orders by seq desc, take the first (highest).
    expect(mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0].orderBy).toEqual({ seq: "desc" });
  });

  it("H2 REGRESSION: retries on a P2002 seq conflict (concurrent same-session create) instead of dropping the turn", async () => {
    // Two concurrent creates race for the same seq; the loser hits the
    // @@unique([sessionUuid, seq]) → P2002. createPendingTurn must re-read the max and
    // retry (landing a distinct seq), NOT let the turn be silently dropped.
    mockPrisma.daemonSessionTurn.findFirst
      .mockResolvedValueOnce({ seq: 4 }) // attempt 1 reads max=4 → tries seq=5
      .mockResolvedValueOnce({ seq: 5 }); // attempt 2 re-reads max=5 → tries seq=6
    mockPrisma.daemonSessionTurn.create
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockResolvedValueOnce(turnRow({ seq: 6 }));

    const view = await createPendingTurn({ sessionUuid, trigger: "mentioned" });

    expect(mockPrisma.daemonSessionTurn.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[0][0].data.seq).toBe(5);
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[1][0].data.seq).toBe(6);
    expect(view.seq).toBe(6);
  });

  it("H2: a non-P2002 create error propagates immediately (no retry, no swallow)", async () => {
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ seq: 1 });
    mockPrisma.daemonSessionTurn.create.mockRejectedValue(
      Object.assign(new Error("db down"), { code: "P1001" }),
    );
    await expect(createPendingTurn({ sessionUuid, trigger: "mentioned" })).rejects.toThrow("db down");
    expect(mockPrisma.daemonSessionTurn.create).toHaveBeenCalledTimes(1);
  });

  it("records promptText for a human_instruction turn (canonical instruction text)", async () => {
    mockPrisma.daemonSessionTurn.create.mockResolvedValue(
      turnRow({ trigger: "human_instruction", promptText: "please refactor X" }),
    );
    const view = await createPendingTurn({
      sessionUuid,
      trigger: "human_instruction",
      promptText: "please refactor X",
    });
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[0][0].data.promptText).toBe("please refactor X");
    expect(view.promptText).toBe("please refactor X");
  });

  it("nulls promptText for an autonomous trigger", async () => {
    await createPendingTurn({ sessionUuid, trigger: "task_assigned" });
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[0][0].data.promptText).toBeNull();
  });

  it("bumps the session's lastTurnAt", async () => {
    await createPendingTurn({ sessionUuid, trigger: "task_assigned" });
    const updateArg = mockPrisma.daemonSession.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ uuid: sessionUuid });
    expect(updateArg.data.lastTurnAt).toBeInstanceOf(Date);
  });

  it("PUBLISHES the turn_created SSE event on transcript:{sessionUuid}", async () => {
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ uuid: sessionUuid, companyUuid });
    mockPrisma.daemonSessionTurn.create.mockResolvedValue(turnRow({ seq: 1 }));
    await createPendingTurn({ sessionUuid, trigger: "task_assigned" });
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockEventBus.emit.mock.calls[0];
    expect(eventName).toBe(`transcript:${sessionUuid}`);
    expect(eventName).toBe(transcriptEventName(sessionUuid));
    expect(payload.trigger).toBe("turn_created");
    expect(payload.companyUuid).toBe(companyUuid);
    expect(payload.sessionUuid).toBe(sessionUuid);
    expect(payload.turn.uuid).toBe(turnUuid);
    expect(payload.turn.status).toBe("pending");
    // No messages changed on a turn-create — the tail is always present, empty here.
    expect(payload.messages).toEqual([]);
  });

  it("throws when the sessionUuid does not resolve (a turn cannot exist without its session)", async () => {
    mockPrisma.daemonSession.findUnique.mockResolvedValue(null);
    await expect(createPendingTurn({ sessionUuid, trigger: "task_assigned" })).rejects.toThrow(
      /not found/,
    );
    // No turn written, no event emitted on the failure path.
    expect(mockPrisma.daemonSessionTurn.create).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("PROPAGATES a turn write failure (no silent swallow — a lost turn loses a wake)", async () => {
    mockPrisma.daemonSessionTurn.create.mockRejectedValue(new Error("db down"));
    await expect(createPendingTurn({ sessionUuid, trigger: "task_assigned" })).rejects.toThrow("db down");
  });
});

// ===== findReusablePendingInstructionTurn (fix #444 idempotency) =====
describe("findReusablePendingInstructionTurn", () => {
  it("returns the matching pending human_instruction turn's view when one exists", async () => {
    const existing = turnRow({
      seq: 3,
      trigger: "human_instruction",
      promptText: "does app/samples exist?",
      status: "pending",
    });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(existing);

    const view = await findReusablePendingInstructionTurn(sessionUuid, "does app/samples exist?");

    // Scoped query: same session + pending + human_instruction + exact text, oldest-first.
    expect(mockPrisma.daemonSessionTurn.findFirst).toHaveBeenCalledWith({
      where: {
        sessionUuid,
        status: "pending",
        trigger: "human_instruction",
        promptText: "does app/samples exist?",
      },
      orderBy: { seq: "asc" },
    });
    expect(view).not.toBeNull();
    expect(view?.uuid).toBe(turnUuid);
    expect(view?.status).toBe("pending");
  });

  it("returns null when no matching pending instruction turn exists (different text / already running / none)", async () => {
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(null);
    const view = await findReusablePendingInstructionTurn(sessionUuid, "a fresh instruction");
    expect(view).toBeNull();
  });
});

// ===== advanceTurn (strict pending → running → ended | interrupted) =====
describe("advanceTurn", () => {
  it("running → interrupted: persists status + interruptedReason + endedAt, emits turn_status_changed", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    const endedAt = new Date("2026-06-15T05:00:00.000Z");
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "interrupted", interruptedReason: "shutdown", endedAt }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurn(turnUuid, "interrupted", {
      endedAt,
      interruptedReason: "shutdown",
    });
    expect(res).toMatchObject({ ok: true });
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.status).toBe("interrupted");
    expect(data.interruptedReason).toBe("shutdown");
    expect(data.endedAt).toBe(endedAt);

    // The SSE trigger fires exactly as for ended, carrying the reason in the view.
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockEventBus.emit.mock.calls[0];
    expect(eventName).toBe(`transcript:${sessionUuid}`);
    expect(payload.trigger).toBe("turn_status_changed");
    expect(payload.turn.status).toBe("interrupted");
    expect(payload.turn.interruptedReason).toBe("shutdown");
  });

  it("REJECTS pending → interrupted (a pending turn stays recoverable via backfill)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    const res = await advanceTurn(turnUuid, "interrupted", { interruptedReason: "offline" });
    expect(res).toEqual({
      ok: false,
      reason: "invalid_transition",
      from: "pending",
      to: "interrupted",
    });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("REJECTS any transition out of the terminal interrupted state (incl. a late running→ended report)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "interrupted",
    });
    // The daemon finished the subprocess after the server already reconciled the turn
    // interrupted(offline) — its late `ended` report must lose the race, writing nothing.
    const res = await advanceTurn(turnUuid, "ended");
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition", from: "interrupted", to: "ended" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("REJECTS ended → interrupted (terminal states never cross)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "ended",
    });
    const res = await advanceTurn(turnUuid, "interrupted", { interruptedReason: "offline" });
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition", from: "ended", to: "interrupted" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("REJECTS re-applying interrupted → interrupted", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "interrupted",
    });
    const res = await advanceTurn(turnUuid, "interrupted", { interruptedReason: "offline" });
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("DROPS interruptedReason on a non-interrupted edge (invariant: reason iff interrupted)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "ended" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });
    // A stray reason alongside a legal → ended must not decorate the ended turn.
    await advanceTurn(turnUuid, "ended", { interruptedReason: "crash" });
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.status).toBe("ended");
    expect(data).not.toHaveProperty("interruptedReason");
  });

  it("PERSISTS relayError on a → ended edge and surfaces it in the view (fix #444 follow-up)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "ended", relayError: "transcript upload returned 502" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurn(turnUuid, "ended", {
      relayError: "transcript upload returned 502",
    });
    expect(res).toMatchObject({ ok: true });
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.relayError).toBe("transcript upload returned 502");
    // Surfaced in the emitted view so a live viewer patches the row without a refetch.
    const [, payload] = mockEventBus.emit.mock.calls[0];
    expect(payload.turn.relayError).toBe("transcript upload returned 502");
  });

  it("PERSISTS relayError on a → interrupted edge too (a dirty exit can still lose transcript)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "interrupted", interruptedReason: "crash", relayError: "boom" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    await advanceTurn(turnUuid, "interrupted", {
      interruptedReason: "crash",
      relayError: "boom",
    });
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.relayError).toBe("boom");
  });

  it("IGNORES relayError on a → running edge (annotation is terminal-only)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    await advanceTurn(turnUuid, "running", { relayError: "should be ignored" });
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("relayError");
  });

  // ===== Per-turn token usage (daemon-token-usage) =====
  const sampleUsage = {
    inputTokens: 10,
    outputTokens: 214,
    cacheCreationTokens: 24701,
    cacheReadTokens: 0,
    model: "claude-haiku-4-5",
    source: "claude_code",
  };

  it("PERSISTS usage JSON + increments the session rollup ATOMICALLY in one $transaction on → ended", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "ended", usage: sampleUsage }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurn(turnUuid, "ended", { usage: sampleUsage });
    expect(res).toMatchObject({ ok: true });

    // ONE $transaction batching the turn update + the session rollup increment (atomic).
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Turn update wrote the whole usage object verbatim into the single JSON column.
    const turnData = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(turnData.usage).toEqual(sampleUsage);
    // Session rollup used Prisma's atomic increment (NOT a read-modify-write) for ALL FOUR
    // fields — in/out AND cache-read/cache-write (whole-session cache for the header tooltip).
    const sessionData = mockPrisma.daemonSession.update.mock.calls[0][0];
    expect(sessionData.where).toEqual({ uuid: sessionUuid });
    expect(sessionData.data.totalInputTokens).toEqual({ increment: 10 });
    expect(sessionData.data.totalOutputTokens).toEqual({ increment: 214 });
    expect(sessionData.data.totalCacheReadTokens).toEqual({ increment: 0 });
    expect(sessionData.data.totalCacheCreationTokens).toEqual({ increment: 24701 });
    // The view surfaces the usage object.
    const [, payload] = mockEventBus.emit.mock.calls[0];
    expect(payload.turn.usage).toEqual(sampleUsage);
  });

  it("increments the rollup by 0 for a null token field (partial usage never NaNs the total)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    const partial = { ...sampleUsage, outputTokens: null };
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "ended", usage: partial }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    await advanceTurn(turnUuid, "ended", { usage: partial });
    const sessionData = mockPrisma.daemonSession.update.mock.calls[0][0];
    expect(sessionData.data.totalInputTokens).toEqual({ increment: 10 });
    expect(sessionData.data.totalOutputTokens).toEqual({ increment: 0 });
  });

  it("IGNORES usage on a → running edge (annotation is terminal-only; no rollup, no $transaction)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    await advanceTurn(turnUuid, "running", { usage: sampleUsage });
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("usage");
    // No rollup increment and no $transaction on a non-terminal edge (plain single update).
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSession.update).not.toHaveBeenCalled();
  });

  it("a terminal edge WITHOUT usage does a plain update (no rollup, no $transaction) — unchanged behavior", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "ended" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    await advanceTurn(turnUuid, "ended", {});
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSession.update).not.toHaveBeenCalled();
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("usage");
  });

  it("toTurnView projects a malformed stored usage blob to null (never throws)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    // A legacy/garbled blob (no `source`, junk shape) must project to null, not crash.
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "ended", usage: { garbage: true, inputTokens: "nope" } }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurn(turnUuid, "ended", {});
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.turn.usage).toBeNull();
  });

  it("pending → running: updates status, records startedAt + executionUuid, emits turn_status_changed", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    const startedAt = new Date("2026-06-15T04:00:00.000Z");
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "running", startedAt, executionUuid: "exec-1" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurn(turnUuid, "running", { startedAt, executionUuid: "exec-1" });
    expect(res).toMatchObject({ ok: true });
    const updateArg = mockPrisma.daemonSessionTurn.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ uuid: turnUuid });
    expect(updateArg.data.status).toBe("running");
    expect(updateArg.data.startedAt).toBe(startedAt);
    expect(updateArg.data.executionUuid).toBe("exec-1");

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockEventBus.emit.mock.calls[0];
    expect(eventName).toBe(`transcript:${sessionUuid}`);
    expect(payload.trigger).toBe("turn_status_changed");
    expect(payload.companyUuid).toBe(companyUuid);
    expect(payload.turn.status).toBe("running");
    // No messages changed on a status transition — the tail is always present, empty.
    expect(payload.messages).toEqual([]);
  });

  it("running → ended: updates status, records endedAt, emits turn_status_changed", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    const endedAt = new Date("2026-06-15T05:00:00.000Z");
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "ended", endedAt }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurn(turnUuid, "ended", { endedAt });
    expect(res).toMatchObject({ ok: true });
    expect(mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data.endedAt).toBe(endedAt);
    expect(mockEventBus.emit.mock.calls[0][1].trigger).toBe("turn_status_changed");
  });

  it("REJECTS a skip (pending → ended) as invalid_transition and writes nothing", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    const res = await advanceTurn(turnUuid, "ended");
    expect(res).toEqual({ ok: false, reason: "invalid_transition", from: "pending", to: "ended" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("REJECTS a backward move (running → pending) as invalid_transition", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    const res = await advanceTurn(turnUuid, "pending");
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition", from: "running", to: "pending" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("REJECTS re-applying the same status (running → running)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    const res = await advanceTurn(turnUuid, "running");
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("REJECTS any transition out of the terminal ended state", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "ended",
    });
    const res = await advanceTurn(turnUuid, "running");
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition", from: "ended" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("returns not_found when the turn does not exist (no update, no emit)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue(null);
    const res = await advanceTurn(turnUuid, "running");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("M2: THROWS (no tenant-less SSE) if the session is missing for a just-updated turn", async () => {
    // The turn updates fine, but its session lookup returns null (torn write / corruption).
    // advanceTurn must throw rather than emit an event with companyUuid: "" that a future
    // 子3 SSE consumer's multi-tenancy fence could mishandle.
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue(null);

    await expect(advanceTurn(turnUuid, "running")).rejects.toThrow(/session .* missing/);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("leaves unspecified opt columns untouched (only status when no opts)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });
    await advanceTurn(turnUuid, "running");
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data).toEqual({ status: "running" });
    expect(data).not.toHaveProperty("startedAt");
    expect(data).not.toHaveProperty("endedAt");
    expect(data).not.toHaveProperty("executionUuid");
  });

  it("PROPAGATES a write failure on a legal transition", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "pending",
    });
    mockPrisma.daemonSessionTurn.update.mockRejectedValue(new Error("db down"));
    await expect(advanceTurn(turnUuid, "running")).rejects.toThrow("db down");
  });
});

// ===== getVisibleSessions (owner/self + companyUuid scoping) =====
describe("getVisibleSessions", () => {
  it("USER caller: owner-scoped via agent.ownerUuid, companyUuid-scoped, ordered lastTurnAt desc", async () => {
    mockPrisma.daemonSession.findMany.mockResolvedValue([sessionRow()]);
    const result = await getVisibleSessions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(mockPrisma.daemonSession.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agent: { ownerUuid } },
      orderBy: { lastTurnAt: "desc" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(sessionUuid);
    expect(result[0].backendSessionId).toBeNull();
  });

  it("super_admin caller is owner-scoped too (the agent relation, not the company at large)", async () => {
    mockPrisma.daemonSession.findMany.mockResolvedValue([]);
    await getVisibleSessions({ type: "super_admin", companyUuid, actorUuid: ownerUuid });
    const arg = mockPrisma.daemonSession.findMany.mock.calls[0][0];
    expect(arg.where.agent).toEqual({ ownerUuid });
    expect(arg.where.agentUuid).toBeUndefined();
  });

  it("AGENT-KEY caller: self-scoped via agentUuid (not the owner relation)", async () => {
    mockPrisma.daemonSession.findMany.mockResolvedValue([]);
    await getVisibleSessions({ type: "agent", companyUuid, actorUuid: agentUuid });
    expect(mockPrisma.daemonSession.findMany.mock.calls[0][0].where).toEqual({
      companyUuid,
      agentUuid,
    });
  });

  it("the where clause always carries the caller's companyUuid (never crosses companies)", async () => {
    mockPrisma.daemonSession.findMany.mockResolvedValue([]);
    await getVisibleSessions({ type: "user", companyUuid: otherCompanyUuid, actorUuid: ownerUuid });
    expect(mockPrisma.daemonSession.findMany.mock.calls[0][0].where.companyUuid).toBe(otherCompanyUuid);
  });

  it("PROPAGATES a query error (read, does NOT swallow to [])", async () => {
    mockPrisma.daemonSession.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      getVisibleSessions({ type: "user", companyUuid, actorUuid: ownerUuid }),
    ).rejects.toThrow("db down");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

// ===== getSessionTurns (visibility fence + 404 non-disclosure) =====
describe("getSessionTurns", () => {
  it("USER caller: resolves the session under owner-scope, returns ordered turns", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t1", seq: 1 }),
      turnRow({ uuid: "t2", seq: 2 }),
    ]);
    const result = await getSessionTurns({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where).toEqual({
      uuid: sessionUuid,
      companyUuid,
      agent: { ownerUuid },
    });
    expect(mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0]).toEqual({
      where: { sessionUuid },
      orderBy: { seq: "asc" },
    });
    expect(result?.map((t) => t.uuid)).toEqual(["t1", "t2"]);
  });

  it("AGENT-KEY caller: resolves the session under self-scope (agentUuid)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    await getSessionTurns({ type: "agent", companyUuid, actorUuid: agentUuid }, sessionUuid);
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where).toEqual({
      uuid: sessionUuid,
      companyUuid,
      agentUuid,
    });
  });

  it("returns null (404 non-disclosure) when the session is NOT visible to the caller", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const result = await getSessionTurns({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);
    expect(result).toBeNull();
    // It must NOT then query turns for a session the caller cannot see.
    expect(mockPrisma.daemonSessionTurn.findMany).not.toHaveBeenCalled();
  });

  it("cross-company: a session in another company is not visible (companyUuid in the fence)", async () => {
    // The fence query carries the caller's company; the session row resolves to null.
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const result = await getSessionTurns(
      { type: "user", companyUuid: otherCompanyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where.companyUuid).toBe(otherCompanyUuid);
    expect(result).toBeNull();
  });

  it("a visible session with zero turns returns an empty array (not null)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    const result = await getSessionTurns({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);
    expect(result).toEqual([]);
  });

  it("renders a 'merged' turn (coalesced-away) without error — a settled, non-error status passes through toTurnView", async () => {
    // AC: a server-settled `merged` turn must read back cleanly alongside ordinary turns —
    // TurnView.status is a free string, so the read never rejects it as unknown/error.
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t1", seq: 1, status: "ended" }),
      turnRow({ uuid: "t2", seq: 2, status: "merged" }),
    ]);
    const result = await getSessionTurns({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);
    expect(result?.map((t) => ({ uuid: t.uuid, status: t.status }))).toEqual([
      { uuid: "t1", status: "ended" },
      { uuid: "t2", status: "merged" },
    ]);
  });

  it("PROPAGATES a query error (read, does not swallow)", async () => {
    mockPrisma.daemonSession.findFirst.mockRejectedValue(new Error("db down"));
    await expect(
      getSessionTurns({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid),
    ).rejects.toThrow("db down");
  });
});

// ===== isSessionVisibleToCaller (SSE transcript subscription gate) =====
describe("isSessionVisibleToCaller", () => {
  it("USER caller: true when the session resolves under owner-scope; selects only uuid", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    const visible = await isSessionVisibleToCaller(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );
    expect(visible).toBe(true);
    const call = mockPrisma.daemonSession.findFirst.mock.calls[0][0];
    expect(call.where).toEqual({ uuid: sessionUuid, companyUuid, agent: { ownerUuid } });
    // A cheap existence check — never loads the transcript.
    expect(call.select).toEqual({ uuid: true });
    expect(mockPrisma.daemonSessionTurn.findMany).not.toHaveBeenCalled();
  });

  it("AGENT-KEY caller: resolves under self-scope (agentUuid)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    await isSessionVisibleToCaller(
      { type: "agent", companyUuid, actorUuid: agentUuid },
      sessionUuid,
    );
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where).toEqual({
      uuid: sessionUuid,
      companyUuid,
      agentUuid,
    });
  });

  it("false (non-disclosure) when the session is NOT visible to the caller", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const visible = await isSessionVisibleToCaller(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );
    expect(visible).toBe(false);
  });

  it("cross-company: false (companyUuid is in the fence)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const visible = await isSessionVisibleToCaller(
      { type: "user", companyUuid: otherCompanyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where.companyUuid).toBe(
      otherCompanyUuid,
    );
    expect(visible).toBe(false);
  });

  it("PROPAGATES a query error (read, does not swallow)", async () => {
    mockPrisma.daemonSession.findFirst.mockRejectedValue(new Error("db down"));
    await expect(
      isSessionVisibleToCaller({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid),
    ).rejects.toThrow("db down");
  });
});

// ===== getSessionDetail (MESSAGE-level pagination, composite cursor, synthetic slot) =====
//
// The service loads the candidate turns (`daemonSessionTurn.findMany`, seq DESC, fenced
// `seq <= beforeTurnSeq` when a cursor is given), then their real messages in ONE
// batched query (`daemonTranscriptMessage.findMany`, ordered (turnUuid asc, seq asc)).
// It builds a unified `(turn.seq desc, msg.seq desc)` stream where every turn gets a
// `(seq = 0)` slot — a RENDERED synthetic `user` message for a promptText turn, a
// PLACEHOLDER otherwise — applies the composite `before` predicate, takes `limit + 1`,
// reverses to ascending, and groups into bands. So a test just supplies candidate turns
// + their messages and asserts the page bands + hasMore + (oldestTurnSeq, oldestMsgSeq).
describe("getSessionDetail", () => {
  it("VISIBLE session: returns { session, turns } with each turn's real messages folded ascending by seq", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // Candidate turns come back seq DESC (newest-first), as the real DB orders them.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    // Real messages for BOTH turns, ordered (turnUuid asc, seq asc) as the query asks.
    // (Default turns here are autonomous: promptText null → placeholder slots, not rendered.)
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "m1", turnUuid: "t1", role: "user", text: "do X", seq: 1 }),
      transcriptMessageRow({ uuid: "m2", turnUuid: "t1", role: "assistant", text: "did X", seq: 2 }),
      transcriptMessageRow({ uuid: "m3", turnUuid: "t2", role: "user", text: "do Y", seq: 1 }),
    ]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    // Session resolved under owner-scope + companyUuid (non-disclosure fence).
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where).toEqual({
      uuid: sessionUuid,
      companyUuid,
      agent: { ownerUuid },
    });
    expect(result?.session.uuid).toBe(sessionUuid);
    expect(result?.session.backendSessionId).toBeNull();
    // Returned ascending for top-to-bottom rendering, regardless of the DESC fetch.
    expect(result?.turns.map((t) => t.uuid)).toEqual(["t1", "t2"]);
    // Only 3 real messages total (< page size) → no earlier page.
    expect(result?.hasMore).toBe(false);
    // Oldest message in the page = the placeholder slot of t1 (turnSeq 1, msgSeq 0),
    // which sorts ahead of t1's real seq>=1 messages. The cursor is read from the SLOT.
    expect(result?.oldestTurnSeq).toBe(1);
    expect(result?.oldestMsgSeq).toBe(0);
    // Real messages folded into the right turn, ascending by seq (placeholder slots emit
    // nothing into the rendered list). TranscriptMessageView shape preserved.
    expect(result?.turns[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2"]);
    expect(result?.turns[0].messages[0]).toEqual({
      uuid: "m1",
      turnUuid: "t1",
      role: "user",
      text: "do X",
      seq: 1,
      createdAt: "2026-06-15T03:00:00.000Z",
    });
    expect(result?.turns[1].messages.map((m) => m.uuid)).toEqual(["m3"]);
  });

  it("loads candidate turns' messages in ONE batched query (no N+1), keyed on the candidate turn uuids", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t3", seq: 3 }),
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    await getSessionDetail({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);

    // Exactly ONE message query regardless of turn count, keyed on the candidate turn
    // uuids, ordered (turnUuid asc, seq asc).
    expect(mockPrisma.daemonTranscriptMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.daemonTranscriptMessage.findMany.mock.calls[0][0]).toEqual({
      where: { turnUuid: { in: ["t3", "t2", "t1"] } },
      orderBy: [{ turnUuid: "asc" }, { seq: "asc" }],
    });
    // Candidate turns are read seq DESC; with NO cursor there is no take cap (the page
    // window is computed in memory over the message stream) and no seq filter. The
    // candidate query is the LAST turn findMany (the read-time orphan-reconcile probe
    // runs first on this path).
    const turnArgs = mockPrisma.daemonSessionTurn.findMany.mock.calls.at(-1)![0];
    expect(turnArgs.orderBy).toEqual({ seq: "desc" });
    expect(turnArgs.where).toEqual({ sessionUuid });
  });

  it("DEFAULT page size is DEFAULT_TRANSCRIPT_MESSAGE_PAGE (20) MESSAGES, not turns", async () => {
    expect(DEFAULT_TRANSCRIPT_MESSAGE_PAGE).toBe(20);
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // One prompt-less turn with 25 real messages — more than the 20-message default.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ uuid: "t1", seq: 1 })]);
    const msgs = Array.from({ length: 25 }, (_, i) =>
      transcriptMessageRow({ uuid: `m${i + 1}`, turnUuid: "t1", seq: i + 1 }),
    );
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue(msgs);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    // The single turn is a PARTIAL band carrying only the newest 20 messages (seq 6..25);
    // the placeholder slot (seq 0) plus the oldest 5 messages are older than the page.
    expect(result?.turns).toHaveLength(1);
    expect(result?.turns[0].messages).toHaveLength(20);
    expect(result?.turns[0].messages[0].seq).toBe(6);
    expect(result?.turns[0].messages[19].seq).toBe(25);
    expect(result?.hasMore).toBe(true);
    // The page's oldest message is seq 6 of turn 1 → the next composite cursor.
    expect(result?.oldestTurnSeq).toBe(1);
    expect(result?.oldestMsgSeq).toBe(6);
  });

  it("PAGE SIZE clamp: a non-positive or oversized limit is clamped to [1, 200] MESSAGES", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // 3 messages on one prompt-less turn; limit 0 clamps to 1 → only the newest message.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ uuid: "t1", seq: 1 })]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "m1", turnUuid: "t1", seq: 1 }),
      transcriptMessageRow({ uuid: "m2", turnUuid: "t1", seq: 2 }),
      transcriptMessageRow({ uuid: "m3", turnUuid: "t1", seq: 3 }),
    ]);

    const clampedLow = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 0 },
    );
    // limit clamped to 1 → exactly the single newest message (seq 3), hasMore true.
    expect(clampedLow?.turns[0].messages.map((m) => m.seq)).toEqual([3]);
    expect(clampedLow?.hasMore).toBe(true);

    // limit 9999 clamps to 200 (a no-op ceiling here) → the whole conversation fits.
    const clampedHigh = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 9999 },
    );
    expect(clampedHigh?.turns[0].messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(clampedHigh?.hasMore).toBe(false);
  });

  it("COMPOSITE CURSOR: candidate turns fenced seq <= beforeTurnSeq; messages strictly older than (T, M)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // The cursor turn (seq 3) is INCLUDED in the candidate set (its older messages may
    // still belong before the cursor); the service filters the stream by the composite
    // predicate in memory.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t3", seq: 3 }),
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "t3m1", turnUuid: "t3", seq: 1 }),
      transcriptMessageRow({ uuid: "t3m2", turnUuid: "t3", seq: 2 }),
      transcriptMessageRow({ uuid: "t3m3", turnUuid: "t3", seq: 3 }),
      transcriptMessageRow({ uuid: "t2m1", turnUuid: "t2", seq: 1 }),
    ]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 50, beforeTurnSeq: 3, beforeMsgSeq: 2 },
    );

    // Candidate turn query fenced `seq <= beforeTurnSeq` (the cursor turn itself stays in
    // so its older messages can be returned). The candidate query is the LAST turn
    // findMany (the read-time orphan-reconcile probe runs first on this path).
    const turnArgs = mockPrisma.daemonSessionTurn.findMany.mock.calls.at(-1)![0];
    expect(turnArgs.where).toEqual({ sessionUuid, seq: { lte: 3 } });
    // Only messages strictly older than (turnSeq 3, msgSeq 2): t3's seq 1 (and its slot
    // seq 0), plus all of t2 and t1's slots. t3's seq 2 and 3 are at/after the cursor →
    // excluded. So t3 keeps only t3m1.
    expect(result?.turns.find((t) => t.uuid === "t3")?.messages.map((m) => m.uuid)).toEqual([
      "t3m1",
    ]);
    // No t3m2/t3m3 anywhere in the result (not repeated, not skipped past).
    const allUuids = result?.turns.flatMap((t) => t.messages.map((m) => m.uuid)) ?? [];
    expect(allUuids).not.toContain("t3m2");
    expect(allUuids).not.toContain("t3m3");
    expect(allUuids).toContain("t2m1");
  });

  it("COMPOSITE CURSOR: load-earlier across a turn boundary mid-page neither repeats nor skips the boundary message", async () => {
    // First page: limit 2 over a session of two prompt-less turns —
    //   t2 has real seq 1; t1 has real seq 1,2.
    // Stream (turnSeq desc, msgSeq desc): (2,1)t2m1, (2,0)slot2, (1,2)t1m2, (1,1)t1m1, (1,0)slot1.
    // Page 1 (newest 2): (2,1)t2m1, (2,0)slot2 → cursor (oldestTurnSeq 2, oldestMsgSeq 0).
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "t1m1", turnUuid: "t1", seq: 1 }),
      transcriptMessageRow({ uuid: "t1m2", turnUuid: "t1", seq: 2 }),
      transcriptMessageRow({ uuid: "t2m1", turnUuid: "t2", seq: 1 }),
    ]);

    const page1 = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 2 },
    );
    expect(page1?.turns.find((t) => t.uuid === "t2")?.messages.map((m) => m.uuid)).toEqual([
      "t2m1",
    ]);
    expect(page1?.hasMore).toBe(true);
    expect(page1?.oldestTurnSeq).toBe(2);
    expect(page1?.oldestMsgSeq).toBe(0);

    // Page 2: feed the page-1 cursor back. Candidates are now seq <= 2 (DB would return
    // t2,t1; the service windows by the composite predicate). The window keeps everything
    // strictly older than (2,0): t1m2 (1,2), t1m1 (1,1), slot1 (1,0).
    vi.clearAllMocks();
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "t1m1", turnUuid: "t1", seq: 1 }),
      transcriptMessageRow({ uuid: "t1m2", turnUuid: "t1", seq: 2 }),
      transcriptMessageRow({ uuid: "t2m1", turnUuid: "t2", seq: 1 }),
    ]);

    const page2 = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 2, beforeTurnSeq: page1!.oldestTurnSeq!, beforeMsgSeq: page1!.oldestMsgSeq! },
    );

    // t2m1 (on page 1) is NOT repeated; t1's seq 1,2 (the boundary messages) are returned
    // exactly once, none skipped. With limit 2 the page is the newest 2 older entries:
    // t1m2 (1,2) and t1m1 (1,1); slot1 (1,0) is the +1 → hasMore true.
    const page2Uuids = page2?.turns.flatMap((t) => t.messages.map((m) => m.uuid)) ?? [];
    expect(page2Uuids).not.toContain("t2m1");
    expect(page2?.turns.find((t) => t.uuid === "t1")?.messages.map((m) => m.uuid)).toEqual([
      "t1m1",
      "t1m2",
    ]);
    expect(page2?.hasMore).toBe(true);
    // Next cursor = oldest in page 2 = t1m1 at (1,1).
    expect(page2?.oldestTurnSeq).toBe(1);
    expect(page2?.oldestMsgSeq).toBe(1);

    // Page 3: the placeholder slot of t1 (1,0) is the only remaining entry → empty band,
    // hasMore false (conversation start).
    vi.clearAllMocks();
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ uuid: "t1", seq: 1 })]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "t1m1", turnUuid: "t1", seq: 1 }),
      transcriptMessageRow({ uuid: "t1m2", turnUuid: "t1", seq: 2 }),
    ]);
    const page3 = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 2, beforeTurnSeq: page2!.oldestTurnSeq!, beforeMsgSeq: page2!.oldestMsgSeq! },
    );
    // Only t1's (1,0) slot is strictly older than (1,1) → an empty band, start reached.
    expect(page3?.turns.map((t) => t.uuid)).toEqual(["t1"]);
    expect(page3?.turns[0].messages).toEqual([]);
    expect(page3?.hasMore).toBe(false);
    expect(page3?.oldestTurnSeq).toBe(1);
    expect(page3?.oldestMsgSeq).toBe(0);
  });

  it("SYNTHETIC PROMPT: a prompt-only human_instruction turn surfaces as a synthetic seq=0 user message", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // A human_instruction turn with promptText but NO stored transcript messages.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t1", seq: 1, trigger: "human_instruction", promptText: "please refactor X" }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    expect(result?.turns).toHaveLength(1);
    const band = result!.turns[0];
    // The band's ONLY message is the synthetic seq=0, role=user message carrying the prompt,
    // with the stable `synthetic:{turnUuid}` uuid and the turn's createdAt.
    expect(band.messages).toHaveLength(1);
    expect(band.messages[0]).toEqual({
      uuid: "synthetic:t1",
      turnUuid: "t1",
      role: "user",
      text: "please refactor X",
      seq: 0,
      createdAt: "2026-06-15T03:00:00.000Z",
    });
    // The synthetic slot is the page's oldest position (cursor read from the slot).
    expect(result?.oldestTurnSeq).toBe(1);
    expect(result?.oldestMsgSeq).toBe(0);
    expect(result?.hasMore).toBe(false);
  });

  it("SYNTHETIC ORDERING: the synthetic prompt sorts AHEAD of the turn's real (seq>=1) messages", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t1", seq: 1, trigger: "human_instruction", promptText: "do the thing" }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "m1", turnUuid: "t1", role: "assistant", text: "working", seq: 1 }),
      transcriptMessageRow({ uuid: "m2", turnUuid: "t1", role: "assistant", text: "done", seq: 2 }),
    ]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    // Synthetic prompt first, then the real messages ascending by seq.
    expect(result?.turns[0].messages.map((m) => m.uuid)).toEqual(["synthetic:t1", "m1", "m2"]);
    expect(result?.turns[0].messages[0].seq).toBe(0);
    expect(result?.turns[0].messages[0].role).toBe("user");
  });

  it("SYNTHETIC: NOT persisted — no create/update is ever issued for the synthetic slot (read/projection only)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t1", seq: 1, trigger: "human_instruction", promptText: "ephemeral" }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    await getSessionDetail({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);

    // The synthetic message exists only in the projection — never written to the DB.
    expect(mockPrisma.daemonTranscriptMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.create).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("EMPTY BAND: a prompt-less turn whose messages were all trimmed is STILL returned (empty band), occupying ONE cursor position", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // t2 is prompt-less (agent_wake) and its messages were ALL trimmed by the rolling
    // window; t1 still has a message. Both must appear; neither is dropped.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2, trigger: "task_assigned", promptText: null }),
      turnRow({ uuid: "t1", seq: 1, trigger: "task_assigned", promptText: null }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "m1", turnUuid: "t1", seq: 1 }),
    ]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    // Both turns present; t2 is an EMPTY band (its placeholder slot reserved the spot).
    expect(result?.turns.map((t) => t.uuid)).toEqual(["t1", "t2"]);
    expect(result?.turns.find((t) => t.uuid === "t2")?.messages).toEqual([]);
    expect(result?.turns.find((t) => t.uuid === "t1")?.messages.map((m) => m.uuid)).toEqual([
      "m1",
    ]);
    // The whole conversation is 3 stream entries (t2 slot, t1 m1, t1 slot) < page size.
    expect(result?.hasMore).toBe(false);
  });

  it("EMPTY BAND: paging does NOT stall on a message-less prompt-less turn — its slot consumes exactly one position", async () => {
    // Two prompt-less, message-less turns. With limit 1, page 1 is t2's slot only; the
    // load-earlier cursor (2,0) must advance PAST it to t1's slot, not re-yield t2.
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2, promptText: null }),
      turnRow({ uuid: "t1", seq: 1, promptText: null }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    const page1 = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 1 },
    );
    // Page 1 = t2's empty band; t1's slot is the +1 probe → hasMore true.
    expect(page1?.turns.map((t) => t.uuid)).toEqual(["t2"]);
    expect(page1?.turns[0].messages).toEqual([]);
    expect(page1?.hasMore).toBe(true);
    expect(page1?.oldestTurnSeq).toBe(2);
    expect(page1?.oldestMsgSeq).toBe(0);

    // Page 2 with the page-1 cursor: strictly older than (2,0) is only t1's slot (1,0).
    // Paging ADVANCED — it did not loop back on t2.
    vi.clearAllMocks();
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2, promptText: null }),
      turnRow({ uuid: "t1", seq: 1, promptText: null }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);
    const page2 = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 1, beforeTurnSeq: page1!.oldestTurnSeq!, beforeMsgSeq: page1!.oldestMsgSeq! },
    );
    expect(page2?.turns.map((t) => t.uuid)).toEqual(["t1"]);
    expect(page2?.turns[0].messages).toEqual([]);
    expect(page2?.hasMore).toBe(false); // conversation start reached
    expect(page2?.oldestTurnSeq).toBe(1);
    expect(page2?.oldestMsgSeq).toBe(0);
  });

  it("HAS-MORE false at conversation START: paged back to the oldest retained entry", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // The whole conversation: one prompt-less turn with 2 messages → 3 stream entries.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ uuid: "t1", seq: 1 })]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "m1", turnUuid: "t1", seq: 1 }),
      transcriptMessageRow({ uuid: "m2", turnUuid: "t1", seq: 2 }),
    ]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 50 },
    );
    expect(result?.hasMore).toBe(false);
    // Oldest position = the turn's placeholder slot (1, 0).
    expect(result?.oldestTurnSeq).toBe(1);
    expect(result?.oldestMsgSeq).toBe(0);
  });

  it("a visible session with ZERO turns returns empty turns, NO message query, null composite cursor", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    expect(result?.turns).toEqual([]);
    // No candidate turns → no turnUuids → the batched message query is skipped entirely.
    expect(mockPrisma.daemonTranscriptMessage.findMany).not.toHaveBeenCalled();
    expect(result?.hasMore).toBe(false);
    expect(result?.oldestTurnSeq).toBeNull();
    expect(result?.oldestMsgSeq).toBeNull();
  });

  it("AGENT-KEY caller: resolves the session under self-scope (agentUuid)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    await getSessionDetail({ type: "agent", companyUuid, actorUuid: agentUuid }, sessionUuid);
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where).toEqual({
      uuid: sessionUuid,
      companyUuid,
      agentUuid,
    });
  });

  it("NON-VISIBLE session (non-existent / cross-company / non-owned agent) returns null → 404", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );
    expect(result).toBeNull();
    // It must NOT then query turns/messages for a session the caller cannot see.
    expect(mockPrisma.daemonSessionTurn.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.daemonTranscriptMessage.findMany).not.toHaveBeenCalled();
  });

  it("PROPAGATES a query error (read, does NOT swallow to an empty transcript → 500)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      getSessionDetail({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid),
    ).rejects.toThrow("db down");
  });
});

// ===== assertContinuable (origin-connection pinning) =====
describe("assertContinuable", () => {
  it("returns the originConnectionUuid when the origin is effectively ONLINE", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ status: "online", lastSeenAt: new Date() });
    const origin = await assertContinuable(companyUuid, sessionUuid);
    expect(origin).toBe(connectionUuid);
    // It resolves the SESSION's origin connection — scoped by companyUuid.
    expect(mockPrisma.daemonSession.findFirst.mock.calls[0][0].where).toEqual({
      uuid: sessionUuid,
      companyUuid,
    });
    // And checks exactly that connection (the origin) — never any other.
    expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0].where).toEqual({
      uuid: connectionUuid,
      companyUuid,
    });
  });

  it("REFUSES (SessionReadOnlyError) when the origin connection is OFFLINE — never re-routes", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ status: "offline", lastSeenAt: new Date() });
    await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toBeInstanceOf(SessionReadOnlyError);
    // Only the origin connection was ever looked up — no fallback connection query.
    expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0].where.uuid).toBe(connectionUuid);
  });

  it("REFUSES when the origin's lastSeenAt is STALE (older than STALE_THRESHOLD_MS) even if status=online", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "online",
      lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 1_000)),
    });
    await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toBeInstanceOf(SessionReadOnlyError);
  });

  it("REFUSES when the origin connection no longer exists (deleted/foreign cannot be online)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toBeInstanceOf(SessionReadOnlyError);
  });

  it("the SessionReadOnlyError carries the offending originConnectionUuid + a stable code", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ status: "offline", lastSeenAt: new Date() });
    await assertContinuable(companyUuid, sessionUuid).catch((err) => {
      expect(err).toBeInstanceOf(SessionReadOnlyError);
      expect(err.code).toBe("session_read_only");
      expect(err.originConnectionUuid).toBe(connectionUuid);
    });
    expect.assertions(3);
  });

  it("throws a plain not-found error when the session does not resolve in-company", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toThrow(/not found/);
    // It must not even attempt to resolve a connection for a non-existent session.
    expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
  });

  it("treats lastSeenAt exactly at the threshold as still fresh → ONLINE (inclusive boundary)", async () => {
    // Freeze the clock so the elapsed is EXACTLY the threshold inside the service
    // (Date.now() at fixture-build and inside assertContinuable would otherwise drift
    // a few ms, tipping just past the boundary).
    const fixedNow = new Date("2026-06-15T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "online",
      lastSeenAt: new Date(fixedNow - STALE_THRESHOLD_MS),
    });
    await expect(assertContinuable(companyUuid, sessionUuid)).resolves.toBe(connectionUuid);
    vi.useRealTimers();
  });

  // ===== T3 — resume 按 (host+cwd) 路由 (AC#4 / FR-7 / Module Contract 4) =====
  // assertContinuable pins resume to the session's ORIGIN connection, which is uniquely
  // keyed by (agentUuid, clientType, host, cwd). Pinning to that exact uuid IS the
  // (host+cwd) consistency check — a different-cwd connection is a different row/uuid and
  // is NEVER considered. A cross-cwd route is therefore structurally impossible: there is
  // no fallback path. cwd⟂project — this is the session's bound cwd, not project-derived.
  describe("T3 cwd consistency (resume by host+cwd)", () => {
    it("resolves the origin connection's cwd (the binding is made explicit, not just uuid)", async () => {
      mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
      mockPrisma.daemonConnection.findFirst.mockResolvedValue({
        status: "online",
        lastSeenAt: new Date(),
        cwd: "/dev/repo-a",
      });
      await expect(assertContinuable(companyUuid, sessionUuid)).resolves.toBe(connectionUuid);
      // The connection lookup now also selects cwd — the (host+cwd) binding is explicit.
      expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0].select).toMatchObject({
        cwd: true,
      });
    });

    it("a cross-cwd route is impossible: ONLY the origin (host+cwd) connection is ever queried", async () => {
      // The session's origin lives on cwd repo-a. Even if the same agent has another
      // ONLINE connection on a DIFFERENT cwd (repo-b), assertContinuable never looks at
      // it — it queries the origin uuid alone. (We assert exactly one connection query,
      // pinned to the origin uuid — there is no second "any-other-cwd" query.)
      mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
      mockPrisma.daemonConnection.findFirst.mockResolvedValue({
        status: "online",
        lastSeenAt: new Date(),
        cwd: "/dev/repo-a",
      });
      await assertContinuable(companyUuid, sessionUuid);
      expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0].where.uuid).toBe(connectionUuid);
    });

    it("when the origin (host+cwd) connection is offline it REFUSES — never falls back to another cwd", async () => {
      // Origin on repo-a is offline. The refusal is a structured SessionReadOnlyError —
      // NOT a silent re-route to a repo-b connection (which would `claude --resume`
      // against the wrong cwd → "No conversation found").
      mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
      mockPrisma.daemonConnection.findFirst.mockResolvedValue({
        status: "offline",
        lastSeenAt: new Date(),
        cwd: "/dev/repo-a",
      });
      await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toBeInstanceOf(SessionReadOnlyError);
      // Exactly one connection query — the origin. No fallback query for another cwd.
      expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledTimes(1);
    });

    it("[HARD-1] an OLD-daemon origin (cwd = null) passes through when online — null never makes it read-only", async () => {
      // A session whose origin is an old daemon has cwd=null. The cwd is "unconstrained";
      // the only gate is online-ness. assertContinuable must NOT reject just because cwd
      // is null (Module Contract 2 — null pass-through).
      mockPrisma.daemonSession.findFirst.mockResolvedValue({ originConnectionUuid: connectionUuid });
      mockPrisma.daemonConnection.findFirst.mockResolvedValue({
        status: "online",
        lastSeenAt: new Date(),
        cwd: null,
      });
      await expect(assertContinuable(companyUuid, sessionUuid)).resolves.toBe(connectionUuid);
    });
  });
});

// ===== appendTranscriptMessages =====
describe("appendTranscriptMessages", () => {
  // Default happy path: the turnUuid resolves to an owned turn, no prior messages.
  function ownedTurn() {
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid, sessionUuid });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ uuid: sessionUuid, companyUuid });
  }

  it("resolves the turn under the OWNER scope (turn's session must match agent+company)", async () => {
    ownedTurn();
    await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [{ role: "user", text: "hi" }],
    });
    const where = mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0].where;
    expect(where.uuid).toBe(turnUuid);
    // Ownership is enforced through the session relation, not a separate query.
    expect(where.session).toEqual({ agentUuid, companyUuid });
  });

  it("returns not_found (404 non-disclosure) when the turn is not owned / does not exist", async () => {
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(null);
    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [{ role: "user", text: "hi" }],
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    // Negative path stores nothing and emits nothing.
    expect(mockPrisma.daemonTranscriptMessage.create).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("sessionId path resolves the agent's session then its RUNNING turn (not most-recent seq)", async () => {
    // The session is resolved by (agentUuid, companyUuid, sessionId), then the RUNNING
    // turn is targeted — so a running turn's output never mis-attaches to a newer
    // `pending` turn created mid-run (H1's transcript variant).
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid, sessionUuid });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ uuid: sessionUuid, companyUuid });

    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      sessionId,
      messages: [{ role: "assistant", text: "ok" }],
    });
    expect(result.ok).toBe(true);
    const sessionWhere = mockPrisma.daemonSession.findFirst.mock.calls[0][0].where;
    expect(sessionWhere).toEqual({ agentUuid, companyUuid, sessionId });
    // Running turn, oldest-first (status: running). NOT seq desc.
    const turnQuery = mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0];
    expect(turnQuery.where).toEqual({ sessionUuid, status: "running" });
    expect(turnQuery.orderBy).toEqual({ seq: "asc" });
  });

  it("sessionId path FALLS BACK to most-recent turn when none is running (late flush)", async () => {
    // No running turn (e.g. a trailing flush just after the turn ended) → fall back to
    // the highest-seq turn so trailing lines still land on the turn they belong to.
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    // First findFirst (status: running) → null; second (fallback, seq desc) → the turn.
    mockPrisma.daemonSessionTurn.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ uuid: turnUuid, sessionUuid });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue(turnRow({ status: "ended" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ uuid: sessionUuid, companyUuid });

    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      sessionId,
      messages: [{ role: "assistant", text: "trailing" }],
    });
    expect(result.ok).toBe(true);
    const runningQuery = mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0];
    expect(runningQuery.where).toEqual({ sessionUuid, status: "running" });
    const fallbackQuery = mockPrisma.daemonSessionTurn.findFirst.mock.calls[1][0];
    expect(fallbackQuery.where).toEqual({ sessionUuid });
    expect(fallbackQuery.orderBy).toEqual({ seq: "desc" });
  });

  it("sessionId path → not_found when the session has no turn yet", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(null);
    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      sessionId,
      messages: [{ role: "user", text: "hi" }],
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("sessionId path → not_found when the session is not owned / does not exist", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      sessionId,
      messages: [{ role: "user", text: "hi" }],
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    // Must NOT try to resolve a turn for a non-resolving session.
    expect(mockPrisma.daemonSessionTurn.findFirst).not.toHaveBeenCalled();
  });

  it("appends ONLY user/assistant text — drops tool-call/tool-result/thinking and blanks", async () => {
    ownedTurn();
    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [
        { role: "user", text: "real user text" },
        // The following are NOT user/assistant text — must be filtered out:
        { role: "tool_use", text: "rm -rf" } as unknown as { role: "user"; text: string },
        { role: "tool_result", text: "exit 0" } as unknown as { role: "assistant"; text: string },
        { role: "thinking", text: "hmm" } as unknown as { role: "assistant"; text: string },
        { role: "assistant", text: "real assistant text" },
        { role: "user", text: "   " }, // blank text → dropped
      ],
    });
    expect(result.ok && result.appended).toBe(2);
    // Exactly two creates — the two text messages.
    expect(mockPrisma.daemonTranscriptMessage.create).toHaveBeenCalledTimes(2);
    const texts = mockPrisma.daemonTranscriptMessage.create.mock.calls.map((c) => c[0].data.text);
    expect(texts).toEqual(["real user text", "real assistant text"]);
    const roles = mockPrisma.daemonTranscriptMessage.create.mock.calls.map((c) => c[0].data.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("assigns a monotonic per-turn seq continuing from the existing max", async () => {
    ownedTurn();
    // The turn already has messages up to seq 7.
    mockPrisma.daemonTranscriptMessage.findFirst.mockResolvedValue({ seq: 7 });
    await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
      ],
    });
    const seqs = mockPrisma.daemonTranscriptMessage.create.mock.calls.map((c) => c[0].data.seq);
    expect(seqs).toEqual([8, 9]);
    // seq lookup ordered seq desc to read the current max off the index.
    expect(mockPrisma.daemonTranscriptMessage.findFirst.mock.calls[0][0].orderBy).toEqual({
      seq: "desc",
    });
  });

  it("an all-filtered upload is a no-op success: appends 0, no create, no emit", async () => {
    ownedTurn();
    mockPrisma.daemonTranscriptMessage.count.mockResolvedValue(3);
    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [{ role: "tool_use", text: "x" } as unknown as { role: "user"; text: string }],
    });
    expect(result).toEqual({ ok: true, appended: 0, stored: 3, messages: [] });
    expect(mockPrisma.daemonTranscriptMessage.create).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("ROLLING WINDOW: trims oldest overflow back to the cap, in application code", async () => {
    ownedTurn();
    // After inserting, the session count exceeds the cap by 3.
    const over = MAX_TRANSCRIPT_MESSAGES_PER_SESSION + 3;
    // count() is called inside trim (first) and again for the returned `stored`.
    mockPrisma.daemonTranscriptMessage.count
      .mockResolvedValueOnce(over) // inside trimSessionTranscript
      .mockResolvedValueOnce(MAX_TRANSCRIPT_MESSAGES_PER_SESSION); // final stored count
    // The 3 oldest messages the trim deletes.
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      { uuid: "old-1" },
      { uuid: "old-2" },
      { uuid: "old-3" },
    ]);

    const result = await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [{ role: "user", text: "newest" }],
    });

    expect(result.ok).toBe(true);
    // Oldest-first selection, limited to the overflow count, across the session's turns.
    const findManyArg = mockPrisma.daemonTranscriptMessage.findMany.mock.calls[0][0];
    expect(findManyArg.where).toEqual({ turn: { sessionUuid } });
    // Tiebreak on the globally-monotonic `id`, not per-turn `seq` (deterministic
    // oldest-first across turns that share a createdAt millisecond).
    expect(findManyArg.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(findManyArg.take).toBe(3);
    // Deletes exactly the overflow uuids — no migration, plain deleteMany.
    expect(mockPrisma.daemonTranscriptMessage.deleteMany).toHaveBeenCalledWith({
      where: { uuid: { in: ["old-1", "old-2", "old-3"] } },
    });
  });

  it("ROLLING WINDOW: no trim when the session is within the cap", async () => {
    ownedTurn();
    mockPrisma.daemonTranscriptMessage.count.mockResolvedValue(
      MAX_TRANSCRIPT_MESSAGES_PER_SESSION - 1,
    );
    await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [{ role: "user", text: "still under" }],
    });
    expect(mockPrisma.daemonTranscriptMessage.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.daemonTranscriptMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("SSE: publishes the transcript_appended trigger on the shared transcript:{sessionUuid} channel", async () => {
    ownedTurn();
    mockPrisma.daemonTranscriptMessage.count.mockResolvedValue(1);
    await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [{ role: "assistant", text: "live update" }],
    });
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [channel, event] = mockEventBus.emit.mock.calls[0];
    // SAME channel helper the turn-create/turn-status triggers use — one channel per
    // conversation, additive to the existing event types.
    expect(channel).toBe(transcriptEventName(sessionUuid));
    expect(event.trigger).toBe("transcript_appended");
    expect(event.sessionUuid).toBe(sessionUuid);
    expect(event.companyUuid).toBe(companyUuid);
    expect(event.turn.uuid).toBe(turnUuid);
  });

  it("SSE: transcript_appended carries the appended message TAIL (TranscriptMessageView shape) plus the turn", async () => {
    ownedTurn();
    mockPrisma.daemonTranscriptMessage.count.mockResolvedValue(2);
    await appendTranscriptMessages({
      companyUuid,
      agentUuid,
      turnUuid,
      messages: [
        { role: "user", text: "what is the status?" },
        { role: "assistant", text: "running now" },
      ],
    });
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const event = mockEventBus.emit.mock.calls[0][1];
    // The appended tail rides on the event so a viewer patches the turn live without a
    // follow-up read — reusing the existing TranscriptMessageView shape, no new type.
    expect(Array.isArray(event.messages)).toBe(true);
    expect(event.messages).toHaveLength(2);
    expect(event.messages[0]).toMatchObject({
      turnUuid,
      role: "user",
      text: "what is the status?",
    });
    expect(event.messages[1]).toMatchObject({
      turnUuid,
      role: "assistant",
      text: "running now",
    });
    // TranscriptMessageView shape: ISO-8601 createdAt + a numeric per-turn seq.
    expect(typeof event.messages[0].createdAt).toBe("string");
    expect(typeof event.messages[0].seq).toBe("number");
    // The existing `turn` field is preserved alongside the new `messages` tail.
    expect(event.turn.uuid).toBe(turnUuid);
  });

  it("does NOT swallow a write failure (a lost transcript append loses history)", async () => {
    ownedTurn();
    mockPrisma.daemonTranscriptMessage.create.mockRejectedValue(new Error("db down"));
    await expect(
      appendTranscriptMessages({
        companyUuid,
        agentUuid,
        turnUuid,
        messages: [{ role: "user", text: "hi" }],
      }),
    ).rejects.toThrow(/db down/);
  });
});

// ===== advanceTurnForWake (daemon → server, by session business key) =====
describe("advanceTurnForWake", () => {
  // Resolve the agent's own session, then the turn matching the FROM-status (pending for
  // →running, running for →ended), so advanceTurn (which findUnique's the turn) succeeds.
  function ownedSessionWithLatestTurn(turnStatus = "pending") {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    // findFirst resolves the turn by status (oldest-first) — return the matching turn.
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid });
    // advanceTurn's own lookups:
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: turnStatus,
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      seq: 3,
      trigger: "human_instruction",
      promptText: "do X",
      status: turnStatus === "pending" ? "running" : "ended",
      executionUuid: "exec-1",
      startedAt: new Date("2026-06-19T06:00:00.000Z"),
      endedAt: null,
      createdAt: new Date("2026-06-19T05:59:00.000Z"),
    });
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });
  }

  it("resolves the agent's own session + latest turn and advances pending→running, stamping executionUuid from the (connection,entity) execution row", async () => {
    ownedSessionWithLatestTurn("pending");
    mockPrisma.daemonExecution.findFirst.mockResolvedValue({ uuid: "exec-1" });

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
      entityType: "task",
      entityUuid: "task-9",
    });

    expect(res).toMatchObject({ ok: true });
    // Session resolved under the agent + company + business-key fence.
    expect(mockPrisma.daemonSession.findFirst).toHaveBeenCalledWith({
      where: { agentUuid, companyUuid, sessionId },
      select: { uuid: true },
    });
    // Execution row resolved for the weak link.
    expect(mockPrisma.daemonExecution.findFirst).toHaveBeenCalledWith({
      where: { companyUuid, connectionUuid, entityType: "task", entityUuid: "task-9" },
      select: { uuid: true },
    });
    // advanceTurn wrote running + a startedAt + the resolved executionUuid.
    const updateArg = mockPrisma.daemonSessionTurn.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe("running");
    expect(updateArg.data.executionUuid).toBe("exec-1");
    expect(updateArg.data.startedAt).toBeInstanceOf(Date);
  });

  it("H1 REGRESSION: resolves the turn by STATUS (→running picks oldest pending; →ended picks running), not by most-recent seq", async () => {
    // → running must target the OLDEST still-pending turn (FIFO), not the highest seq —
    // otherwise a newer pending turn created mid-run would be mis-targeted and the real
    // running turn would never reach `ended` (stuck-running bug).
    ownedSessionWithLatestTurn("pending");
    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "running" });
    const runningResolve = mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0];
    expect(runningResolve.where).toEqual({ sessionUuid, status: "pending" });
    expect(runningResolve.orderBy).toEqual({ seq: "asc" });

    vi.clearAllMocks();

    // → ended must target the RUNNING turn (the one whose subprocess just exited).
    ownedSessionWithLatestTurn("running");
    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "ended" });
    const endedResolve = mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0];
    expect(endedResolve.where).toEqual({ sessionUuid, status: "running" });
    expect(endedResolve.orderBy).toEqual({ seq: "asc" });
  });

  it("running→ended defaults endedAt and does NOT resolve an execution row when no entity is given", async () => {
    ownedSessionWithLatestTurn("running");

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "ended",
      // no entityType/entityUuid
    });

    expect(res).toMatchObject({ ok: true });
    expect(mockPrisma.daemonExecution.findFirst).not.toHaveBeenCalled();
    const updateArg = mockPrisma.daemonSessionTurn.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe("ended");
    expect(updateArg.data.endedAt).toBeInstanceOf(Date);
    // executionUuid is left untouched (undefined) when no entity is supplied.
    expect(updateArg.data).not.toHaveProperty("executionUuid");
  });

  it("atomically persists a backend session ID under the authenticated agent session fence", async () => {
    ownedSessionWithLatestTurn("running");
    mockPrisma.daemonSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      backendSessionId: "thread-1",
      status: "ended",
    });

    expect(res).toMatchObject({ ok: true });
    expect(mockPrisma.daemonSession.findFirst).toHaveBeenCalledWith({
      where: { agentUuid, companyUuid, sessionId },
      select: { uuid: true },
    });
    expect(mockPrisma.daemonSession.updateMany).toHaveBeenCalledWith({
      where: {
        uuid: sessionUuid,
        OR: [{ backendSessionId: null }, { backendSessionId: "thread-1" }],
      },
      data: { backendSessionId: "thread-1" },
    });
  });

  it("accepts an idempotent backend ID report through the same atomic guard", async () => {
    ownedSessionWithLatestTurn("running");
    mockPrisma.daemonSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      backendSessionId: "thread-1",
      status: "ended",
    });

    expect(res).toMatchObject({ ok: true });
  });

  it("rejects a conflicting backend ID without advancing the turn or overwriting it", async () => {
    ownedSessionWithLatestTurn("running");
    mockPrisma.daemonSession.updateMany.mockResolvedValue({ count: 0 });

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      backendSessionId: "thread-2",
      status: "ended",
    });

    expect(res).toEqual({ ok: false, reason: "backend_session_conflict" });
    expect(mockPrisma.daemonSessionTurn.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("running→interrupted resolves the RUNNING turn, defaults endedAt, and persists the reason", async () => {
    ownedSessionWithLatestTurn("running");

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "interrupted",
      interruptedReason: "shutdown",
    });

    expect(res).toMatchObject({ ok: true });
    // → interrupted leaves from the same state as → ended: the running turn.
    const resolve = mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0];
    expect(resolve.where).toEqual({ sessionUuid, status: "running" });
    const updateArg = mockPrisma.daemonSessionTurn.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe("interrupted");
    expect(updateArg.data.interruptedReason).toBe("shutdown");
    expect(updateArg.data.endedAt).toBeInstanceOf(Date);
  });

  it("forwards relayError onto the terminal turn-advance (fix #444 follow-up)", async () => {
    ownedSessionWithLatestTurn("running");

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "ended",
      relayError: "transcript upload returned 502",
    });

    expect(res).toMatchObject({ ok: true });
    const updateArg = mockPrisma.daemonSessionTurn.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe("ended");
    expect(updateArg.data.relayError).toBe("transcript upload returned 502");
  });

  it("returns not_found when the agent has no such session (non-disclosure)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("returns not_found when the session has no turn yet", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(null);
    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("surfaces an illegal transition from advanceTurn as invalid_transition (does not silently succeed)", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid });
    // Turn is already ended → pending→ended skip / re-apply is rejected by advanceTurn.
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "ended",
    });
    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_transition", from: "ended", to: "running" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });
});

// ===== advanceTurnForWake — coalesced-away pending-turn settlement (daemon-wake-coalescing) =====
describe("advanceTurnForWake — coalescedCount settlement of superseded pending turns", () => {
  // Set up a legal pending→running advance where the OLDEST pending turn resolves at `seq`
  // (the settlement filter needs the running turn's seq).
  function runningTransition(runningSeq = 10) {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    // findFirst resolves the oldest pending turn by status — now carrying its seq.
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid, seq: runningSeq });
    // advanceTurn chokepoint lookups for a legal pending→running write.
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({ uuid: turnUuid, sessionUuid, status: "pending" });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "running", seq: runningSeq }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });
  }

  it("resolves the running turn's seq (findFirst select includes seq) so the settlement can filter seq > X", async () => {
    runningTransition(10);
    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "running", coalescedCount: 2 });
    // The FROM-status resolve must select seq (the settlement's seq>X anchor).
    expect(mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0].select).toEqual({ uuid: true, seq: true });
  });

  it("on →running with coalescedCount=N, settles the next N-1 pending turns of the SAME session (by ascending seq, seq > X) to 'merged'", async () => {
    runningTransition(10);
    // Full rows (not just uuid) so the live-convergence emit can project each via toTurnView.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "turn-2", seq: 11, status: "pending" }),
      turnRow({ uuid: "turn-3", seq: 12, status: "pending" }),
    ]);

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
      coalescedCount: 3,
    });
    expect(res).toMatchObject({ ok: true });

    // The N-1 coalesced-away turns are the next PENDING ones by ascending seq, seq > X(=10), capped at N-1(=2).
    const findArg = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({ sessionUuid, status: "pending", seq: { gt: 10 } });
    expect(findArg.orderBy).toEqual({ seq: "asc" });
    expect(findArg.take).toBe(2);

    // They are settled to the terminal 'merged' status by uuid — nothing else touched.
    expect(mockPrisma.daemonSessionTurn.updateMany).toHaveBeenCalledWith({
      where: { uuid: { in: ["turn-2", "turn-3"] } },
      data: { status: MERGED_TURN_STATUS },
    });
    expect(MERGED_TURN_STATUS).toBe("merged");

    // Live convergence: exactly N-1 turn_status_changed events carry the settled turns as
    // `merged`, so a live viewer converges without a refetch. (The running-transition emit
    // is separate and carries status "running", not "merged".)
    const mergedEmits = mockEventBus.emit.mock.calls.filter(
      ([, payload]) => payload?.trigger === "turn_status_changed" && payload?.turn?.status === MERGED_TURN_STATUS,
    );
    expect(mergedEmits).toHaveLength(2);
    expect(mergedEmits.map(([, p]) => p.turn.uuid).sort()).toEqual(["turn-2", "turn-3"]);
    // Emitted on the per-session transcript channel with an empty message tail.
    for (const [channel, payload] of mergedEmits) {
      expect(channel).toBe(`transcript:${sessionUuid}`);
      expect(payload.messages).toEqual([]);
      expect(payload.companyUuid).toBe(companyUuid);
    }
  });

  it("caps the settlement at N-1: a pending turn beyond the first N (arrived after the drain) is NOT selected and survives as pending", async () => {
    runningTransition(10);
    // coalescedCount=2 → only the single (N-1) oldest pending tail turn is the coalesced batch;
    // the `take: 1` cap guarantees any later-arriving higher-seq turn is never selected.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ uuid: "turn-2", seq: 11, status: "pending" })]);

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
      coalescedCount: 2,
    });
    expect(res).toMatchObject({ ok: true });

    const findArg = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0];
    expect(findArg.take).toBe(1);
    expect(findArg.where.seq).toEqual({ gt: 10 });
    expect(mockPrisma.daemonSessionTurn.updateMany).toHaveBeenCalledWith({
      where: { uuid: { in: ["turn-2"] } },
      data: { status: MERGED_TURN_STATUS },
    });
  });

  it("coalescedCount=1 (default, omitted) settles NOTHING — no settlement query, no updateMany, other pending turns untouched", async () => {
    runningTransition(10);
    const res = await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "running" });
    expect(res).toMatchObject({ ok: true });
    // Only the running-transition ran; no coalesced-settlement read or write.
    expect(mockPrisma.daemonSessionTurn.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });

  it("explicit coalescedCount=1 also settles nothing (byte-identical to the pre-coalescing single-wake path)", async () => {
    runningTransition(10);
    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "running", coalescedCount: 1 });
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });

  it("coalescedCount=1 publishes ZERO merged-settlement events (only the running-transition emit fires)", async () => {
    runningTransition(10);
    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "running", coalescedCount: 1 });
    // No turn_status_changed event carries a `merged` turn on the single-wake path.
    const mergedEmits = mockEventBus.emit.mock.calls.filter(
      ([, payload]) => payload?.turn?.status === MERGED_TURN_STATUS,
    );
    expect(mergedEmits).toHaveLength(0);
    // The running-transition itself still emits exactly once (its turn is "running").
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emit.mock.calls[0][1].turn.status).toBe("running");
  });

  it("settlement is bound to the RUNNING transition — a terminal edge (→ended) with coalescedCount>1 settles nothing", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid, seq: 10 });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({ uuid: turnUuid, sessionUuid, status: "running" });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(turnRow({ status: "ended" }));
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "ended", coalescedCount: 3 });
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });

  it("does NOT settle when the running-transition itself fails (invalid_transition) — no half-applied merge", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: turnUuid, seq: 10 });
    // The resolved turn is already `running`, so advanceTurn rejects pending→running.
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({ uuid: turnUuid, sessionUuid, status: "running" });

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "running",
      coalescedCount: 3,
    });
    expect(res.ok).toBe(false);
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });

  it("skips the updateMany when there are no coalesced-away pending turns to settle (settlement query returns empty)", async () => {
    runningTransition(10);
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);

    await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId, status: "running", coalescedCount: 3 });
    // The settlement read still ran once, but with nothing to settle no write is issued.
    expect(mockPrisma.daemonSessionTurn.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });
});

// ===== reconcileOrphanTurns (server-side escape hatch for a daemon dead mid-turn) =====
describe("reconcileOrphanTurns", () => {
  const STALE = STALE_THRESHOLD_MS; // 90_000 (mocked to the real literal above)

  // A running turn owned (via its session's originConnectionUuid) by the connection,
  // plus the advanceTurn-chokepoint mocks for a successful → interrupted write.
  function runningTurnOnConnection() {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([{ uuid: turnUuid }]);
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "interrupted", interruptedReason: "offline" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });
  }

  it("finalizes a stale connection's running turns as interrupted(offline) via the chokepoint (SSE emitted)", async () => {
    runningTurnOnConnection();
    // lastSeenAt aged past the threshold → orphan-eligible.
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      lastSeenAt: new Date(Date.now() - STALE - 1_000),
    });

    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);

    expect(count).toBe(1);
    // The candidate query is fenced to running turns of THIS connection's sessions.
    const findArg = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({
      status: "running",
      session: { companyUuid, originConnectionUuid: connectionUuid },
    });
    // Written through advanceTurn: status + reason + endedAt.
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.status).toBe("interrupted");
    expect(data.interruptedReason).toBe("offline");
    expect(data.endedAt).toBeInstanceOf(Date);
    // SSE published by the chokepoint (not reimplemented here).
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emit.mock.calls[0][1].trigger).toBe("turn_status_changed");
  });

  it("AGE-ONLY rule: a fresh lastSeenAt is NOT eligible even when status is 'offline' (abort→reconnect gap)", async () => {
    // The connection row just aborted (status flipped offline) but its lastSeenAt is
    // fresh — the daemon may be reconnecting. The reconcile must write NOTHING; the
    // stored status is deliberately not consulted (blocker-1 regression guard).
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([{ uuid: turnUuid }]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "offline",
      lastSeenAt: new Date(Date.now() - 5_000), // 5s ago — well within 90s
    });

    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);

    expect(count).toBe(0);
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
    // Eligibility read selects only lastSeenAt — status cannot influence the verdict.
    expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0].select).toEqual({
      lastSeenAt: true,
    });
  });

  it("a stale lastSeenAt IS eligible even while status still reads 'online' (kill -9, no abort)", async () => {
    runningTurnOnConnection();
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "online", // never marked offline — the daemon died without an abort
      lastSeenAt: new Date(Date.now() - STALE - 60_000),
    });
    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);
    expect(count).toBe(1);
  });

  it("a deleted connection row is eligible (a gone connection cannot report)", async () => {
    runningTurnOnConnection();
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);
    expect(count).toBe(1);
  });

  it("no running turns → no eligibility read, no writes (cheap no-op)", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);
    expect(count).toBe(0);
    expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("PENDING turns are untouched — the candidate query filters status=running only", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    await reconcileOrphanTurns(companyUuid, connectionUuid);
    expect(mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0].where.status).toBe("running");
  });

  it("RACE: a turn the daemon terminally reported meanwhile loses as a LOGGED invalid_transition (no crash)", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([{ uuid: turnUuid }]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      lastSeenAt: new Date(Date.now() - STALE - 1_000),
    });
    // By the time advanceTurn re-reads the turn, the daemon's own running→ended landed.
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "ended",
    });

    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);

    expect(count).toBe(0);
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ turnUuid, from: "ended", to: "interrupted" }),
      expect.stringMatching(/lost the race/),
    );
  });

  it("SWALLOWS + LOGS its own errors (fire-and-forget-safe, returns 0)", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockRejectedValue(new Error("db down"));
    const count = await reconcileOrphanTurns(companyUuid, connectionUuid);
    expect(count).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ companyUuid, connectionUuid }),
      expect.stringMatching(/orphaned running turns/),
    );
  });

  it("FORCE mode (new-generation registration) bypasses the age guard entirely", async () => {
    // The restart-window seam: the restarted process's heartbeat keeps lastSeenAt
    // fresh, so the age-only rule would no-op forever. force:true skips the
    // eligibility read — the generation change is the caller's evidence.
    runningTurnOnConnection();
    const count = await reconcileOrphanTurns(companyUuid, connectionUuid, { force: true });
    expect(count).toBe(1);
    // The eligibility read is skipped entirely on the force path.
    expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.status).toBe("interrupted");
    expect(data.interruptedReason).toBe("offline");
  });

  it("FORCE mode with no running turns is still a cheap no-op", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    const count = await reconcileOrphanTurns(companyUuid, connectionUuid, { force: true });
    expect(count).toBe(0);
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
  });

  it("RESTART-WINDOW REGRESSION: force-reconciling the orphan BEFORE the new wake keeps FIFO →ended on the correct turn", async () => {
    // The seam this fix closes: an orphaned running turn (seq 1, from the dead
    // generation) + a fresh wake creating turn seq 2. Without the generation
    // reconcile, →ended's oldest-running FIFO resolution would target the ORPHAN,
    // marking it cleanly ended and stranding the genuinely-finished seq-2 turn.
    const orphanUuid = "turn-orphan-0000-0000-000000000001";
    const newTurnUuid = "turn-new-0000-0000-0000-000000000002";

    // Step 1 — new-generation registration fires the FORCE reconcile: only the
    // orphan is `running` at this point (the new wake hasn't started).
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([{ uuid: orphanUuid }]);
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: orphanUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ uuid: orphanUuid, status: "interrupted", interruptedReason: "offline" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });
    const reconciled = await reconcileOrphanTurns(companyUuid, connectionUuid, { force: true });
    expect(reconciled).toBe(1);
    expect(mockPrisma.daemonSessionTurn.update.mock.calls[0][0].where).toEqual({
      uuid: orphanUuid,
    });

    vi.clearAllMocks();

    // Step 2 — the new wake's turn (seq 2) runs and exits: →ended resolves by
    // status=running, and with the orphan already interrupted the ONLY running
    // turn is the new one — the report lands on it, never on the orphan.
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: sessionUuid });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue({ uuid: newTurnUuid });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: newTurnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ uuid: newTurnUuid, seq: 2, status: "ended" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const res = await advanceTurnForWake({
      companyUuid,
      agentUuid,
      connectionUuid,
      sessionId,
      status: "ended",
    });
    expect(res).toMatchObject({ ok: true });
    // Resolution still queries status=running (FIFO oldest) — and the write hits
    // the NEW turn, proving the orphan can no longer be mis-targeted.
    expect(mockPrisma.daemonSessionTurn.findFirst.mock.calls[0][0].where).toEqual({
      sessionUuid,
      status: "running",
    });
    expect(mockPrisma.daemonSessionTurn.update.mock.calls[0][0].where).toEqual({
      uuid: newTurnUuid,
    });
  });
});

// ===== Read-time orphan fallback on the session read paths =====
describe("read-time orphan-turn fallback", () => {
  const staleDate = new Date(Date.now() - STALE_THRESHOLD_MS - 10_000);

  it("getVisibleSessions converges a stale connection's running turn before returning", async () => {
    const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
    mockPrisma.daemonSession.findMany.mockResolvedValue([sessionRow()]);
    // Probe: this session has a running turn; reconcile re-reads candidates the same way.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      { uuid: turnUuid, sessionUuid },
    ]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ lastSeenAt: staleDate });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "interrupted", interruptedReason: "offline" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const sessions = await getVisibleSessions(userAuth);

    expect(sessions).toHaveLength(1);
    // The orphaned turn was written through (interrupted persisted in the DB).
    const data = mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data;
    expect(data.status).toBe("interrupted");
    expect(data.interruptedReason).toBe("offline");
  });

  it("getVisibleSessions read SURVIVES a fallback failure (best-effort, logged, never breaks the read)", async () => {
    const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
    mockPrisma.daemonSession.findMany.mockResolvedValue([sessionRow()]);
    // The probe itself explodes — the read must still return its sessions, with the
    // failure logged (no-silent-errors) rather than propagated.
    mockPrisma.daemonSessionTurn.findMany.mockRejectedValue(new Error("probe down"));

    const sessions = await getVisibleSessions(userAuth);

    expect(sessions).toHaveLength(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ companyUuid }),
      expect.stringMatching(/fallback failed/),
    );
  });

  it("getSessionDetail converges the open session's orphaned running turn on read", async () => {
    const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // First findMany = probe (running turn present); later calls = candidate window.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ status: "running" }),
    ]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ lastSeenAt: staleDate });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue({
      uuid: turnUuid,
      sessionUuid,
      status: "running",
    });
    mockPrisma.daemonSessionTurn.update.mockResolvedValue(
      turnRow({ status: "interrupted", interruptedReason: "offline" }),
    );
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ companyUuid });

    const detail = await getSessionDetail(userAuth, sessionUuid);

    expect(detail).not.toBeNull();
    // Write-through happened before the view was built.
    expect(mockPrisma.daemonSessionTurn.update.mock.calls[0][0].data.status).toBe(
      "interrupted",
    );
  });

  it("getSessionDetail during the abort→reconnect gap does NOT interrupt the live turn", async () => {
    const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ status: "running" }),
    ]);
    // status=offline (stream just aborted) but lastSeenAt fresh → NOT eligible.
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "offline",
      lastSeenAt: new Date(Date.now() - 3_000),
    });

    const detail = await getSessionDetail(userAuth, sessionUuid);

    expect(detail).not.toBeNull();
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    // The running band renders as-is — still the daemon's live turn.
    expect(detail!.turns.some((t) => t.status === "running")).toBe(true);
  });
});

// ===== getPendingTurnsForConnection (backfill read of unstarted turns) =====
describe("getPendingTurnsForConnection", () => {
  it("lists pending turns of the connection's origin-pinned, agent-owned sessions, mapped to the backfill view", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      {
        uuid: "t1",
        sessionUuid: "s1",
        seq: 4,
        trigger: "human_instruction",
        promptText: "do X",
        session: { sessionId: "idea-1", directIdeaUuid: "idea-1" },
      },
      {
        uuid: "t2",
        sessionUuid: "s2",
        seq: 1,
        trigger: "human_instruction",
        promptText: "do Y",
        session: { sessionId: "adhoc-2", directIdeaUuid: null },
      },
    ]);

    const turns = await getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid });

    // The query fences status=pending AND session owner-scope AND origin pinning.
    const whereArg = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0].where;
    expect(whereArg.status).toBe("pending");
    expect(whereArg.session).toEqual({
      companyUuid,
      agentUuid,
      originConnectionUuid: connectionUuid,
    });

    expect(turns).toEqual([
      { turnUuid: "t1", sessionUuid: "s1", sessionId: "idea-1", directIdeaUuid: "idea-1", seq: 4, trigger: "human_instruction", promptText: "do X" },
      { turnUuid: "t2", sessionUuid: "s2", sessionId: "adhoc-2", directIdeaUuid: null, seq: 1, trigger: "human_instruction", promptText: "do Y" },
    ]);
  });

  it("returns an empty list (not an error) when there are no pending turns", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    const turns = await getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid });
    expect(turns).toEqual([]);
  });

  it("does NOT swallow a query failure (a missed pending turn loses an instruction)", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid }),
    ).rejects.toThrow(/db down/);
  });
});
