import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  agentSession: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  sessionTaskCheckin: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    groupBy: vi.fn(),
  },
  task: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  agent: {
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/event-bus", () => ({
  eventBus: { emitChange: vi.fn() },
}));

vi.mock("@/services/task.service", () => ({
  claimTask: vi.fn(),
}));

import {
  createSession,
  getSession,
  closeSession,
  reopenSession,
  sessionCheckinToTask,
  sessionCheckoutFromTask,
  heartbeatSession,
  batchGetWorkerCountsForTasks,
  getSessionName,
  listAgentSessions,
  listAgentSessionsForUI,
  SESSION_STALE_THRESHOLD_MS,
} from "@/services/session.service";
import { eventBus } from "@/lib/event-bus";
import { claimTask } from "@/services/task.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const sessionUuid = "session-0000-0000-0000-000000000001";
const taskUuid = "task-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    uuid: sessionUuid,
    companyUuid,
    agentUuid,
    name: "test-session",
    description: null,
    status: "active",
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default for touchLastActiveAt's status precheck — most tests operate on
  // active sessions and expect the lastActiveAt write to fire.
  mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });
});

// ===== createSession =====
describe("createSession", () => {
  it("should create a session and return formatted response", async () => {
    const session = makeSession();
    mockPrisma.agentSession.create.mockResolvedValue(session);

    const result = await createSession({
      companyUuid,
      agentUuid,
      name: "test-session",
    });

    expect(result.uuid).toBe(sessionUuid);
    expect(result.agentUuid).toBe(agentUuid);
    expect(result.name).toBe("test-session");
    expect(result.status).toBe("active");
    expect(result.checkins).toEqual([]);
    expect(result.lastActiveAt).toBe(now.toISOString());
    expect(mockPrisma.agentSession.create).toHaveBeenCalledOnce();
  });

  it("should pass description when provided", async () => {
    const session = makeSession({ description: "desc" });
    mockPrisma.agentSession.create.mockResolvedValue(session);

    await createSession({
      companyUuid,
      agentUuid,
      name: "test-session",
      description: "desc",
    });

    expect(mockPrisma.agentSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: "desc",
        }),
      })
    );
  });
});

// ===== getSession =====
describe("getSession", () => {
  it("should return formatted session with checkins", async () => {
    const session = makeSession({
      taskCheckins: [
        { taskUuid, checkinAt: now, checkoutAt: null },
      ],
    });
    mockPrisma.agentSession.findFirst.mockResolvedValue(session);

    const result = await getSession(companyUuid, sessionUuid);
    expect(result).not.toBeNull();
    expect(result!.checkins).toHaveLength(1);
    expect(result!.checkins[0].taskUuid).toBe(taskUuid);
    expect(result!.checkins[0].checkoutAt).toBeNull();
  });

  it("should return null when session not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    const result = await getSession(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== closeSession =====
describe("closeSession", () => {
  it("should close session and batch checkout active checkins", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      { task: { uuid: taskUuid, projectUuid } },
    ]);
    mockPrisma.sessionTaskCheckin.updateMany.mockResolvedValue({ count: 1 });
    const closedSession = makeSession({
      status: "closed",
      taskCheckins: [{ taskUuid, checkinAt: now, checkoutAt: now }],
    });
    mockPrisma.agentSession.update.mockResolvedValue(closedSession);

    const result = await closeSession(companyUuid, sessionUuid);

    expect(result.status).toBe("closed");
    expect(mockPrisma.sessionTaskCheckin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionUuid, checkoutAt: null },
      })
    );
    expect(eventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityUuid: taskUuid, action: "updated" })
    );
  });

  it("should throw when session not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    await expect(closeSession(companyUuid, "missing")).rejects.toThrow("Session not found");
  });
});

