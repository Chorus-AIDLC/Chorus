import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonExecution: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  daemonConnection: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  task: {
    findMany: vi.fn(),
  },
  idea: {
    findMany: vi.fn(),
  },
  proposal: {
    findMany: vi.fn(),
  },
  document: {
    findMany: vi.fn(),
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

// The service imports the EventBus (for publishExecutionChange). Mock it so the
// unit test does not pull the real event-bus → redis → logger.child() chain and
// can assert the publish emit shape directly.
const mockEventBus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

import {
  ACTIVE_EXECUTION_STATUSES,
  ENDED_EXECUTION_STATUS,
  EXECUTION_ENTITY_TYPES,
  STALE_THRESHOLD_MS,
  reconcileSnapshot,
  reconcileOffline,
  getVisibleExecutions,
  getExecutionsForConnection,
  connectionBelongsToAgent,
  connectionVisibleToCaller,
  listVisibleConnectionUuids,
  filterValidExecutionEntities,
  publishExecutionChange,
  executionEventName,
  reportExecutionInterrupt,
  resumeExecution,
  isConnectionLive,
  INTERRUPTED_EXECUTION_STATUS,
  DISPLAYABLE_EXECUTION_STATUSES,
  type SnapshotExecution,
} from "@/services/daemon-execution.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const otherCompanyUuid = "company-0000-0000-0000-000000000002";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const t1 = "task-0000-0000-0000-000000000001";
const t2 = "task-0000-0000-0000-000000000002";
const idea1 = "idea-0000-0000-0000-000000000001";

// Build the active-rows result the reconcile's "end absent" query reads. Each
// row needs id + entityType + entityUuid (the select shape reconcileSnapshot uses).
function activeRow(id: number, entityType: string, entityUuid: string) {
  return { id, entityType, entityUuid };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.daemonExecution.upsert.mockResolvedValue({});
  mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
  mockPrisma.daemonConnection.count.mockResolvedValue(0);
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.idea.findMany.mockResolvedValue([]);
  mockPrisma.proposal.findMany.mockResolvedValue([]);
  mockPrisma.document.findMany.mockResolvedValue([]);
});

// ===== Constants =====
describe("constants", () => {
  it("ACTIVE_EXECUTION_STATUSES are exactly running + queued", () => {
    expect(ACTIVE_EXECUTION_STATUSES).toEqual(["running", "queued"]);
  });

  it("ENDED_EXECUTION_STATUS is the single terminal value 'ended'", () => {
    expect(ENDED_EXECUTION_STATUS).toBe("ended");
  });

  it("EXECUTION_ENTITY_TYPES cover task/idea/proposal/document (every wake resource)", () => {
    expect([...EXECUTION_ENTITY_TYPES].sort()).toEqual(
      ["document", "idea", "proposal", "task"].sort(),
    );
  });

  it("re-exports the registry's STALE_THRESHOLD_MS (no second constant)", () => {
    expect(STALE_THRESHOLD_MS).toBe(90_000);
  });
});

