// cli-agent-session-sync — daemon-session.service lease core + D8 exclusions.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => {
  const client = {
    daemonSession: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    },
    daemonSessionTurn: {
      findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    daemonConnection: { findFirst: vi.fn() },
    daemonExecution: { findFirst: vi.fn(), findMany: vi.fn() },
    notification: { findFirst: vi.fn() },
  } as Record<string, any>;
  client.$transaction = vi.fn(async (op: unknown) =>
    typeof op === "function" ? (op as (c: unknown) => unknown)(client) : Promise.all(op as Promise<unknown>[]));
  client.$queryRaw = vi.fn();
  return client;
});
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
const mockLogger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));
const mockEventBus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/services/lineage.service", () => ({ resolveDirectIdeaUuid: vi.fn() }));
vi.mock("@/services/daemon-connection.service", () => ({ STALE_THRESHOLD_MS: 90_000 }));
vi.mock("@/services/project-access.service", () => ({
  canActorAccessProject: vi.fn(async () => true), resolveEntityProjectUuid: vi.fn(async () => null),
}));
const mockDispatchControl = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-control.service", () => ({ dispatchControl: mockDispatchControl }));

import {
  advanceTurn,
  advanceTurnForWake,
  assertContinuable,
  drainExpiredCliLeases,
  drainQueuedTurns,
  endCliTurn,
  expireCliLeaseAndDrain,
  getPendingTurnsForConnection,
  getSessionDetail,
  getVisibleSessions,
  reconcileOrphanTurns,
  SessionNotContinuableError,
  SessionUnboundError,
  sweepExpiredCliLeasesForConnection,
} from "@/services/daemon-session.service";
import { DAEMON_OWNED_TURN } from "@/services/daemon-cli-lease";

const companyUuid = "company-1";
const agentUuid = "agent-1";
const sessionUuid = "session-1";
const connectionUuid = "conn-1";
const now = new Date("2026-11-09T12:00:00.000Z");
const future = new Date(now.getTime() + 30_000);
const past = new Date(now.getTime() - 1_000);

function turnRow(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "turn-cli", sessionUuid, backendSessionId: null, seq: 1, trigger: "cli_session", promptText: null,
    operationPayload: null, status: "ended", interruptedReason: null, relayError: null, wakeError: null,
    usage: null, executionUuid: null, startedAt: now, endedAt: now, createdAt: now, ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    uuid: sessionUuid, companyUuid, agentUuid, sessionId: "sid-1", backendSessionId: null, directIdeaUuid: null,
    originConnectionUuid: connectionUuid, runtimeCwd: null, status: "active", title: null, lastTurnAt: now,
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
    createdAt: now, updatedAt: now, cliLeaseHolder: null, cliLeaseExpiresAt: null, cliHost: null, cliCwd: null,
    continuable: true, turns: [], ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.$transaction.mockImplementation(async (op: unknown) =>
    typeof op === "function" ? (op as (c: unknown) => unknown)(mockPrisma) : Promise.all(op as Promise<unknown>[]));
  mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
  mockPrisma.daemonSession.findMany.mockResolvedValue([]);
});

describe("session read payload (Module Contracts)", () => {
  it("exposes cli {leased, host, cwd}, originBound and continuable", async () => {
    mockPrisma.daemonSession.findMany.mockResolvedValueOnce([
      sessionRow({ cliLeaseHolder: "h", cliLeaseExpiresAt: new Date(Date.now() + 60_000), cliHost: "box", cliCwd: "/w" }),
      sessionRow({ uuid: "s2", originConnectionUuid: null, cliHost: "box", cliCwd: "/x", continuable: false }),
      sessionRow({ uuid: "s3" }),
    ]);
    const views = await getVisibleSessions({ type: "agent", companyUuid, actorUuid: agentUuid });
    expect(views[0]).toMatchObject({ cli: { leased: true, host: "box", cwd: "/w" }, originBound: true, continuable: true });
    expect(views[1]).toMatchObject({ cli: { leased: false, host: "box", cwd: "/x" }, originBound: false, continuable: false, originConnectionUuid: null });
    expect(views[2]).toMatchObject({ cli: null, originBound: true, continuable: true });
  });

  it("lazily releases an expired lease on session detail read before loading turns", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce(
      sessionRow({ cliLeaseHolder: "h", cliLeaseExpiresAt: new Date(Date.now() - 1000), cliHost: "box", cliCwd: "/w" }),
    );
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.daemonSessionTurn.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.daemonSessionTurn.findMany
      .mockResolvedValueOnce([{ uuid: "turn-cli" }]) // endCliTurn running cli turns
      .mockResolvedValueOnce([]) // drain pending
      .mockResolvedValue([]);
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValue(turnRow());
    mockPrisma.daemonSession.findUnique.mockResolvedValue({ ...sessionRow(), agent: { ownerUuid: "owner" } });
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce(sessionRow());
    const detail = await getSessionDetail({ type: "agent", companyUuid, actorUuid: agentUuid }, sessionUuid);
    expect(detail).not.toBeNull();
    expect(mockPrisma.daemonSession.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ uuid: sessionUuid, cliLeaseHolder: "h", cliLeaseExpiresAt: { lte: expect.any(Date) } }),
      data: { cliLeaseHolder: null, cliLeaseExpiresAt: null },
    });
  });
});