// ===== reopenSession =====
describe("reopenSession", () => {
  it("should reopen a closed session", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ status: "closed" }));
    const reopened = makeSession({ status: "active", taskCheckins: [] });
    mockPrisma.agentSession.update.mockResolvedValue(reopened);
    mockPrisma.agentSession.findUniqueOrThrow.mockResolvedValue(reopened);

    const result = await reopenSession(companyUuid, sessionUuid);
    expect(result.status).toBe("active");
    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "active" }),
      })
    );
  });

  it("should throw when session not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    await expect(reopenSession(companyUuid, "missing")).rejects.toThrow("Session not found");
  });

  it("should throw when session is not closed", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ status: "active" }));
    await expect(reopenSession(companyUuid, sessionUuid)).rejects.toThrow("Only closed sessions can be reopened");
  });
});

// ===== sessionCheckinToTask =====
describe("sessionCheckinToTask", () => {
  it("should checkin to a task and return checkin info", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.task.findFirst.mockResolvedValue({
      uuid: taskUuid,
      companyUuid,
      projectUuid,
      assigneeUuid: agentUuid,
    });
    mockPrisma.sessionTaskCheckin.upsert.mockResolvedValue({
      taskUuid,
      checkinAt: now,
      checkoutAt: null,
    });
    mockPrisma.agentSession.update.mockResolvedValue(makeSession());

    const result = await sessionCheckinToTask(companyUuid, sessionUuid, taskUuid);

    expect(result.taskUuid).toBe(taskUuid);
    expect(result.checkoutAt).toBeNull();
    expect(eventBus.emitChange).toHaveBeenCalled();
  });

  it("should auto-claim unassigned task", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.task.findFirst.mockResolvedValue({
      uuid: taskUuid,
      companyUuid,
      projectUuid,
      assigneeUuid: null,
    });
    mockPrisma.sessionTaskCheckin.upsert.mockResolvedValue({
      taskUuid,
      checkinAt: now,
      checkoutAt: null,
    });
    mockPrisma.agentSession.update.mockResolvedValue(makeSession());

    await sessionCheckinToTask(companyUuid, sessionUuid, taskUuid);

    expect(claimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskUuid,
        assigneeType: "agent",
        assigneeUuid: agentUuid,
      })
    );
  });

  it("should throw when session not found or not active", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    await expect(
      sessionCheckinToTask(companyUuid, sessionUuid, taskUuid)
    ).rejects.toThrow("Session not found or not active");
  });

  it("should throw when task not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.task.findFirst.mockResolvedValue(null);
    await expect(
      sessionCheckinToTask(companyUuid, sessionUuid, taskUuid)
    ).rejects.toThrow("Task not found");
  });
});

// ===== sessionCheckoutFromTask =====
describe("sessionCheckoutFromTask", () => {
  it("should checkout from task and emit event", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });
    mockPrisma.sessionTaskCheckin.updateMany.mockResolvedValue({ count: 1 });

    await sessionCheckoutFromTask(companyUuid, sessionUuid, taskUuid);

    expect(mockPrisma.sessionTaskCheckin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionUuid, taskUuid, checkoutAt: null },
      })
    );
    expect(eventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityUuid: taskUuid })
    );
  });

  it("should throw when session not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    await expect(
      sessionCheckoutFromTask(companyUuid, sessionUuid, taskUuid)
    ).rejects.toThrow("Session not found");
  });

  it("should not emit event when task not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.task.findFirst.mockResolvedValue(null);
    mockPrisma.sessionTaskCheckin.updateMany.mockResolvedValue({ count: 0 });

    await sessionCheckoutFromTask(companyUuid, sessionUuid, taskUuid);
    expect(eventBus.emitChange).not.toHaveBeenCalled();
  });
});

// ===== heartbeatSession =====
describe("heartbeatSession", () => {
  it("should update lastActiveAt", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.agentSession.update.mockResolvedValue(makeSession());

    await heartbeatSession(companyUuid, sessionUuid);

    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: sessionUuid },
        data: expect.objectContaining({ lastActiveAt: expect.any(Date) }),
      })
    );
  });

  it("should throw when session not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    await expect(heartbeatSession(companyUuid, "missing")).rejects.toThrow("Session not found");
  });
});

