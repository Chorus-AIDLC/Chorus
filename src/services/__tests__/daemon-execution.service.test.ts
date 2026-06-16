import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonTaskExecution: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  daemonConnection: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  task: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  idea: {
    count: vi.fn(),
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

// The service now imports the EventBus (for publishExecutionChange). Mock it so
// the unit test does not pull the real event-bus → redis → logger.child() chain
// and can assert the publish emit shape directly.
const mockEventBus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

import {
  ACTIVE_EXECUTION_STATUSES,
  ENDED_EXECUTION_STATUS,
  STALE_THRESHOLD_MS,
  reconcileSnapshot,
  reconcileOffline,
  getVisibleExecutions,
  getExecutionsForConnection,
  connectionBelongsToAgent,
  connectionVisibleToCaller,
  listVisibleConnectionUuids,
  validateExecutionEntities,
  publishExecutionChange,
  executionEventName,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  // Default: updateMany reports 0 rows affected, upsert resolves a stub row.
  mockPrisma.daemonTaskExecution.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.daemonTaskExecution.upsert.mockResolvedValue({});
  mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
  mockPrisma.daemonConnection.count.mockResolvedValue(0);
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.task.count.mockResolvedValue(0);
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.idea.count.mockResolvedValue(0);
  mockPrisma.idea.findMany.mockResolvedValue([]);
});

// ===== Constants =====
describe("constants", () => {
  it("ACTIVE_EXECUTION_STATUSES are exactly running + queued", () => {
    expect(ACTIVE_EXECUTION_STATUSES).toEqual(["running", "queued"]);
  });

  it("ENDED_EXECUTION_STATUS is the single terminal value 'ended'", () => {
    expect(ENDED_EXECUTION_STATUS).toBe("ended");
  });

  it("re-exports the registry's STALE_THRESHOLD_MS (no second constant)", () => {
    // The offline rule reuses the connection registry's threshold rather than
    // defining an execution-specific one.
    expect(STALE_THRESHOLD_MS).toBe(90_000);
  });
});