// ===== reconcileSnapshot =====
describe("reconcileSnapshot", () => {
  it("ends active rows absent from the snapshot, then upserts the reported resource", async () => {
    // Connection had task t1 (absent now) + task t2 (still reported). t1 ends.
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      activeRow(11, "task", t1),
      activeRow(12, "task", t2),
    ]);
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 1 });
    const executions: SnapshotExecution[] = [
      { entityType: "task", entityUuid: t2, rootIdeaUuid: null, status: "running", startedAt: new Date() },
    ];

    const reconciled = await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);

    // The "end absent" updateMany targets exactly the ids NOT kept (t1's row).
    const endArg = mockPrisma.daemonExecution.updateMany.mock.calls[0][0];
    expect(endArg.where).toEqual({ id: { in: [11] } });
    expect(endArg.data).toEqual({ status: "ended" });

    // Then the reported resource is upserted on the (connection, type, uuid) key.
    expect(mockPrisma.daemonExecution.upsert).toHaveBeenCalledTimes(1);
    const upArg = mockPrisma.daemonExecution.upsert.mock.calls[0][0];
    expect(upArg.where).toEqual({
      connectionUuid_entityType_entityUuid: {
        connectionUuid,
        entityType: "task",
        entityUuid: t2,
      },
    });
    expect(upArg.create.entityType).toBe("task");
    expect(upArg.create.entityUuid).toBe(t2);
    expect(upArg.create.status).toBe("running");
    expect(upArg.create.companyUuid).toBe(companyUuid);
    expect(upArg.create.agentUuid).toBe(agentUuid);
    expect(upArg.update.companyUuid).toBe(companyUuid);
    expect(upArg.update.agentUuid).toBe(agentUuid);

    // Return value = ended count + reported count.
    expect(reconciled).toBe(1 + 1);
  });

  it("records a NON-TASK resource (idea wake): an idea @-mention is upserted as entityType idea", async () => {
    const executions: SnapshotExecution[] = [
      { entityType: "idea", entityUuid: idea1, rootIdeaUuid: idea1, status: "running", startedAt: new Date() },
    ];
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);
    const upArg = mockPrisma.daemonExecution.upsert.mock.calls[0][0];
    expect(upArg.where.connectionUuid_entityType_entityUuid).toEqual({
      connectionUuid,
      entityType: "idea",
      entityUuid: idea1,
    });
    expect(upArg.create.entityType).toBe("idea");
    expect(upArg.create.entityUuid).toBe(idea1);
  });

  it("a uuid that appears under a DIFFERENT type is not accidentally kept (type+uuid identity)", async () => {
    // Active row is (task, X); the snapshot reports (idea, X) — same uuid, other
    // type. The task row must END (not be spared) and a new idea row upserted.
    const sharedUuid = "shared-uuid-0000-0000-0000-00000000aaaa";
    mockPrisma.daemonExecution.findMany.mockResolvedValue([activeRow(20, "task", sharedUuid)]);
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 1 });
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, [
      { entityType: "idea", entityUuid: sharedUuid, status: "running" },
    ]);
    const endArg = mockPrisma.daemonExecution.updateMany.mock.calls[0][0];
    expect(endArg.where).toEqual({ id: { in: [20] } }); // the (task, X) row ends
  });

  it("upserts every reported resource on its unique key (at most one row per resource)", async () => {
    const executions: SnapshotExecution[] = [
      { entityType: "task", entityUuid: t1, status: "running", startedAt: new Date() },
      { entityType: "idea", entityUuid: idea1, status: "queued" },
    ];

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);

    expect(mockPrisma.daemonExecution.upsert).toHaveBeenCalledTimes(2);
    const keys = mockPrisma.daemonExecution.upsert.mock.calls.map(
      (c) => c[0].where.connectionUuid_entityType_entityUuid,
    );
    expect(keys).toEqual([
      { connectionUuid, entityType: "task", entityUuid: t1 },
      { connectionUuid, entityType: "idea", entityUuid: idea1 },
    ]);
    const queuedUpsert = mockPrisma.daemonExecution.upsert.mock.calls[1][0];
    expect(queuedUpsert.create.status).toBe("queued");
    expect(queuedUpsert.create.startedAt).toBeNull();
  });

  it("coerces missing rootIdeaUuid/startedAt to null", async () => {
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, [
      { entityType: "task", entityUuid: t1, status: "queued" },
    ]);
    const upArg = mockPrisma.daemonExecution.upsert.mock.calls[0][0];
    expect(upArg.create.rootIdeaUuid).toBeNull();
    expect(upArg.create.startedAt).toBeNull();
    expect(upArg.update.rootIdeaUuid).toBeNull();
  });

  it("an empty snapshot ends ALL of the connection's active rows", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      activeRow(1, "task", t1),
      activeRow(2, "idea", idea1),
      activeRow(3, "task", t2),
    ]);
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 3 });
    const reconciled = await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, []);
    const endArg = mockPrisma.daemonExecution.updateMany.mock.calls[0][0];
    expect(endArg.where).toEqual({ id: { in: [1, 2, 3] } });
    expect(mockPrisma.daemonExecution.upsert).not.toHaveBeenCalled();
    expect(reconciled).toBe(3);
  });

  it("does NOT issue an end query when no active rows need ending (all kept)", async () => {
    // The only active row is the one being reported, so nothing ends.
    mockPrisma.daemonExecution.findMany.mockResolvedValue([activeRow(5, "task", t1)]);
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, [
      { entityType: "task", entityUuid: t1, status: "running" },
    ]);
    expect(mockPrisma.daemonExecution.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.daemonExecution.upsert).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: re-applying the identical snapshot issues the same upsert shape", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]); // nothing to end
    const executions: SnapshotExecution[] = [
      { entityType: "task", entityUuid: t1, status: "running", startedAt: new Date("2026-06-15T03:00:00Z") },
      { entityType: "idea", entityUuid: idea1, status: "queued" },
    ];

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);
    const firstUpserts = mockPrisma.daemonExecution.upsert.mock.calls.map((c) => c[0]);

    vi.clearAllMocks();
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.daemonExecution.upsert.mockResolvedValue({});
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);
    const secondUpserts = mockPrisma.daemonExecution.upsert.mock.calls.map((c) => c[0]);

    expect(secondUpserts).toEqual(firstUpserts);
    expect(secondUpserts.map((u) => u.update.status)).toEqual(["running", "queued"]);
  });

  it("never writes the 'ended' status on an upsert — ended is only ever set by reconcile", async () => {
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, [
      { entityType: "task", entityUuid: t1, status: "running" },
    ]);
    const upArg = mockPrisma.daemonExecution.upsert.mock.calls[0][0];
    expect(upArg.create.status).not.toBe("ended");
    expect(upArg.update.status).not.toBe("ended");
  });
});