// ===== batchGetWorkerCountsForTasks =====
describe("batchGetWorkerCountsForTasks", () => {
  it("should return empty object for empty input", async () => {
    const result = await batchGetWorkerCountsForTasks(companyUuid, []);
    expect(result).toEqual({});
  });

  it("should return worker counts grouped by task", async () => {
    const task2 = "task-0000-0000-0000-000000000002";
    mockPrisma.sessionTaskCheckin.groupBy.mockResolvedValue([
      { taskUuid, _count: { taskUuid: 2 } },
      { taskUuid: task2, _count: { taskUuid: 1 } },
    ]);

    const result = await batchGetWorkerCountsForTasks(companyUuid, [taskUuid, task2]);
    expect(result[taskUuid]).toBe(2);
    expect(result[task2]).toBe(1);
  });
});

// ===== getSessionName =====
describe("getSessionName", () => {
  it("should return session name", async () => {
    mockPrisma.agentSession.findUnique.mockResolvedValue({ name: "my-session" });
    const name = await getSessionName(sessionUuid);
    expect(name).toBe("my-session");
  });

  it("should return null when session not found", async () => {
    mockPrisma.agentSession.findUnique.mockResolvedValue(null);
    const name = await getSessionName("missing");
    expect(name).toBeNull();
  });
});

// ===== getSessionsForTask =====
describe("getSessionsForTask", () => {
  it("should return active sessions for a task", async () => {
    const { getSessionsForTask } = await import("@/services/session.service");

    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      {
        taskUuid,
        checkinAt: now,
        session: {
          uuid: sessionUuid,
          name: "worker-1",
          agentUuid,
          agent: { name: "Agent 1" },
        },
      },
    ]);

    const result = await getSessionsForTask(companyUuid, taskUuid);

    expect(result).toHaveLength(1);
    expect(result[0].sessionUuid).toBe(sessionUuid);
    expect(result[0].sessionName).toBe("worker-1");
    expect(result[0].agentUuid).toBe(agentUuid);
    expect(result[0].agentName).toBe("Agent 1");
  });

  it("should return empty array when no active sessions", async () => {
    const { getSessionsForTask } = await import("@/services/session.service");
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([]);

    const result = await getSessionsForTask(companyUuid, taskUuid);
    expect(result).toEqual([]);
  });
});

// ===== listAgentSessions =====
describe("listAgentSessions", () => {
  it("should list all sessions for an agent", async () => {
    const { listAgentSessions } = await import("@/services/session.service");

    mockPrisma.agentSession.findMany.mockResolvedValue([
      makeSession({ uuid: "s1", name: "session-1", taskCheckins: [] }),
      makeSession({ uuid: "s2", name: "session-2", taskCheckins: [] }),
    ]);

    const result = await listAgentSessions(companyUuid, agentUuid);

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe("s1");
    expect(result[1].uuid).toBe("s2");
  });

  it("should filter by status when provided", async () => {
    const { listAgentSessions } = await import("@/services/session.service");
    mockPrisma.agentSession.findMany.mockResolvedValue([
      makeSession({ status: "closed", taskCheckins: [] }),
    ]);

    await listAgentSessions(companyUuid, agentUuid, "closed");

    expect(mockPrisma.agentSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "closed" }),
      })
    );
  });
});

