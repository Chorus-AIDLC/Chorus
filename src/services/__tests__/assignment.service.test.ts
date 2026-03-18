import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  idea: {
    findMany: vi.fn(),
  },
  task: {
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockFormatAssignee = vi.fn();
const mockFormatCreatedBy = vi.fn();
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssignee: (...args: unknown[]) => mockFormatAssignee(...args),
  formatCreatedBy: (...args: unknown[]) => mockFormatCreatedBy(...args),
}));

import { getMyAssignments, getAvailableItems } from "@/services/assignment.service";
import type { AuthContext } from "@/types/auth";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "user-0000-0000-0000-000000000002";

function makeIdea(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "idea-0000-0000-0000-000000000001",
    title: "Test Idea",
    content: "Idea content",
    status: "claimed",
    assigneeType: "user",
    assigneeUuid: userUuid,
    assignedAt: now,
    project: { uuid: projectUuid, name: "Test Project" },
    createdAt: now,
    updatedAt: now,
    createdByUuid: userUuid,
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "task-0000-0000-0000-000000000001",
    title: "Test Task",
    description: "Task description",
    status: "assigned",
    priority: "high",
    assigneeType: "user",
    assigneeUuid: userUuid,
    assignedAt: now,
    project: { uuid: projectUuid, name: "Test Project" },
    createdAt: now,
    updatedAt: now,
    createdByUuid: userUuid,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatAssignee.mockResolvedValue({
    type: "user",
    uuid: userUuid,
    name: "Test User",
  });
  mockFormatCreatedBy.mockResolvedValue({
    type: "user",
    uuid: userUuid,
    name: "Test User",
  });
});

// ===== getMyAssignments =====
describe("getMyAssignments", () => {
  it("should return user's claimed ideas and tasks", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const idea = makeIdea();
    const task = makeTask();

    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([task]);

    const result = await getMyAssignments(userAuth);

    expect(result.ideas).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.ideas[0].uuid).toBe(idea.uuid);
    expect(result.tasks[0].uuid).toBe(task.uuid);
  });

  it("should query with user assignment condition", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          OR: [{ assigneeType: "user", assigneeUuid: userUuid }],
          status: { notIn: ["completed", "closed"] },
        }),
      })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          OR: [{ assigneeType: "user", assigneeUuid: userUuid }],
          status: { notIn: ["done", "closed"] },
        }),
      })
    );
  });

  it("should query with agent assignment conditions (agent + owner)", async () => {
    const agentAuth: AuthContext = {
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: ["developer_agent"],
      ownerUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(agentAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          OR: [
            { assigneeType: "agent", assigneeUuid: agentUuid },
            { assigneeType: "user", assigneeUuid: ownerUuid },
          ],
        }),
      })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          OR: [
            { assigneeType: "agent", assigneeUuid: agentUuid },
            { assigneeType: "user", assigneeUuid: ownerUuid },
          ],
        }),
      })
    );
  });

  it("should exclude completed ideas and done tasks", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ["completed", "closed"] },
        }),
      })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ["done", "closed"] },
        }),
      })
    );
  });

  it("should format ideas with assignee info", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const idea = makeIdea();
    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    mockFormatAssignee.mockResolvedValue({
      type: "user",
      uuid: userUuid,
      name: "John Doe",
    });

    const result = await getMyAssignments(userAuth);

    expect(result.ideas[0].assignee).toEqual({
      type: "user",
      uuid: userUuid,
      name: "John Doe",
    });
    expect(mockFormatAssignee).toHaveBeenCalledWith("user", userUuid);
  });

  it("should format tasks with assignee info", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const task = makeTask();
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([task]);

    mockFormatAssignee.mockResolvedValue({
      type: "agent",
      uuid: agentUuid,
      name: "Bot Agent",
    });

    const result = await getMyAssignments(userAuth);

    expect(result.tasks[0].assignee).toEqual({
      type: "agent",
      uuid: agentUuid,
      name: "Bot Agent",
    });
  });

  it("should return ISO date strings for timestamps", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const idea = makeIdea();
    const task = makeTask();
    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([task]);

    const result = await getMyAssignments(userAuth);

    expect(result.ideas[0].createdAt).toBe(now.toISOString());
    expect(result.ideas[0].assignedAt).toBe(now.toISOString());
    expect(result.tasks[0].createdAt).toBe(now.toISOString());
    expect(result.tasks[0].assignedAt).toBe(now.toISOString());
  });

  it("should order ideas by assignedAt desc", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { assignedAt: "desc" },
      })
    );
  });

  it("should order tasks by priority desc, then assignedAt desc", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth);

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ priority: "desc" }, { assignedAt: "desc" }],
      })
    );
  });

  it("should filter by projectUuids when provided", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth, [projectUuid]);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          projectUuid: { in: [projectUuid] },
          OR: [{ assigneeType: "user", assigneeUuid: userUuid }],
        }),
      })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          projectUuid: { in: [projectUuid] },
          OR: [{ assigneeType: "user", assigneeUuid: userUuid }],
        }),
      })
    );
  });

  it("should not filter by projectUuids when not provided", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth);

    const ideaWhere = mockPrisma.idea.findMany.mock.calls[0][0].where;
    const taskWhere = mockPrisma.task.findMany.mock.calls[0][0].where;

    expect(ideaWhere).not.toHaveProperty("projectUuid");
    expect(taskWhere).not.toHaveProperty("projectUuid");
  });

  it("should filter by multiple projectUuids", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const projectUuid2 = "project-0000-0000-0000-000000000002";

    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getMyAssignments(userAuth, [projectUuid, projectUuid2]);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          projectUuid: { in: [projectUuid, projectUuid2] },
          OR: [{ assigneeType: "user", assigneeUuid: userUuid }],
        }),
      })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid,
          projectUuid: { in: [projectUuid, projectUuid2] },
          OR: [{ assigneeType: "user", assigneeUuid: userUuid }],
        }),
      })
    );
  });
});