// ===== reconcileOffline =====
describe("reconcileOffline", () => {
  it("transitions the connection's running/queued rows to ended (retained, not deleted), companyUuid-scoped", async () => {
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 2 });

    const count = await reconcileOffline(companyUuid, connectionUuid);

    expect(mockPrisma.daemonExecution.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonExecution.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      companyUuid,
      connectionUuid,
      status: { in: ["running", "queued"] },
    });
    // updateMany (not deleteMany) — rows are retained as history.
    expect(arg.data).toEqual({ status: "ended" });
    expect(count).toBe(2);
  });

  it("swallows + logs a persistence error and returns 0 (never throws into stream teardown)", async () => {
    mockPrisma.daemonExecution.updateMany.mockRejectedValue(new Error("db down"));
    const count = await reconcileOffline(companyUuid, connectionUuid);
    expect(count).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== getVisibleExecutions (visibility scoping + enrichment) =====
describe("getVisibleExecutions", () => {
  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      uuid: "exec-1",
      agentUuid,
      connectionUuid,
      entityType: "task",
      entityUuid: t1,
      rootIdeaUuid: null,
      status: "running",
      interruptedReason: null,
      startedAt: new Date("2026-06-15T03:00:00.000Z"),
      createdAt: new Date("2026-06-15T03:00:00.000Z"),
      updatedAt: new Date("2026-06-15T03:30:00.000Z"),
      ...overrides,
    };
  }

  beforeEach(() => {
    // Default: rows' connection is effectively ONLINE so the staleness gate keeps them.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
  });

  it("USER caller: owner-scoped via agent.ownerUuid, companyUuid-scoped, active only; enriches a task row", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: t1, title: "Build the thing", projectUuid: "proj-1" },
    ]);

    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });

    expect(mockPrisma.daemonExecution.findMany.mock.calls[0][0]).toEqual({
      where: {
        companyUuid,
        status: { in: ["running", "queued", "interrupted"] },
        agent: { ownerUuid },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      uuid: "exec-1",
      agentUuid,
      connectionUuid,
      entityType: "task",
      entityUuid: t1,
      rootIdeaUuid: null,
      status: "running",
      interruptedReason: null,
      startedAt: "2026-06-15T03:00:00.000Z",
      createdAt: "2026-06-15T03:00:00.000Z",
      updatedAt: "2026-06-15T03:30:00.000Z",
      entityTitle: "Build the thing",
      projectUuid: "proj-1",
      rootIdeaTitle: null,
    });
  });

  it("enriches an IDEA-kind row from the idea table (title + project), with its root-idea label", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "idea-row", entityType: "idea", entityUuid: idea1, rootIdeaUuid: idea1 }),
    ]);
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: idea1, title: "Daemon dispatch idea", projectUuid: "proj-idea" },
    ]);

    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });

    // idea lookup is batched + companyUuid-scoped; the task table is not queried.
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
    const ideaArg = mockPrisma.idea.findMany.mock.calls[0][0];
    expect(ideaArg.where.companyUuid).toBe(companyUuid);
    const row = result[0];
    expect(row.entityType).toBe("idea");
    expect(row.entityTitle).toBe("Daemon dispatch idea");
    expect(row.projectUuid).toBe("proj-idea");
    // rootIdeaUuid === entityUuid here, so the session label reuses the same title.
    expect(row.rootIdeaTitle).toBe("Daemon dispatch idea");
  });

  it("enriches a PROPOSAL-kind row from the proposal table", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "prop-row", entityType: "proposal", entityUuid: "prop-1", rootIdeaUuid: null }),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "prop-1", title: "A proposal", projectUuid: "proj-p" },
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result[0].entityTitle).toBe("A proposal");
    expect(result[0].projectUuid).toBe("proj-p");
  });

  it("a deleted entity degrades to null title/project rather than throwing", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "ghost", entityType: "task", entityUuid: t2 }),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([]); // t2 no longer resolves
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result[0].entityTitle).toBeNull();
    expect(result[0].projectUuid).toBeNull();
  });

  it("super_admin caller is owner-scoped too (only the agent relation, not the company at large)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    await getVisibleExecutions({ type: "super_admin", companyUuid, actorUuid: ownerUuid });
    const arg = mockPrisma.daemonExecution.findMany.mock.calls[0][0];
    expect(arg.where.agent).toEqual({ ownerUuid });
    expect(arg.where.agentUuid).toBeUndefined();
  });

  it("AGENT-KEY caller: self-scoped via agentUuid (not the owner relation), companyUuid-scoped", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    await getVisibleExecutions({ type: "agent", companyUuid, actorUuid: agentUuid });
    expect(mockPrisma.daemonExecution.findMany.mock.calls[0][0]).toEqual({
      // The read includes the sticky `interrupted` status (子3) so an
      // interrupted/resumable row keeps showing — not just the two active statuses.
      where: { companyUuid, status: { in: ["running", "queued", "interrupted"] }, agentUuid },
    });
  });

  it("the where clause always carries the caller's companyUuid (visibility never crosses companies)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    await getVisibleExecutions({ type: "user", companyUuid: otherCompanyUuid, actorUuid: ownerUuid });
    const arg = mockPrisma.daemonExecution.findMany.mock.calls[0][0];
    expect(arg.where.companyUuid).toBe(otherCompanyUuid);
  });

  it("returns an empty array when there are genuinely no rows", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    await expect(
      getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid }),
    ).resolves.toEqual([]);
  });

  it("PROPAGATES a query error (does NOT swallow to [] like the write functions)", async () => {
    mockPrisma.daemonExecution.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid }),
    ).rejects.toThrow("db down");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("sorts running-first then updatedAt desc", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "queued-new", status: "queued", updatedAt: new Date("2026-06-15T05:00:00Z") }),
      makeRow({ uuid: "running-old", status: "running", updatedAt: new Date("2026-06-15T03:00:00Z") }),
      makeRow({ uuid: "running-new", status: "running", updatedAt: new Date("2026-06-15T04:00:00Z") }),
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result.map((r) => r.uuid)).toEqual(["running-new", "running-old", "queued-new"]);
  });

  // ===== Read-time staleness gate (offline rule, no clean abort) =====

  it("EXCLUDES rows whose connection is stale (lastSeenAt older than STALE_THRESHOLD_MS)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 5_000)) },
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result).toEqual([]);
  });

  it("EXCLUDES rows whose connection status is offline (clean disconnect), regardless of lastSeenAt", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "offline", lastSeenAt: new Date() },
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result).toEqual([]);
  });

  it("EXCLUDES rows whose connection no longer exists (deleted connection cannot be online)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result).toEqual([]);
  });

  it("KEEPS rows of a live connection and DROPS rows of a stale sibling in the same read (mixed)", async () => {
    const liveConn = "conn-live";
    const staleConn = "conn-stale";
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "live-row", connectionUuid: liveConn }),
      makeRow({ uuid: "stale-row", connectionUuid: staleConn }),
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: liveConn, status: "online", lastSeenAt: new Date() },
      { uuid: staleConn, status: "online", lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 1)) },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1, title: "T1", projectUuid: "p1" }]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result.map((r) => r.uuid)).toEqual(["live-row"]);
    const connArg = mockPrisma.daemonConnection.findMany.mock.calls[0][0];
    expect(connArg.where.companyUuid).toBe(companyUuid);
    expect(connArg.where.uuid.in.slice().sort()).toEqual([liveConn, staleConn].sort());
  });

  it("does NOT query connections when there are no active rows (cheap empty path)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(mockPrisma.daemonConnection.findMany).not.toHaveBeenCalled();
  });
});