describe("assertContinuable distinct refusals", () => {
  it("rejects a not-continuable session before an unbound one", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: null, continuable: false });
    await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toBeInstanceOf(SessionNotContinuableError);
  });
  it("rejects an unbound session", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: null, continuable: true });
    await expect(assertContinuable(companyUuid, sessionUuid)).rejects.toBeInstanceOf(SessionUnboundError);
  });
});

describe("D8 — cli_session turns are invisible to daemon turn machinery", () => {
  it("advanceTurn refuses to move a cli_session turn (interrupt/resume/orphan paths)", async () => {
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValueOnce({
      uuid: "turn-cli", sessionUuid, status: "running", trigger: "cli_session", promptText: null,
    });
    const res = await advanceTurn("turn-cli", "interrupted", { interruptedReason: "offline" });
    expect(res).toEqual({ ok: false, reason: "invalid_transition", from: "cli_session", to: "interrupted" });
    expect(mockPrisma.daemonSessionTurn.update).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });

  it("daemon reconnect (new-generation force reconcile) during a live CLI lease leaves the CLI turn running", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([]);
    const finalized = await reconcileOrphanTurns(companyUuid, connectionUuid, { force: true });
    expect(finalized).toBe(0);
    expect(mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0].where).toEqual({
      status: "running", ...DAEMON_OWNED_TURN, session: { companyUuid, originConnectionUuid: connectionUuid },
    });
  });

  it("refuses running admission (FIFO) while the session is CLI-leased; queued turns stay pending", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({
      uuid: sessionUuid, originConnectionUuid: connectionUuid, sessionId: "sid-1",
      cliLeaseHolder: "h", cliLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const res = await advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId: "sid-1", status: "running" });
    expect(res).toEqual({ ok: false, reason: "invalid_transition", from: "cli_leased", to: "running" });
    expect(mockPrisma.daemonSessionTurn.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });

  it("refuses exact admission while leased and never admits a CLI turn row", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ uuid: sessionUuid }]);
    mockPrisma.daemonSession.findFirst.mockResolvedValue({
      ...sessionRow({ cliLeaseHolder: "h", cliLeaseExpiresAt: new Date(Date.now() + 60_000) }), agent: { ownerUuid: "o" },
    });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: connectionUuid });
    const leased = await advanceTurnForWake({
      companyUuid, agentUuid, connectionUuid, sessionId: "sid-1", status: "running", wakeRecoveryProtocol: 1,
      turnUuid: "turn-2", turnUuids: ["turn-2"], admissionUuid: "adm-1",
    });
    expect(leased).toEqual({ ok: false, reason: "invalid_transition", from: "cli_leased", to: "running" });

    mockPrisma.daemonSession.findFirst.mockResolvedValue({ ...sessionRow(), agent: { ownerUuid: "o" } });
    mockPrisma.daemonSessionTurn.findFirst.mockResolvedValue(turnRow({ status: "running" }));
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([turnRow({ status: "running" })]);
    const cliRow = await advanceTurnForWake({
      companyUuid, agentUuid, connectionUuid, sessionId: "sid-1", status: "ended", wakeRecoveryProtocol: 1,
      turnUuid: "turn-cli", turnUuids: ["turn-cli"], admissionUuid: "adm-1",
    });
    expect(cliRow).toEqual({ ok: false, reason: "not_found" });
    expect(mockPrisma.daemonSessionTurn.updateMany).not.toHaveBeenCalled();
  });
});