// ===== getAvailableItems =====
describe("getAvailableItems", () => {
  it("should return available ideas and tasks when both allowed", async () => {
    const idea = makeIdea({ status: "open", assigneeType: null, assigneeUuid: null });
    const task = makeTask({ status: "open", assigneeType: null, assigneeUuid: null });

    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([task]);

    const result = await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(result.ideas).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
  });

  it("should return empty ideas when canClaimIdeas is false", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([makeTask({ status: "open" })]);

    const result = await getAvailableItems(companyUuid, projectUuid, false, true);

    expect(result.ideas).toEqual([]);
    expect(result.tasks).toHaveLength(1);
  });

  it("should return empty tasks when canClaimTasks is false", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea({ status: "open" })]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getAvailableItems(companyUuid, projectUuid, true, false);

    expect(result.ideas).toHaveLength(1);
    expect(result.tasks).toEqual([]);
  });

  it("should filter by open status only", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectUuid,
          companyUuid,
          status: "open",
        }),
      })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectUuid,
          companyUuid,
          status: "open",
        }),
      })
    );
  });

  it("should limit results to 50 items", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );
  });

  it("should format ideas with createdBy info", async () => {
    const idea = makeIdea({ status: "open" });
    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    mockFormatCreatedBy.mockResolvedValue({
      type: "user",
      uuid: userUuid,
      name: "Alice",
    });

    const result = await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(result.ideas[0].createdBy).toEqual({
      type: "user",
      uuid: userUuid,
      name: "Alice",
    });
    expect(mockFormatCreatedBy).toHaveBeenCalledWith(userUuid);
  });

  it("should format tasks with createdBy info", async () => {
    const task = makeTask({ status: "open" });
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([task]);

    mockFormatCreatedBy.mockResolvedValue({
      type: "agent",
      uuid: agentUuid,
      name: "PM Agent",
    });

    const result = await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(result.tasks[0].createdBy).toEqual({
      type: "agent",
      uuid: agentUuid,
      name: "PM Agent",
    });
  });

  it("should return ISO date strings for createdAt", async () => {
    const idea = makeIdea({ status: "open" });
    const task = makeTask({ status: "open" });
    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([task]);

    const result = await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(result.ideas[0].createdAt).toBe(now.toISOString());
    expect(result.tasks[0].createdAt).toBe(now.toISOString());
  });

  it("should order ideas by createdAt desc", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("should order tasks by priority desc, then createdAt desc", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      })
    );
  });

  it("should return both empty arrays when nothing allowed", async () => {
    const result = await getAvailableItems(companyUuid, projectUuid, false, false);

    expect(result.ideas).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(mockPrisma.idea.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });
});