// ===== getExecutionsForConnection =====
describe("getExecutionsForConnection", () => {
  it("filters by companyUuid + connectionUuid + displayable status (active + sticky interrupted)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    await getExecutionsForConnection(companyUuid, connectionUuid);
    expect(mockPrisma.daemonExecution.findMany.mock.calls[0][0]).toEqual({
      where: {
        companyUuid,
        connectionUuid,
        status: { in: ["running", "queued", "interrupted"] },
      },
    });
  });

  it("PROPAGATES a query error (read path surfaces the error)", async () => {
    mockPrisma.daemonExecution.findMany.mockRejectedValue(new Error("db down"));
    await expect(getExecutionsForConnection(companyUuid, connectionUuid)).rejects.toThrow("db down");
  });

  function makeRow() {
    return {
      uuid: "exec-1", agentUuid, connectionUuid, entityType: "task", entityUuid: t1, rootIdeaUuid: null,
      status: "running", startedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    };
  }

  it("returns the active rows when the connection is effectively ONLINE (fresh heartbeat)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1, title: "T1", projectUuid: "p1" }]);
    const result = await getExecutionsForConnection(companyUuid, connectionUuid);
    expect(result.map((r) => r.uuid)).toEqual(["exec-1"]);
  });

  it("returns an EMPTY active set when the connection is stale/offline (offline rule, no clean abort)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 1)) },
    ]);
    const result = await getExecutionsForConnection(companyUuid, connectionUuid);
    expect(result).toEqual([]);
  });
});