// ===== getActiveSessionsForProject =====
describe("getActiveSessionsForProject", () => {
  it("should return session-based workers (deduplicated by session)", async () => {
    const { getActiveSessionsForProject } = await import("@/services/session.service");

    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      {
        taskUuid: "t1",
        checkinAt: now,
        session: {
          uuid: "s1",
          name: "worker-1",
          agentUuid: "a1",
          agent: { name: "Agent 1" },
        },
      },
      {
        taskUuid: "t2",
        checkinAt: now,
        session: {
          uuid: "s1", // same session, should deduplicate
          name: "worker-1",
          agentUuid: "a1",
          agent: { name: "Agent 1" },
        },
      },
      {
        taskUuid: "t3",
        checkinAt: now,
        session: {
          uuid: "s2",
          name: "worker-2",
          agentUuid: "a2",
          agent: { name: "Agent 2" },
        },
      },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getActiveSessionsForProject(companyUuid, projectUuid);

    expect(result).toHaveLength(2); // deduplicated
    expect(result[0].sessionUuid).toBe("s1");
    expect(result[1].sessionUuid).toBe("s2");
  });

  it("should limit to 7 workers total", async () => {
    const { getActiveSessionsForProject } = await import("@/services/session.service");

    // Create 10 unique session checkins
    const checkins = Array.from({ length: 10 }, (_, i) => ({
      taskUuid: `t${i}`,
      checkinAt: now,
      session: {
        uuid: `s${i}`,
        name: `worker-${i}`,
        agentUuid: `a${i}`,
        agent: { name: `Agent ${i}` },
      },
    }));

    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue(checkins);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getActiveSessionsForProject(companyUuid, projectUuid);

    expect(result).toHaveLength(7); // max 7 workers
  });

  it("should include sessionless workers (agents with in_progress tasks without session)", async () => {
    const { getActiveSessionsForProject } = await import("@/services/session.service");

    // 2 session-based workers
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      {
        taskUuid: "t1",
        checkinAt: now,
        session: {
          uuid: "s1",
          name: "worker-1",
          agentUuid: "a1",
          agent: { name: "Agent 1" },
        },
      },
    ]);

    // 2 sessionless workers (in_progress tasks without session checkins)
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "t2", assigneeUuid: "a2", updatedAt: now },
      { uuid: "t3", assigneeUuid: "a3", updatedAt: now },
    ]);

    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "a2", name: "Agent 2" },
      { uuid: "a3", name: "Agent 3" },
    ]);

    const result = await getActiveSessionsForProject(companyUuid, projectUuid);

    expect(result).toHaveLength(3); // 1 session + 2 sessionless
    expect(result[0].sessionUuid).toBe("s1");
    expect(result[1].sessionUuid).toBe(""); // sessionless
    expect(result[1].agentUuid).toBe("a2");
    expect(result[2].sessionUuid).toBe("");
    expect(result[2].agentUuid).toBe("a3");
  });

  it("should deduplicate sessionless workers by agent UUID", async () => {
    const { getActiveSessionsForProject } = await import("@/services/session.service");

    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([]);

    // Same agent working on multiple tasks directly (no session)
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "t1", assigneeUuid: "a1", updatedAt: now },
      { uuid: "t2", assigneeUuid: "a1", updatedAt: now },
      { uuid: "t3", assigneeUuid: "a2", updatedAt: now },
    ]);

    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "a1", name: "Agent 1" },
      { uuid: "a2", name: "Agent 2" },
    ]);

    const result = await getActiveSessionsForProject(companyUuid, projectUuid);

    expect(result).toHaveLength(2); // deduplicated by agent
    expect(result[0].agentUuid).toBe("a1");
    expect(result[1].agentUuid).toBe("a2");
  });

  it("should exclude tasks with active session checkins from sessionless query", async () => {
    const { getActiveSessionsForProject } = await import("@/services/session.service");

    // t1 has active session checkin
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      {
        taskUuid: "t1",
        checkinAt: now,
        session: {
          uuid: "s1",
          name: "worker-1",
          agentUuid: "a1",
          agent: { name: "Agent 1" },
        },
      },
    ]);

    // Agent is also assigned to t1, but should be excluded from sessionless query
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getActiveSessionsForProject(companyUuid, projectUuid);

    expect(result).toHaveLength(1);
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          uuid: { notIn: ["t1"] }, // t1 excluded
        }),
      })
    );
  });

  it("should handle sessionless workers with missing agent names", async () => {
    const { getActiveSessionsForProject } = await import("@/services/session.service");

    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "t1", assigneeUuid: "a-unknown", updatedAt: now },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([]); // no matching agent

    const result = await getActiveSessionsForProject(companyUuid, projectUuid);

    expect(result).toHaveLength(0); // skipped due to missing agent name
  });
});

