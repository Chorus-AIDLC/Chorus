import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  agentSession: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
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
  markInactiveSessions,
  batchGetWorkerCountsForTasks,
  getSessionName,
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
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it("should pass description and expiresAt when provided", async () => {
    const expires = new Date("2026-04-01T00:00:00Z");
    const session = makeSession({ description: "desc", expiresAt: expires });
    mockPrisma.agentSession.create.mockResolvedValue(session);

    await createSession({
      companyUuid,
      agentUuid,
      name: "test-session",
      description: "desc",
      expiresAt: expires,
    });

    expect(mockPrisma.agentSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: "desc",
          expiresAt: expires,
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

  it("should restore inactive session to active", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(makeSession({ status: "inactive" }));
    mockPrisma.agentSession.update.mockResolvedValue(makeSession({ status: "active" }));

    await heartbeatSession(companyUuid, sessionUuid);

    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "active" }),
      })
    );
  });

  it("should throw when session not found", async () => {
    mockPrisma.agentSession.findFirst.mockResolvedValue(null);
    await expect(heartbeatSession(companyUuid, "missing")).rejects.toThrow("Session not found");
  });
});

// ===== markInactiveSessions =====
describe("markInactiveSessions", () => {
  it("should mark stale active sessions as inactive", async () => {
    mockPrisma.agentSession.updateMany.mockResolvedValue({ count: 3 });

    const count = await markInactiveSessions();

    expect(count).toBe(3);
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "active" }),
        data: { status: "inactive" },
      })
    );
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