// ===== connectionBelongsToAgent (ownership fence) =====
describe("connectionBelongsToAgent", () => {
  it("counts the connection scoped by uuid + companyUuid + agentUuid", async () => {
    mockPrisma.daemonConnection.count.mockResolvedValue(1);
    const owns = await connectionBelongsToAgent(companyUuid, agentUuid, connectionUuid);
    expect(mockPrisma.daemonConnection.count.mock.calls[0][0]).toEqual({
      where: { uuid: connectionUuid, companyUuid, agentUuid },
    });
    expect(owns).toBe(true);
  });

  it("returns false when the connection is not owned / not in the company", async () => {
    mockPrisma.daemonConnection.count.mockResolvedValue(0);
    await expect(connectionBelongsToAgent(companyUuid, agentUuid, connectionUuid)).resolves.toBe(false);
  });

  it("PROPAGATES a query error (fence is a read, does not swallow to 'not found')", async () => {
    mockPrisma.daemonConnection.count.mockRejectedValue(new Error("db down"));
    await expect(connectionBelongsToAgent(companyUuid, agentUuid, connectionUuid)).rejects.toThrow("db down");
  });
});

// ===== connectionVisibleToCaller (read-path visibility fence) =====
describe("connectionVisibleToCaller", () => {
  it("AGENT-KEY caller: self-scoped by agentUuid", async () => {
    mockPrisma.daemonConnection.count.mockResolvedValue(1);
    const visible = await connectionVisibleToCaller(
      { type: "agent", companyUuid, actorUuid: agentUuid },
      connectionUuid,
    );
    expect(mockPrisma.daemonConnection.count.mock.calls[0][0]).toEqual({
      where: { uuid: connectionUuid, companyUuid, agentUuid },
    });
    expect(visible).toBe(true);
  });

  it("USER caller: owner-scoped via agent.ownerUuid", async () => {
    mockPrisma.daemonConnection.count.mockResolvedValue(1);
    await connectionVisibleToCaller({ type: "user", companyUuid, actorUuid: ownerUuid }, connectionUuid);
    expect(mockPrisma.daemonConnection.count.mock.calls[0][0]).toEqual({
      where: { uuid: connectionUuid, companyUuid, agent: { ownerUuid } },
    });
  });

  it("returns false when not visible to the caller", async () => {
    mockPrisma.daemonConnection.count.mockResolvedValue(0);
    await expect(
      connectionVisibleToCaller({ type: "agent", companyUuid, actorUuid: agentUuid }, connectionUuid),
    ).resolves.toBe(false);
  });
});