// ===== Staleness filter contract =====
describe("staleness filter (1h cutoff)", () => {
  it("SESSION_STALE_THRESHOLD_MS is exactly 1 hour", () => {
    expect(SESSION_STALE_THRESHOLD_MS).toBe(60 * 60 * 1000);
  });

  it("listAgentSessionsForUI applies status='active' AND lastActiveAt > now - 1h filter", async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([]);

    await listAgentSessionsForUI(companyUuid, agentUuid);

    const call = mockPrisma.agentSession.findMany.mock.calls[0]?.[0];
    expect(call.where.companyUuid).toBe(companyUuid);
    expect(call.where.agentUuid).toBe(agentUuid);
    expect(call.where.status).toBe("active");
    expect(call.where.lastActiveAt).toBeDefined();
    expect(call.where.lastActiveAt.gt).toBeInstanceOf(Date);
    // Lower-bound timestamp must be ~ now - 1h (within a small wall-clock margin)
    const cutoff = (call.where.lastActiveAt.gt as Date).getTime();
    const expected = Date.now() - SESSION_STALE_THRESHOLD_MS;
    expect(Math.abs(cutoff - expected)).toBeLessThan(2_000);
  });

  it("listAgentSessions does NOT apply the staleness filter (MCP-facing audit-trail path)", async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([]);

    await listAgentSessions(companyUuid, agentUuid);

    const call = mockPrisma.agentSession.findMany.mock.calls[0]?.[0];
    // lastActiveAt is intentionally absent so the caller sees every row regardless of age.
    expect(call.where.lastActiveAt).toBeUndefined();
    // status filter is also absent unless explicitly passed.
    expect(call.where.status).toBeUndefined();
  });

  it("getActiveSessionsForProject uses the freshSessionWhereClause shape on the session join", async () => {
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const { getActiveSessionsForProject } = await import("@/services/session.service");
    await getActiveSessionsForProject(companyUuid, projectUuid);

    const call = mockPrisma.sessionTaskCheckin.findMany.mock.calls[0]?.[0];
    expect(call.where.session.status).toBe("active");
    expect(call.where.session.lastActiveAt.gt).toBeInstanceOf(Date);
  });

  it("batchGetWorkerCountsForTasks uses the freshSessionWhereClause shape on the session join", async () => {
    mockPrisma.sessionTaskCheckin.groupBy.mockResolvedValue([]);

    await batchGetWorkerCountsForTasks(companyUuid, [taskUuid]);

    const call = mockPrisma.sessionTaskCheckin.groupBy.mock.calls[0]?.[0];
    expect(call.where.session.status).toBe("active");
    expect(call.where.session.lastActiveAt.gt).toBeInstanceOf(Date);
  });

  it("getSession (MCP/audit-trail path) does NOT filter on lastActiveAt — a 4h-stale session is still returned", async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(
      makeSession({ lastActiveAt: fourHoursAgo, taskCheckins: [] }),
    );

    const result = await getSession(companyUuid, sessionUuid);

    expect(result).not.toBeNull();
    // The where clause used must NOT carry lastActiveAt
    const call = mockPrisma.agentSession.findFirst.mock.calls[0]?.[0];
    expect(call.where.lastActiveAt).toBeUndefined();
  });

  it("getSessionName resolves a 24h-stale session name (Activity-stream contract)", async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockPrisma.agentSession.findUnique.mockResolvedValueOnce({ name: "old-session" });
    // Note: getSessionName doesn't actually read lastActiveAt; we only assert
    // that no filter is added that would drop a stale row.
    void dayAgo;

    const result = await getSessionName(sessionUuid);

    expect(result).toBe("old-session");
    const call = mockPrisma.agentSession.findUnique.mock.calls[0]?.[0];
    expect(call.where.lastActiveAt).toBeUndefined();
  });
});