// ===== reconcileSnapshot =====
describe("reconcileSnapshot", () => {
  it("ends running/queued rows absent from the snapshot, then upserts reported tasks", async () => {
    mockPrisma.daemonTaskExecution.updateMany.mockResolvedValue({ count: 1 });
    const executions: SnapshotExecution[] = [
      { taskUuid: t2, rootIdeaUuid: null, status: "running", startedAt: new Date() },
    ];

    const reconciled = await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);

    // The absent-row end is the first call.
    const endArg = mockPrisma.daemonTaskExecution.updateMany.mock.calls[0][0];
    expect(endArg.where).toEqual({
      companyUuid,
      connectionUuid,
      status: { in: ["running", "queued"] },
      taskUuid: { notIn: [t2] }, // only the reported task is spared
    });
    expect(endArg.data).toEqual({ status: "ended" });

    // Then each reported task is upserted on the (connectionUuid, taskUuid) key.
    expect(mockPrisma.daemonTaskExecution.upsert).toHaveBeenCalledTimes(1);
    const upArg = mockPrisma.daemonTaskExecution.upsert.mock.calls[0][0];
    expect(upArg.where).toEqual({
      connectionUuid_taskUuid: { connectionUuid, taskUuid: t2 },
    });
    expect(upArg.create.status).toBe("running");
    expect(upArg.create.companyUuid).toBe(companyUuid);
    expect(upArg.create.agentUuid).toBe(agentUuid);
    expect(upArg.update.status).toBe("running");
    // companyUuid/agentUuid re-affirmed from authenticated context on update.
    expect(upArg.update.companyUuid).toBe(companyUuid);
    expect(upArg.update.agentUuid).toBe(agentUuid);

    // Return value = ended count + reported count.
    expect(reconciled).toBe(1 + 1);
  });

  it("Scenario: a task absent from the new snapshot is ended while the reported one is upserted", async () => {
    // C had T1 running + T2 queued; new snapshot reports only T2 as running.
    // T1 (absent) must end; T2 must be upserted to running.
    mockPrisma.daemonTaskExecution.updateMany.mockResolvedValue({ count: 1 });
    const executions: SnapshotExecution[] = [{ taskUuid: t2, status: "running" }];

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);

    const endArg = mockPrisma.daemonTaskExecution.updateMany.mock.calls[0][0];
    // T1 is not in the snapshot's notIn-spared set, so it falls into the end query.
    expect(endArg.where.taskUuid).toEqual({ notIn: [t2] });
    expect(endArg.data.status).toBe("ended");

    const upArg = mockPrisma.daemonTaskExecution.upsert.mock.calls[0][0];
    expect(upArg.where.connectionUuid_taskUuid.taskUuid).toBe(t2);
    expect(upArg.update.status).toBe("running");
  });

  it("upserts every reported task on its (connectionUuid, taskUuid) unique key (at most one row per task)", async () => {
    const executions: SnapshotExecution[] = [
      { taskUuid: t1, status: "running", startedAt: new Date() },
      { taskUuid: t2, status: "queued" },
    ];

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);

    expect(mockPrisma.daemonTaskExecution.upsert).toHaveBeenCalledTimes(2);
    const keys = mockPrisma.daemonTaskExecution.upsert.mock.calls.map(
      (c) => c[0].where.connectionUuid_taskUuid,
    );
    expect(keys).toEqual([
      { connectionUuid, taskUuid: t1 },
      { connectionUuid, taskUuid: t2 },
    ]);
    // A queued row carries null startedAt; a running row carries its startedAt.
    const queuedUpsert = mockPrisma.daemonTaskExecution.upsert.mock.calls[1][0];
    expect(queuedUpsert.create.status).toBe("queued");
    expect(queuedUpsert.create.startedAt).toBeNull();
  });

  it("coerces missing rootIdeaUuid/startedAt to null (quick task with no root idea)", async () => {
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, [
      { taskUuid: t1, status: "queued" },
    ]);
    const upArg = mockPrisma.daemonTaskExecution.upsert.mock.calls[0][0];
    expect(upArg.create.rootIdeaUuid).toBeNull();
    expect(upArg.create.startedAt).toBeNull();
    expect(upArg.update.rootIdeaUuid).toBeNull();
  });

  it("an empty snapshot ends ALL of the connection's active rows (notIn: [])", async () => {
    mockPrisma.daemonTaskExecution.updateMany.mockResolvedValue({ count: 3 });
    const reconciled = await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, []);
    const endArg = mockPrisma.daemonTaskExecution.updateMany.mock.calls[0][0];
    expect(endArg.where.taskUuid).toEqual({ notIn: [] });
    expect(mockPrisma.daemonTaskExecution.upsert).not.toHaveBeenCalled();
    expect(reconciled).toBe(3);
  });

  it("is idempotent: re-applying the identical snapshot issues the same write shape", async () => {
    // The reconcile is deterministic in its query shape — the same snapshot
    // produces the same end-query (same notIn set) and the same upserts, so the
    // persisted running/queued set is unchanged on the second apply.
    const executions: SnapshotExecution[] = [
      { taskUuid: t1, status: "running", startedAt: new Date("2026-06-15T03:00:00Z") },
      { taskUuid: t2, status: "queued" },
    ];

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);
    const firstEnd = mockPrisma.daemonTaskExecution.updateMany.mock.calls[0][0];
    const firstUpserts = mockPrisma.daemonTaskExecution.upsert.mock.calls.map((c) => c[0]);

    vi.clearAllMocks();
    mockPrisma.daemonTaskExecution.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.daemonTaskExecution.upsert.mockResolvedValue({});

    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, executions);
    const secondEnd = mockPrisma.daemonTaskExecution.updateMany.mock.calls[0][0];
    const secondUpserts = mockPrisma.daemonTaskExecution.upsert.mock.calls.map((c) => c[0]);

    expect(secondEnd).toEqual(firstEnd);
    expect(secondUpserts).toEqual(firstUpserts);
    // Second apply: the same statuses are written, so the active set is unchanged.
    expect(secondUpserts.map((u) => u.update.status)).toEqual(["running", "queued"]);
  });

  it("never writes the 'ended' status on an upsert — ended is only ever set by reconcile", async () => {
    await reconcileSnapshot(companyUuid, agentUuid, connectionUuid, [
      { taskUuid: t1, status: "running" },
    ]);
    const upArg = mockPrisma.daemonTaskExecution.upsert.mock.calls[0][0];
    expect(upArg.create.status).not.toBe("ended");
    expect(upArg.update.status).not.toBe("ended");
  });
});