// ===== listVisibleConnectionUuids (SSE subscription scoping) =====
describe("listVisibleConnectionUuids", () => {
  it("AGENT-KEY caller: self-scoped by agentUuid, companyUuid-scoped, returns uuids", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([{ uuid: "c1" }, { uuid: "c2" }]);
    const result = await listVisibleConnectionUuids({ type: "agent", companyUuid, actorUuid: agentUuid });
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agentUuid },
      select: { uuid: true },
    });
    expect(result).toEqual(["c1", "c2"]);
  });

  it("USER caller: owner-scoped via agent.ownerUuid", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([{ uuid: "c1" }]);
    await listVisibleConnectionUuids({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agent: { ownerUuid } },
      select: { uuid: true },
    });
  });

  it("returns an empty array when the caller owns no connections", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
    await expect(
      listVisibleConnectionUuids({ type: "user", companyUuid, actorUuid: ownerUuid }),
    ).resolves.toEqual([]);
  });

  it("PROPAGATES a query error (read path, does not swallow)", async () => {
    mockPrisma.daemonConnection.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      listVisibleConnectionUuids({ type: "agent", companyUuid, actorUuid: agentUuid }),
    ).rejects.toThrow("db down");
  });
});

// ===== filterValidExecutionEntities (best-effort multi-tenancy body filter) =====
describe("filterValidExecutionEntities", () => {
  it("an empty snapshot yields an empty list and touches no query", async () => {
    await expect(filterValidExecutionEntities(companyUuid, [])).resolves.toEqual([]);
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.idea.findMany).not.toHaveBeenCalled();
  });

  it("KEEPS entries whose entity resolves in-company; queries are per-type + companyUuid-scoped + deduped", async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1 }, { uuid: t2 }]);
    const kept = await filterValidExecutionEntities(companyUuid, [
      { entityType: "task", entityUuid: t1, status: "running" },
      { entityType: "task", entityUuid: t1, status: "running" }, // dup
      { entityType: "task", entityUuid: t2, status: "queued" },
    ]);
    const arg = mockPrisma.task.findMany.mock.calls[0][0];
    expect(arg.where.companyUuid).toBe(companyUuid);
    expect(arg.where.uuid.in.slice().sort()).toEqual([t1, t2].sort());
    // Both distinct tasks resolve, so all three entries (incl. the dup) are kept.
    expect(kept).toHaveLength(3);
  });

  it("DROPS an entry whose entity does not resolve in-company (instead of rejecting the whole snapshot)", async () => {
    // t1 resolves, t2 does not → t2 entry is dropped, t1 entry kept.
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1 }]);
    const kept = await filterValidExecutionEntities(companyUuid, [
      { entityType: "task", entityUuid: t1, status: "running" },
      { entityType: "task", entityUuid: t2, status: "queued" },
    ]);
    expect(kept).toEqual([{ entityType: "task", entityUuid: t1, rootIdeaUuid: null, status: "running" }]);
  });

  it("resolves DIFFERENT entity kinds against their own tables (idea/proposal/document)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([{ uuid: idea1 }]);
    mockPrisma.proposal.findMany.mockResolvedValue([{ uuid: "prop-1" }]);
    mockPrisma.document.findMany.mockResolvedValue([]); // doc deleted → dropped
    const kept = await filterValidExecutionEntities(companyUuid, [
      { entityType: "idea", entityUuid: idea1, status: "running" },
      { entityType: "proposal", entityUuid: "prop-1", status: "queued" },
      { entityType: "document", entityUuid: "doc-x", status: "running" },
    ]);
    expect(kept.map((e) => `${e.entityType}:${e.entityUuid}`).sort()).toEqual(
      [`idea:${idea1}`, "proposal:prop-1"].sort(),
    );
  });

  it("NULLS a non-resolving rootIdeaUuid but KEEPS the entry (valid entity, unknown anchor)", async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1 }]);
    mockPrisma.idea.findMany.mockResolvedValue([]); // the root idea doesn't resolve
    const kept = await filterValidExecutionEntities(companyUuid, [
      { entityType: "task", entityUuid: t1, rootIdeaUuid: "idea-x", status: "running" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].rootIdeaUuid).toBeNull();
  });

  it("KEEPS a resolving rootIdeaUuid", async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1 }]);
    mockPrisma.idea.findMany.mockResolvedValue([{ uuid: idea1 }]);
    const kept = await filterValidExecutionEntities(companyUuid, [
      { entityType: "task", entityUuid: t1, rootIdeaUuid: idea1, status: "running" },
    ]);
    expect(kept[0].rootIdeaUuid).toBe(idea1);
  });
});