describe("isCliLeased delivery gate — backfill", () => {
  it("excludes leased sessions and CLI turns from pending-turns backfill after sweeping expired leases", async () => {
    await getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid });
    // First findMany = sweep of expired leases bound to the connection.
    expect(mockPrisma.daemonSession.findMany.mock.calls[0][0].where).toMatchObject({
      companyUuid, originConnectionUuid: connectionUuid, cliLeaseHolder: { not: null },
    });
    const where = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "pending", ...DAEMON_OWNED_TURN });
    expect(where.session.OR).toEqual([
      { cliLeaseHolder: null }, { cliLeaseExpiresAt: null }, { cliLeaseExpiresAt: { lte: expect.any(Date) } },
    ]);
  });
});

describe("endCliTurn", () => {
  it("ends the running CLI turn once and publishes status + session_ended", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([{ uuid: "turn-cli" }]);
    mockPrisma.daemonSessionTurn.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.daemonSessionTurn.findUnique.mockResolvedValueOnce(turnRow());
    mockPrisma.daemonSession.findUnique.mockResolvedValueOnce({
      companyUuid, directIdeaUuid: null, agentUuid, originConnectionUuid: null, agent: { ownerUuid: "o" },
    });
    const ended = await endCliTurn(sessionUuid, now);
    expect(ended.map((t) => t.uuid)).toEqual(["turn-cli"]);
    expect(mockPrisma.daemonSessionTurn.updateMany).toHaveBeenCalledWith({
      where: { uuid: "turn-cli", trigger: "cli_session", status: "running" },
      data: { status: "ended", endedAt: now },
    });
    const events = mockEventBus.emit.mock.calls.map((c) => c[0]);
    expect(events).toEqual([`transcript:${sessionUuid}`, "session_activity"]);
    expect(mockEventBus.emit.mock.calls[1][1]).toMatchObject({ type: "session_ended", originConnectionUuid: null });
  });

  it("is a no-op when there is no running CLI turn or the claim is lost", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([]);
    expect(await endCliTurn(sessionUuid)).toEqual([]);
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([{ uuid: "turn-cli" }]);
    mockPrisma.daemonSessionTurn.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await endCliTurn(sessionUuid)).toEqual([]);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });
});