// ===== reconcileOffline =====
describe("reconcileOffline", () => {
  it("transitions the connection's running/queued rows to ended (retained, not deleted), companyUuid-scoped", async () => {
    mockPrisma.daemonTaskExecution.updateMany.mockResolvedValue({ count: 2 });

    const count = await reconcileOffline(companyUuid, connectionUuid);

    expect(mockPrisma.daemonTaskExecution.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonTaskExecution.updateMany.mock.calls[0][0];
    // Only active rows for this connection in this company are touched.
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
    mockPrisma.daemonTaskExecution.updateMany.mockRejectedValue(new Error("db down"));
    const count = await reconcileOffline(companyUuid, connectionUuid);
    expect(count).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== getVisibleExecutions (visibility scoping) =====
describe("getVisibleExecutions", () => {
  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      uuid: "exec-1",
      agentUuid,
      connectionUuid,
      taskUuid: t1,
      rootIdeaUuid: null,
      status: "running",
      startedAt: new Date("2026-06-15T03:00:00.000Z"),
      createdAt: new Date("2026-06-15T03:00:00.000Z"),
      updatedAt: new Date("2026-06-15T03:30:00.000Z"),
      ...overrides,
    };
  }

  // By default the rows' connection is effectively ONLINE (fresh heartbeat) so
  // the read-time staleness gate keeps them. Staleness/offline is exercised in
  // dedicated tests below. Date.now() (not faked here) drives the freshness check.
  beforeEach(() => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
  });

  it("USER caller: owner-scoped via agent.ownerUuid, companyUuid-scoped, active only", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);
    // Enrichment: the row's task resolves to a title + project.
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: t1, title: "Build the thing", projectUuid: "proj-1" },
    ]);

    const result = await getVisibleExecutions({
      type: "user",
      companyUuid,
      actorUuid: ownerUuid,
    });

    expect(mockPrisma.daemonTaskExecution.findMany.mock.calls[0][0]).toEqual({
      where: {
        companyUuid,
        status: { in: ["running", "queued"] },
        agent: { ownerUuid },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      uuid: "exec-1",
      agentUuid,
      connectionUuid,
      taskUuid: t1,
      rootIdeaUuid: null,
      status: "running",
      startedAt: "2026-06-15T03:00:00.000Z",
      createdAt: "2026-06-15T03:00:00.000Z",
      updatedAt: "2026-06-15T03:30:00.000Z",
      taskTitle: "Build the thing",
      projectUuid: "proj-1",
      rootIdeaTitle: null,
    });
  });

  it("enriches rows with task title/project + root-idea title (batched), null when an entity does not resolve", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "with-idea", taskUuid: t1, rootIdeaUuid: "idea-1" }),
      makeRow({ uuid: "no-task", taskUuid: t2, rootIdeaUuid: null, updatedAt: new Date("2026-06-15T02:00:00Z") }),
    ]);
    // Only t1 resolves; t2 is a deleted task → falls back to null.
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: t1, title: "Task One", projectUuid: "proj-9" },
    ]);
    mockPrisma.idea.findMany.mockResolvedValue([{ uuid: "idea-1", title: "Root Idea" }]);

    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });

    // Task lookup is batched + companyUuid-scoped over the distinct task uuids.
    const taskArg = mockPrisma.task.findMany.mock.calls[0][0];
    expect(taskArg.where.companyUuid).toBe(companyUuid);
    expect(taskArg.where.uuid.in.slice().sort()).toEqual([t1, t2].sort());
    // Idea lookup is batched over distinct non-null root-idea uuids.
    expect(mockPrisma.idea.findMany.mock.calls[0][0].where).toEqual({
      companyUuid,
      uuid: { in: ["idea-1"] },
    });

    const withIdea = result.find((r) => r.uuid === "with-idea")!;
    expect(withIdea.taskTitle).toBe("Task One");
    expect(withIdea.projectUuid).toBe("proj-9");
    expect(withIdea.rootIdeaTitle).toBe("Root Idea");
    const noTask = result.find((r) => r.uuid === "no-task")!;
    expect(noTask.taskTitle).toBeNull();
    expect(noTask.projectUuid).toBeNull();
    expect(noTask.rootIdeaTitle).toBeNull();
  });

  it("super_admin caller is owner-scoped too (only the agent relation, not the company at large)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
    await getVisibleExecutions({ type: "super_admin", companyUuid, actorUuid: ownerUuid });
    const arg = mockPrisma.daemonTaskExecution.findMany.mock.calls[0][0];
    expect(arg.where.agent).toEqual({ ownerUuid });
    expect(arg.where.agentUuid).toBeUndefined();
  });

  it("AGENT-KEY caller: self-scoped via agentUuid (not the owner relation), companyUuid-scoped", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);

    await getVisibleExecutions({ type: "agent", companyUuid, actorUuid: agentUuid });

    expect(mockPrisma.daemonTaskExecution.findMany.mock.calls[0][0]).toEqual({
      where: {
        companyUuid,
        status: { in: ["running", "queued"] },
        agentUuid,
      },
    });
  });

  it("the where clause always carries the caller's companyUuid (visibility never crosses companies)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
    await getVisibleExecutions({ type: "user", companyUuid: otherCompanyUuid, actorUuid: ownerUuid });
    const arg = mockPrisma.daemonTaskExecution.findMany.mock.calls[0][0];
    expect(arg.where.companyUuid).toBe(otherCompanyUuid);
  });

  it("returns an empty array when there are genuinely no rows", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
    await expect(
      getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid }),
    ).resolves.toEqual([]);
  });

  it("PROPAGATES a query error (does NOT swallow to [] like the write functions)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid }),
    ).rejects.toThrow("db down");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("sorts running-first then updatedAt desc", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "queued-new", status: "queued", updatedAt: new Date("2026-06-15T05:00:00Z") }),
      makeRow({ uuid: "running-old", status: "running", updatedAt: new Date("2026-06-15T03:00:00Z") }),
      makeRow({ uuid: "running-new", status: "running", updatedAt: new Date("2026-06-15T04:00:00Z") }),
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result.map((r) => r.uuid)).toEqual(["running-new", "running-old", "queued-new"]);
  });

  // ===== Read-time staleness gate (offline rule, no clean abort) =====

  it("EXCLUDES rows whose connection is stale (lastSeenAt older than STALE_THRESHOLD_MS) even if the row says running", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);
    // Connection's last heartbeat is just past the staleness window → offline.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      {
        uuid: connectionUuid,
        status: "online",
        lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 5_000)),
      },
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result).toEqual([]);
  });

  it("EXCLUDES rows whose connection status is offline (clean disconnect), regardless of lastSeenAt", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "offline", lastSeenAt: new Date() },
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result).toEqual([]);
  });

  it("EXCLUDES rows whose connection no longer exists (deleted connection cannot be online)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]); // connection gone
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result).toEqual([]);
  });

  it("KEEPS rows of a live connection and DROPS rows of a stale sibling in the same read (mixed)", async () => {
    const liveConn = "conn-live";
    const staleConn = "conn-stale";
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([
      makeRow({ uuid: "live-row", connectionUuid: liveConn }),
      makeRow({ uuid: "stale-row", connectionUuid: staleConn }),
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: liveConn, status: "online", lastSeenAt: new Date() },
      { uuid: staleConn, status: "online", lastSeenAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 1)) },
    ]);
    const result = await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(result.map((r) => r.uuid)).toEqual(["live-row"]);
    // The staleness lookup is companyUuid-scoped over the distinct connection uuids.
    const connArg = mockPrisma.daemonConnection.findMany.mock.calls[0][0];
    expect(connArg.where.companyUuid).toBe(companyUuid);
    expect(connArg.where.uuid.in.slice().sort()).toEqual([liveConn, staleConn].sort());
  });

  it("does NOT query connections when there are no active rows (cheap empty path)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
    await getVisibleExecutions({ type: "user", companyUuid, actorUuid: ownerUuid });
    expect(mockPrisma.daemonConnection.findMany).not.toHaveBeenCalled();
  });
});

