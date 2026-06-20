import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonSession: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  daemonSessionTurn: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
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
  SESSION_STATUSES,
  TRANSCRIPT_ROLES,
  MAX_TRANSCRIPT_MESSAGES_PER_SESSION,
  DEFAULT_TRANSCRIPT_TURN_PAGE,
  STALE_THRESHOLD_MS,
  resolveOrCreateSession,
  resolveDirectIdeaUuid,
  createPendingTurn,
  advanceTurn,
  getVisibleSessions,
  getSessionTurns,
  getSessionDetail,
  isSessionVisibleToCaller,
  assertContinuable,
  appendTranscriptMessages,
  advanceTurnForWake,
  getPendingTurnsForConnection,
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
    directIdeaUuid: sessionId,
    originConnectionUuid: connectionUuid,
    status: "active",
    title: null,
    lastTurnAt: new Date("2026-06-15T03:00:00.000Z"),
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
  it("TURN_TRIGGERS covers the six wake kinds (incl. the distinct elaboration_verified)", () => {
    expect([...TURN_TRIGGERS].sort()).toEqual(
      [
        "elaboration",
        "elaboration_verified",
        "human_instruction",
        "mentioned",
        "resume",
        "task_assigned",
      ].sort(),
    );
  });

  it("TURN_TRIGGERS includes elaboration_verified as a member distinct from elaboration", () => {
    expect(TURN_TRIGGERS).toContain("elaboration_verified");
    expect(TURN_TRIGGERS).toContain("elaboration");
  });

  it("TURN_STATUSES are the strict forward lifecycle pending/running/ended", () => {
    expect([...TURN_STATUSES]).toEqual(["pending", "running", "ended"]);
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

// ===== advanceTurn (strict pending → running → ended) =====
describe("advanceTurn", () => {
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

// ===== getSessionDetail (turns WITH messages, batched fold, 404 non-disclosure) =====
describe("getSessionDetail", () => {
  it("VISIBLE session: returns { session, turns } with each turn's messages folded by seq", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // The page query orders seq DESC + takes a window; the service reverses it to
    // ascending. The mock returns DESC (newest-first) as the real DB would, so the
    // result is ascending [t1, t2].
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    // The ONE batched message query returns messages for BOTH turns, ordered by
    // (turnUuid, seq); the fold buckets each into its own turn in seq order.
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
    // Returned ascending for top-to-bottom rendering, regardless of the DESC fetch.
    expect(result?.turns.map((t) => t.uuid)).toEqual(["t1", "t2"]);
    // Pagination metadata: a single page that fit (no extra row) → no earlier page.
    expect(result?.hasMore).toBe(false);
    expect(result?.oldestSeq).toBe(1);
    // Messages folded into the right turn, in seq order, using the existing
    // TranscriptMessageView shape (uuid/turnUuid/role/text/seq/createdAt).
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

  it("loads ALL of the PAGE's messages in ONE batched query (no N+1): where turnUuid in [...] over the page turns", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // DESC fetch (newest-first); reversed to ascending t1,t2,t3 for the message query.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t3", seq: 3 }),
      turnRow({ uuid: "t2", seq: 2 }),
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    await getSessionDetail({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid);

    // Exactly ONE message query regardless of turn count, keyed on the page's turn
    // uuids (ascending), ordered by (turnUuid, seq).
    expect(mockPrisma.daemonTranscriptMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.daemonTranscriptMessage.findMany.mock.calls[0][0]).toEqual({
      where: { turnUuid: { in: ["t1", "t2", "t3"] } },
      orderBy: [{ turnUuid: "asc" }, { seq: "asc" }],
    });
    // The turn page query is seq DESC + windowed (take = limit + 1 to probe hasMore).
    const turnArgs = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0];
    expect(turnArgs.orderBy).toEqual({ seq: "desc" });
    expect(turnArgs.take).toBe(DEFAULT_TRANSCRIPT_TURN_PAGE + 1);
    expect(turnArgs.where).toEqual({ sessionUuid });
  });

  it("a turn whose messages were all trimmed still appears WITH an empty messages array", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // DESC fetch; reversed to ascending [t1, t2].
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t2", seq: 2 }), // its messages were trimmed by the rolling window
      turnRow({ uuid: "t1", seq: 1 }),
    ]);
    // Only t1 has retained messages; t2's are gone.
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([
      transcriptMessageRow({ uuid: "m1", turnUuid: "t1", seq: 1 }),
    ]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    expect(result?.turns).toHaveLength(2);
    expect(result?.turns[0].messages.map((m) => m.uuid)).toEqual(["m1"]);
    expect(result?.turns[1].messages).toEqual([]); // still a turn, just no transcript
  });

  it("a visible session with ZERO turns returns empty turns AND issues NO message query", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
    );

    expect(result?.turns).toEqual([]);
    // No turns → no turnUuids → the batched message query is skipped entirely.
    expect(mockPrisma.daemonTranscriptMessage.findMany).not.toHaveBeenCalled();
    expect(result?.hasMore).toBe(false);
    expect(result?.oldestSeq).toBeNull();
  });

  it("PAGINATION: a full page + an extra probe row → hasMore true, the probe row is dropped", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    // limit=2 asks for take=3; the DB returns 3 (newest-first) → an older page exists.
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      turnRow({ uuid: "t5", seq: 5 }),
      turnRow({ uuid: "t4", seq: 4 }),
      turnRow({ uuid: "t3", seq: 3 }), // the +1 probe row — dropped from the page
    ]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    const result = await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 2 },
    );

    // Only the page (2 turns) is returned, ascending; the probe row is dropped.
    expect(result?.turns.map((t) => t.uuid)).toEqual(["t4", "t5"]);
    expect(result?.hasMore).toBe(true);
    // oldestSeq = the earliest turn in the page → the next `beforeSeq` cursor.
    expect(result?.oldestSeq).toBe(4);
    // The message query keyed only on the PAGE's turns (probe row excluded).
    expect(mockPrisma.daemonTranscriptMessage.findMany.mock.calls[0][0].where).toEqual({
      turnUuid: { in: ["t4", "t5"] },
    });
  });

  it("PAGINATION: beforeSeq loads turns STRICTLY older than the cursor", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ uuid: "t1", seq: 1 })]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    await getSessionDetail(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      sessionUuid,
      { limit: 2, beforeSeq: 4 },
    );

    const turnArgs = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0];
    expect(turnArgs.where).toEqual({ sessionUuid, seq: { lt: 4 } });
    expect(turnArgs.take).toBe(3); // limit 2 + 1 probe
  });

  it("PAGINATION: a non-positive or oversized limit is clamped to 1..200", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValue(sessionRow());
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    mockPrisma.daemonTranscriptMessage.findMany.mockResolvedValue([]);

    await getSessionDetail({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid, { limit: 0 });
    expect(mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0].take).toBe(2); // clamped to 1 (+1)

    await getSessionDetail({ type: "user", companyUuid, actorUuid: ownerUuid }, sessionUuid, { limit: 9999 });
    expect(mockPrisma.daemonSessionTurn.findMany.mock.calls[1][0].take).toBe(201); // clamped to 200 (+1)
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