// ===== publishExecutionChange (SSE event publish) =====
describe("publishExecutionChange", () => {
  it("emits execution:{connectionUuid} carrying the current active set + companyUuid", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([
      {
        uuid: "exec-1",
        agentUuid,
        connectionUuid,
        entityType: "idea",
        entityUuid: idea1,
        rootIdeaUuid: idea1,
        status: "running",
        startedAt: new Date("2026-06-15T03:00:00.000Z"),
        createdAt: new Date("2026-06-15T03:00:00.000Z"),
        updatedAt: new Date("2026-06-15T03:00:00.000Z"),
      },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
    mockPrisma.idea.findMany.mockResolvedValue([{ uuid: idea1, title: "An idea", projectUuid: "p" }]);

    await publishExecutionChange(companyUuid, connectionUuid);

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockEventBus.emit.mock.calls[0];
    expect(eventName).toBe(`execution:${connectionUuid}`);
    expect(eventName).toBe(executionEventName(connectionUuid));
    expect(payload.companyUuid).toBe(companyUuid);
    expect(payload.connectionUuid).toBe(connectionUuid);
    expect(payload.executions).toHaveLength(1);
    expect(payload.executions[0].entityType).toBe("idea");
    expect(payload.executions[0].entityUuid).toBe(idea1);
  });

  it("emits an empty active set on the offline path (re-reads post-reconcile state)", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    await publishExecutionChange(companyUuid, connectionUuid);
    const [, payload] = mockEventBus.emit.mock.calls[0];
    expect(payload.executions).toEqual([]);
  });

  it("swallows + logs a read failure and does NOT emit (never throws into teardown)", async () => {
    mockPrisma.daemonExecution.findMany.mockRejectedValue(new Error("db down"));
    await expect(publishExecutionChange(companyUuid, connectionUuid)).resolves.toBeUndefined();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== Interrupt / resume (子3) — entity-generic, on the execution row =====
describe("reportExecutionInterrupt", () => {
  it("marks the connection+entity row interrupted with the given reason", async () => {
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 1 });
    const ok = await reportExecutionInterrupt(companyUuid, connectionUuid, "task", t1, "user");
    expect(ok).toBe(true);
    expect(mockPrisma.daemonExecution.updateMany).toHaveBeenCalledWith({
      where: { companyUuid, connectionUuid, entityType: "task", entityUuid: t1 },
      data: { status: INTERRUPTED_EXECUTION_STATUS, interruptedReason: "user" },
    });
  });

  it("records reason=crash too", async () => {
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 1 });
    await reportExecutionInterrupt(companyUuid, connectionUuid, "idea", "idea-9", "crash");
    expect(mockPrisma.daemonExecution.updateMany.mock.calls[0][0].data).toEqual({
      status: INTERRUPTED_EXECUTION_STATUS,
      interruptedReason: "crash",
    });
  });

  it("returns false when no matching row exists (wake already ended)", async () => {
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 0 });
    const ok = await reportExecutionInterrupt(companyUuid, connectionUuid, "task", t1, "user");
    expect(ok).toBe(false);
  });
});