// ===== getExecutionsForConnection =====
describe("getExecutionsForConnection", () => {
  it("filters by companyUuid + connectionUuid + active status", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
    await getExecutionsForConnection(companyUuid, connectionUuid);
    expect(mockPrisma.daemonTaskExecution.findMany.mock.calls[0][0]).toEqual({
      where: {
        companyUuid,
        connectionUuid,
        status: { in: ["running", "queued"] },
      },
    });
  });

  it("PROPAGATES a query error (read path surfaces the error)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockRejectedValue(new Error("db down"));
    await expect(getExecutionsForConnection(companyUuid, connectionUuid)).rejects.toThrow("db down");
  });

  function makeRow() {
    return {
      uuid: "exec-1", agentUuid, connectionUuid, taskUuid: t1, rootIdeaUuid: null,
      status: "running", startedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    };
  }

  it("returns the active rows when the connection is effectively ONLINE (fresh heartbeat)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: t1, title: "T1", projectUuid: "p1" }]);
    const result = await getExecutionsForConnection(companyUuid, connectionUuid);
    expect(result.map((r) => r.uuid)).toEqual(["exec-1"]);
  });

  it("returns an EMPTY active set when the connection is stale/offline (offline rule, no clean abort)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([makeRow()]);
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
    await expect(
      connectionBelongsToAgent(companyUuid, agentUuid, connectionUuid),
    ).resolves.toBe(false);
  });

  it("PROPAGATES a query error (fence is a read, does not swallow to 'not found')", async () => {
    mockPrisma.daemonConnection.count.mockRejectedValue(new Error("db down"));
    await expect(
      connectionBelongsToAgent(companyUuid, agentUuid, connectionUuid),
    ).rejects.toThrow("db down");
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
    await connectionVisibleToCaller(
      { type: "user", companyUuid, actorUuid: ownerUuid },
      connectionUuid,
    );
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
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: "c1" },
      { uuid: "c2" },
    ]);
    const result = await listVisibleConnectionUuids({
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
    });
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