describe("drainQueuedTurns", () => {
  const live = { status: "online", lastSeenAt: now };
  it("pings every pending daemon-owned turn oldest-first to the online origin", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({
      originConnectionUuid: connectionUuid, runtimeCwd: "/w", cliLeaseHolder: null, cliLeaseExpiresAt: null,
    });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([
      { uuid: "t2", wakeTargetConnectionUuid: null, wakeRuntimeCwd: null },
      { uuid: "t3", wakeTargetConnectionUuid: "conn-2", wakeRuntimeCwd: "/z" },
    ]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValueOnce(live);
    expect(await drainQueuedTurns(companyUuid, sessionUuid, now)).toEqual(["t2", "t3"]);
    expect(mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0]).toMatchObject({
      where: { sessionUuid, status: "pending", ...DAEMON_OWNED_TURN }, orderBy: { seq: "asc" },
    });
    expect(mockDispatchControl.mock.calls.map((c) => c[0])).toEqual([
      { companyUuid, targetConnectionUuid: connectionUuid, command: "deliver_turn", turnUuid: "t2", runtimeCwd: "/w" },
      { companyUuid, targetConnectionUuid: "conn-2", command: "deliver_turn", turnUuid: "t3", runtimeCwd: "/z" },
    ]);
  });

  it("delivers nothing when unbound, still leased, offline, or nothing is queued", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: null, runtimeCwd: null, cliLeaseHolder: null, cliLeaseExpiresAt: null });
    expect(await drainQueuedTurns(companyUuid, sessionUuid, now)).toEqual([]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: connectionUuid, runtimeCwd: null, cliLeaseHolder: "h", cliLeaseExpiresAt: future });
    expect(await drainQueuedTurns(companyUuid, sessionUuid, now)).toEqual([]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: connectionUuid, runtimeCwd: null, cliLeaseHolder: null, cliLeaseExpiresAt: null });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([]);
    expect(await drainQueuedTurns(companyUuid, sessionUuid, now)).toEqual([]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: connectionUuid, runtimeCwd: null, cliLeaseHolder: null, cliLeaseExpiresAt: null });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([{ uuid: "t2", wakeTargetConnectionUuid: null, wakeRuntimeCwd: null }]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValueOnce({ status: "online", lastSeenAt: new Date(now.getTime() - 200_000) });
    expect(await drainQueuedTurns(companyUuid, sessionUuid, now)).toEqual([]);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("logs and continues when a ping fails", async () => {
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: connectionUuid, runtimeCwd: null, cliLeaseHolder: null, cliLeaseExpiresAt: null });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([
      { uuid: "t2", wakeTargetConnectionUuid: null, wakeRuntimeCwd: null },
      { uuid: "t3", wakeTargetConnectionUuid: null, wakeRuntimeCwd: null },
    ]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValueOnce(live);
    mockDispatchControl.mockImplementationOnce(() => { throw new Error("bus down"); });
    expect(await drainQueuedTurns(companyUuid, sessionUuid, now)).toEqual(["t3"]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe("D4 expiry triggers are idempotent", () => {
  it("only the trigger that wins the conditional clear ends the turn and drains", async () => {
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await expireCliLeaseAndDrain(companyUuid, sessionUuid, "h", now)).toBe(false);
    expect(mockPrisma.daemonSessionTurn.findMany).not.toHaveBeenCalled();

    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([]); // no running CLI turn
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: connectionUuid, runtimeCwd: null, cliLeaseHolder: null, cliLeaseExpiresAt: null });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([{ uuid: "t2", wakeTargetConnectionUuid: null, wakeRuntimeCwd: null }]);
    mockPrisma.daemonConnection.findFirst.mockResolvedValueOnce({ status: "online", lastSeenAt: now });
    expect(await expireCliLeaseAndDrain(companyUuid, sessionUuid, "h", now)).toBe(true);
    expect(mockPrisma.daemonSession.updateMany).toHaveBeenLastCalledWith({
      where: { uuid: sessionUuid, companyUuid, cliLeaseHolder: "h", cliLeaseExpiresAt: { lte: now } },
      data: { cliLeaseHolder: null, cliLeaseExpiresAt: null },
    });
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
  });

  it("drainExpiredCliLeases skips live / absent leases and survives failures", async () => {
    expect(await drainExpiredCliLeases(companyUuid, [
      { uuid: "a", cliLeaseHolder: null, cliLeaseExpiresAt: null },
      { uuid: "b", cliLeaseHolder: "h", cliLeaseExpiresAt: future },
      { uuid: "c" },
    ], now)).toBe(0);
    expect(mockPrisma.daemonSession.updateMany).not.toHaveBeenCalled();

    mockPrisma.daemonSession.updateMany.mockRejectedValueOnce(new Error("db"));
    expect(await drainExpiredCliLeases(companyUuid, [{ uuid: "d", cliLeaseHolder: "h", cliLeaseExpiresAt: past }], now)).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("heartbeat sweep releases the expired leases bound to the connection; errors are swallowed", async () => {
    mockPrisma.daemonSession.findMany.mockResolvedValueOnce([{ uuid: "s1", cliLeaseHolder: "h", cliLeaseExpiresAt: past }]);
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: connectionUuid, runtimeCwd: null, cliLeaseHolder: null, cliLeaseExpiresAt: null });
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValueOnce([]);
    expect(await sweepExpiredCliLeasesForConnection(companyUuid, connectionUuid, now)).toBe(1);
    expect(mockPrisma.daemonSession.findMany.mock.calls[0][0]).toMatchObject({
      where: { companyUuid, originConnectionUuid: connectionUuid, cliLeaseHolder: { not: null }, cliLeaseExpiresAt: { lte: now } },
      take: 50,
    });
    expect(mockDispatchControl).not.toHaveBeenCalled(); // nothing queued → nothing woken

    mockPrisma.daemonSession.findMany.mockRejectedValueOnce(new Error("db"));
    expect(await sweepExpiredCliLeasesForConnection(companyUuid, connectionUuid, now)).toBe(0);
  });
});