describe("resumeExecution", () => {
  it("transitions a user-interrupted row back to running and clears the reason", async () => {
    mockPrisma.daemonExecution.findFirst.mockResolvedValue({
      id: 7,
      status: "interrupted",
      interruptedReason: "user",
    });
    mockPrisma.daemonExecution.update.mockResolvedValue({});
    const res = await resumeExecution(companyUuid, connectionUuid, "task", t1);
    expect(res).toEqual({ ok: true });
    const arg = mockPrisma.daemonExecution.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 7 });
    expect(arg.data.status).toBe("running");
    expect(arg.data.interruptedReason).toBeNull();
    expect(arg.data.startedAt).toBeInstanceOf(Date);
  });

  it("rejects a crash-interrupted row as not-resumable (no update)", async () => {
    mockPrisma.daemonExecution.findFirst.mockResolvedValue({
      id: 8,
      status: "interrupted",
      interruptedReason: "crash",
    });
    const res = await resumeExecution(companyUuid, connectionUuid, "task", t1);
    expect(res).toMatchObject({ ok: false, reason: "not_resumable", interruptedReason: "crash" });
    expect(mockPrisma.daemonExecution.update).not.toHaveBeenCalled();
  });

  it("rejects a non-interrupted (running) row as not-resumable", async () => {
    mockPrisma.daemonExecution.findFirst.mockResolvedValue({
      id: 9,
      status: "running",
      interruptedReason: null,
    });
    const res = await resumeExecution(companyUuid, connectionUuid, "task", t1);
    expect(res).toMatchObject({ ok: false, reason: "not_resumable", status: "running" });
    expect(mockPrisma.daemonExecution.update).not.toHaveBeenCalled();
  });

  it("returns not_found when no row exists for the connection+entity", async () => {
    mockPrisma.daemonExecution.findFirst.mockResolvedValue(null);
    const res = await resumeExecution(companyUuid, connectionUuid, "task", t1);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("DISPLAYABLE_EXECUTION_STATUSES", () => {
  it("is the two active statuses plus the sticky interrupted status", () => {
    expect([...DISPLAYABLE_EXECUTION_STATUSES]).toEqual(["running", "queued", "interrupted"]);
  });
});

describe("reconcileSnapshot does not end an interrupted row (sticky)", () => {
  it("the absent-from-snapshot sweep only targets running/queued rows", async () => {
    // The sweep query filters status to the ACTIVE set — an interrupted row is never
    // selected for ending even though it is absent from the snapshot.
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.daemonExecution.upsert.mockResolvedValue({});
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, []);
    expect(mockPrisma.daemonExecution.findMany.mock.calls[0][0].where.status).toEqual({
      in: [...ACTIVE_EXECUTION_STATUSES],
    });
  });

  it("a re-dispatched (resumed) entity clears interruptedReason on upsert update", async () => {
    mockPrisma.daemonExecution.findMany.mockResolvedValue([]);
    mockPrisma.daemonExecution.upsert.mockResolvedValue({});
    const snap: SnapshotExecution[] = [
      { entityType: "task", entityUuid: t1, rootIdeaUuid: null, status: "running", startedAt: new Date() },
    ];
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, snap);
    expect(mockPrisma.daemonExecution.upsert.mock.calls[0][0].update.interruptedReason).toBeNull();
  });
});

// ===== isConnectionLive (resume gate) =====
describe("isConnectionLive", () => {
  it("true for an online connection seen within the staleness threshold", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "online",
      lastSeenAt: new Date(),
    });
    expect(await isConnectionLive(companyUuid, connectionUuid)).toBe(true);
  });

  it("false when the connection does not exist in-company", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    expect(await isConnectionLive(companyUuid, connectionUuid)).toBe(false);
  });

  it("false for a stale lastSeenAt even if status is online", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "online",
      lastSeenAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
    });
    expect(await isConnectionLive(companyUuid, connectionUuid)).toBe(false);
  });

  it("false when status is not online", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({
      status: "offline",
      lastSeenAt: new Date(),
    });
    expect(await isConnectionLive(companyUuid, connectionUuid)).toBe(false);
  });
});