// ===== Heartbeat side-effect contract =====
//
// Each session-touching service function must refresh `lastActiveAt = now()`
// on its successful path via `touchLastActiveAt`. The helper checks the row
// status first and skips the write when status='closed'. We exercise that
// contract via the indirect signature: `prisma.agentSession.update` is called
// with `data.lastActiveAt` set to a Date strictly after the original
// `lastActiveAt`. Tests intentionally use the wall-clock side-effect rather
// than spying on the helper because the helper is module-private.

describe("heartbeat side-effect (lastActiveAt refresh on session-touching tools)", () => {
  // Capture every prisma.agentSession.update call so we can scan all of them
  // for the heartbeat write — services may issue multiple updates (e.g.
  // closeSession also flips status), so we look for ANY update whose data
  // contains a fresh `lastActiveAt`.
  const expectHeartbeatCall = (priorActiveAt: Date) => {
    const calls = mockPrisma.agentSession.update.mock.calls.map(
      (c) => c[0] as { data?: { lastActiveAt?: Date } },
    );
    const hasFreshTouch = calls.some(
      (c) =>
        c.data?.lastActiveAt instanceof Date &&
        c.data.lastActiveAt.getTime() > priorActiveAt.getTime(),
    );
    expect(hasFreshTouch).toBe(true);
  };

  it("getSession refreshes lastActiveAt on success and the returned snapshot reflects the touch", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    mockPrisma.agentSession.findFirst.mockResolvedValue(
      makeSession({ lastActiveAt: old, taskCheckins: [] }),
    );
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });

    const result = await getSession(companyUuid, sessionUuid);
    expectHeartbeatCall(old);
    // The returned snapshot must carry the post-touch timestamp so a UI
    // rendering result.lastActiveAt is not off-by-one heartbeat.
    expect(result).not.toBeNull();
    expect(new Date(result!.lastActiveAt).getTime()).toBeGreaterThan(old.getTime());
  });

  it("getSession does NOT touch lastActiveAt when the session is closed", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(
      makeSession({ status: "closed", lastActiveAt: old, taskCheckins: [] }),
    );

    const result = await getSession(companyUuid, sessionUuid);

    // No update call should carry a lastActiveAt write
    const writes = mockPrisma.agentSession.update.mock.calls
      .map((c) => c[0] as { data?: { lastActiveAt?: Date } })
      .filter((c) => c.data?.lastActiveAt instanceof Date);
    expect(writes.length).toBe(0);
    // Returned snapshot keeps the closed row's original timestamp.
    expect(result!.lastActiveAt).toBe(old.toISOString());
  });

  it("closeSession refreshes lastActiveAt as part of the close path", async () => {
    // closeSession's heartbeat fires BEFORE the status flip; the helper
    // sees status='active' at that moment and writes lastActiveAt.
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ lastActiveAt: old }));
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([]);
    mockPrisma.sessionTaskCheckin.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.agentSession.update.mockResolvedValue(
      makeSession({ status: "closed", lastActiveAt: old, taskCheckins: [] }),
    );
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });

    await closeSession(companyUuid, sessionUuid);
    expectHeartbeatCall(old);
  });

  it("reopenSession atomically flips status AND refreshes lastActiveAt in a single update", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(
      makeSession({ status: "closed", lastActiveAt: old }),
    );
    mockPrisma.agentSession.update.mockResolvedValue(
      makeSession({ status: "active", lastActiveAt: new Date(), taskCheckins: [] }),
    );

    await reopenSession(companyUuid, sessionUuid);

    // Exactly one update call, carrying BOTH status and lastActiveAt — protects
    // against concurrent closeSession seeing a half-applied state.
    expect(mockPrisma.agentSession.update.mock.calls.length).toBe(1);
    const updateData = mockPrisma.agentSession.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("active");
    expect(updateData.lastActiveAt).toBeInstanceOf(Date);
    expect((updateData.lastActiveAt as Date).getTime()).toBeGreaterThan(old.getTime());
    // No separate touchLastActiveAt findUnique probe is performed in the atomic path.
    expect(mockPrisma.agentSession.findUnique.mock.calls.length).toBe(0);
  });

  it("sessionCheckinToTask refreshes lastActiveAt on success", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ lastActiveAt: old }));
    mockPrisma.task.findFirst.mockResolvedValue({
      uuid: taskUuid,
      companyUuid,
      projectUuid,
      assigneeUuid: agentUuid,
    });
    mockPrisma.sessionTaskCheckin.upsert.mockResolvedValue({
      taskUuid,
      checkinAt: now,
      checkoutAt: null,
    });
    mockPrisma.agentSession.update.mockResolvedValue(makeSession());
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });

    await sessionCheckinToTask(companyUuid, sessionUuid, taskUuid);
    expectHeartbeatCall(old);
  });

  it("sessionCheckoutFromTask refreshes lastActiveAt on success", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ lastActiveAt: old }));
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });
    mockPrisma.sessionTaskCheckin.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.agentSession.update.mockResolvedValue(makeSession());
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });

    await sessionCheckoutFromTask(companyUuid, sessionUuid, taskUuid);
    expectHeartbeatCall(old);
  });

  it("heartbeatSession refreshes lastActiveAt on success", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ lastActiveAt: old }));
    mockPrisma.agentSession.update.mockResolvedValue(makeSession());
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });

    await heartbeatSession(companyUuid, sessionUuid);
    expectHeartbeatCall(old);
  });

  it("touchLastActiveAt skips refresh when status='closed' (closed-session guard)", async () => {
    // Calling getSession on a closed row should NOT trigger an update.
    const old = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.agentSession.findFirst.mockResolvedValue(
      makeSession({ status: "closed", lastActiveAt: old, taskCheckins: [] }),
    );
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "closed" });

    await getSession(companyUuid, sessionUuid);

    // No update call should carry a lastActiveAt write
    const writes = mockPrisma.agentSession.update.mock.calls
      .map((c) => c[0] as { data?: { lastActiveAt?: Date } })
      .filter((c) => c.data?.lastActiveAt instanceof Date);
    expect(writes.length).toBe(0);
  });
});