// ===== validateExecutionEntities (multi-tenancy body fence) =====
describe("validateExecutionEntities", () => {
  it("an empty snapshot is trivially valid and touches no count query", async () => {
    await expect(validateExecutionEntities(companyUuid, [])).resolves.toBe(true);
    expect(mockPrisma.task.count).not.toHaveBeenCalled();
    expect(mockPrisma.idea.count).not.toHaveBeenCalled();
  });

  it("validates distinct task uuids against the company (dedup)", async () => {
    // t1 appears twice; the count query must use the deduplicated set.
    mockPrisma.task.count.mockResolvedValue(2);
    const ok = await validateExecutionEntities(companyUuid, [
      { taskUuid: t1, status: "running" },
      { taskUuid: t1, status: "running" },
      { taskUuid: t2, status: "queued" },
    ]);
    const arg = mockPrisma.task.count.mock.calls[0][0];
    expect(arg.where.companyUuid).toBe(companyUuid);
    expect(arg.where.uuid.in.slice().sort()).toEqual([t1, t2].sort());
    expect(arg.where.uuid.in).toHaveLength(2);
    expect(ok).toBe(true);
  });

  it("rejects when a task uuid does not resolve in the company", async () => {
    mockPrisma.task.count.mockResolvedValue(1); // only 1 of 2 found
    const ok = await validateExecutionEntities(companyUuid, [
      { taskUuid: t1, status: "running" },
      { taskUuid: t2, status: "queued" },
    ]);
    expect(ok).toBe(false);
  });

  it("validates non-null root-idea uuids against the company too", async () => {
    mockPrisma.task.count.mockResolvedValue(1);
    mockPrisma.idea.count.mockResolvedValue(1);
    const ok = await validateExecutionEntities(companyUuid, [
      { taskUuid: t1, rootIdeaUuid: "idea-1", status: "running" },
    ]);
    expect(mockPrisma.idea.count.mock.calls[0][0]).toEqual({
      where: { companyUuid, uuid: { in: ["idea-1"] } },
    });
    expect(ok).toBe(true);
  });

  it("ignores null root-idea uuids (a quick task) — no idea count query", async () => {
    mockPrisma.task.count.mockResolvedValue(1);
    const ok = await validateExecutionEntities(companyUuid, [
      { taskUuid: t1, rootIdeaUuid: null, status: "queued" },
    ]);
    expect(mockPrisma.idea.count).not.toHaveBeenCalled();
    expect(ok).toBe(true);
  });

  it("rejects when a root-idea uuid does not resolve in the company", async () => {
    mockPrisma.task.count.mockResolvedValue(1);
    mockPrisma.idea.count.mockResolvedValue(0); // idea not found
    const ok = await validateExecutionEntities(companyUuid, [
      { taskUuid: t1, rootIdeaUuid: "idea-x", status: "running" },
    ]);
    expect(ok).toBe(false);
  });
});