// ===== closeSession does NOT mutate task status =====
describe("closeSession task-status preservation", () => {
  it("closes the session, sets checkoutAt on checkins, but does not write to Task.status", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession());
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      { task: { uuid: taskUuid, projectUuid } },
    ]);
    mockPrisma.sessionTaskCheckin.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.agentSession.update.mockResolvedValue(
      makeSession({
        status: "closed",
        taskCheckins: [{ taskUuid, checkinAt: now, checkoutAt: now }],
      }),
    );
    mockPrisma.agentSession.findUnique.mockResolvedValue({ status: "active" });

    const result = await closeSession(companyUuid, sessionUuid);

    expect(result.status).toBe("closed");
    // Checkin is checked out:
    expect(mockPrisma.sessionTaskCheckin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionUuid, checkoutAt: null },
        data: expect.objectContaining({ checkoutAt: expect.any(Date) }),
      }),
    );
    // Service deliberately does not touch Task.status — we have NOT mocked
    // any prisma.task.* writer in this test, and the result is still "closed".
    // The asserted contract: no `data.status` on any prisma.task.update call.
    // (We don't even mock prisma.task.update — so any unexpected call would
    // throw `mockReturnValue is undefined`-style errors and fail the test.)
    void claimTask;
    void eventBus;
  });
});

// ===== Regression guard: `inactive` literal must not reappear in session.service.ts =====
describe("regression guard", () => {
  it("does not contain the literal string 'inactive' in src/services/session.service.ts", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = (await import("node:path")).resolve(
      __dirname,
      "../session.service.ts",
    );
    const src = await readFile(path, "utf8");
    expect(src.includes('"inactive"')).toBe(false);
    expect(src.includes("'inactive'")).toBe(false);
  });
});