// ===== publishExecutionChange (SSE event publish) =====
describe("publishExecutionChange", () => {
  it("emits execution:{connectionUuid} carrying the current active set + companyUuid", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([
      {
        uuid: "exec-1",
        agentUuid,
        connectionUuid,
        taskUuid: t1,
        rootIdeaUuid: null,
        status: "running",
        startedAt: new Date("2026-06-15T03:00:00.000Z"),
        createdAt: new Date("2026-06-15T03:00:00.000Z"),
        updatedAt: new Date("2026-06-15T03:00:00.000Z"),
      },
    ]);
    // The connection is live so the row survives the read-time staleness gate.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);

    await publishExecutionChange(companyUuid, connectionUuid);

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockEventBus.emit.mock.calls[0];
    expect(eventName).toBe(`execution:${connectionUuid}`);
    expect(eventName).toBe(executionEventName(connectionUuid));
    expect(payload.companyUuid).toBe(companyUuid);
    expect(payload.connectionUuid).toBe(connectionUuid);
    expect(payload.executions).toHaveLength(1);
    expect(payload.executions[0].taskUuid).toBe(t1);
  });

  it("emits an empty active set on the offline path (re-reads post-reconcile state)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockResolvedValue([]);
    await publishExecutionChange(companyUuid, connectionUuid);
    const [, payload] = mockEventBus.emit.mock.calls[0];
    expect(payload.executions).toEqual([]);
  });

  it("swallows + logs a read failure and does NOT emit (never throws into teardown)", async () => {
    mockPrisma.daemonTaskExecution.findMany.mockRejectedValue(new Error("db down"));
    await expect(publishExecutionChange(companyUuid, connectionUuid)).resolves.toBeUndefined();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});
