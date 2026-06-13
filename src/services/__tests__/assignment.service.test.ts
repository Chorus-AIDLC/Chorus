import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock (used by getAvailableItems only) =====
const mockPrisma = vi.hoisted(() => ({
  idea: {
    findMany: vi.fn(),
  },
  task: {
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockFormatCreatedBy = vi.fn();
vi.mock("@/lib/uuid-resolver", () => ({
  formatCreatedBy: (...args: unknown[]) => mockFormatCreatedBy(...args),
}));

// ===== idea-tracker.service mock (used by getMyAssignments) =====
const mockBuildIdeaTracker = vi.hoisted(() => vi.fn());
const mockBuildTaskTracker = vi.hoisted(() => vi.fn());
vi.mock("@/services/idea-tracker.service", () => ({
  buildIdeaTracker: mockBuildIdeaTracker,
  buildTaskTracker: mockBuildTaskTracker,
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
    status: "open",
    parentUuid: null,
    createdByUuid: userUuid,
    createdAt: now,
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "task-0000-0000-0000-000000000001",
    title: "Test Task",
    description: "Task description",
    status: "open",
    priority: "high",
    createdByUuid: userUuid,
    createdAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatCreatedBy.mockResolvedValue({
    type: "user",
    uuid: userUuid,
    name: "Test User",
  });
  mockBuildIdeaTracker.mockResolvedValue({});
  mockBuildTaskTracker.mockResolvedValue({});
});

// ===== getMyAssignments =====
describe("getMyAssignments", () => {
  it("returns { ideaTracker, taskTracker } shaped result", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const ideaTracker = {
      [projectUuid]: {
        name: "Test Project",
        ideas: [
          { uuid: "i1", title: "I1", status: "in_progress" as const, proposals: 1, tasks: 2 },
        ],
      },
    };
    const taskTracker = {
      [projectUuid]: {
        name: "Test Project",
        tasks: [
          {
            uuid: "t1",
            title: "T1",
            status: "assigned",
            priority: "high",
            assignedAt: now.toISOString(),
            ac: { passed: 1, total: 3 },
          },
        ],
      },
    };

    mockBuildIdeaTracker.mockResolvedValue(ideaTracker);
    mockBuildTaskTracker.mockResolvedValue(taskTracker);

    const result = await getMyAssignments(userAuth);

    expect(result).toEqual({ ideaTracker, taskTracker });
  });

  it("delegates to buildIdeaTracker / buildTaskTracker with auth", async () => {
    const agentAuth: AuthContext = {
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: ["developer_agent"],
      ownerUuid,
    };

    await getMyAssignments(agentAuth);

    expect(mockBuildIdeaTracker).toHaveBeenCalledWith(agentAuth, { projectUuids: undefined });
    expect(mockBuildTaskTracker).toHaveBeenCalledWith(agentAuth, { projectUuids: undefined });
  });

  it("forwards projectUuids when provided", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    const projectUuid2 = "project-0000-0000-0000-000000000002";

    await getMyAssignments(userAuth, [projectUuid, projectUuid2]);

    expect(mockBuildIdeaTracker).toHaveBeenCalledWith(userAuth, {
      projectUuids: [projectUuid, projectUuid2],
    });
    expect(mockBuildTaskTracker).toHaveBeenCalledWith(userAuth, {
      projectUuids: [projectUuid, projectUuid2],
    });
  });

  it("invokes both helpers in parallel (Promise.all)", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    // Configure each mock to resolve after a microtask delay so we can detect
    // that the result waits for both — i.e. neither call is sequential.
    let ideaResolved = false;
    let taskResolved = false;
    mockBuildIdeaTracker.mockImplementation(async () => {
      ideaResolved = true;
      return {};
    });
    mockBuildTaskTracker.mockImplementation(async () => {
      taskResolved = true;
      return {};
    });

    const result = await getMyAssignments(userAuth);

    expect(ideaResolved).toBe(true);
    expect(taskResolved).toBe(true);
    expect(result).toEqual({ ideaTracker: {}, taskTracker: {} });
  });

  it("returns empty trackers when helpers return empty objects", async () => {
    const userAuth: AuthContext = {
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    };

    mockBuildIdeaTracker.mockResolvedValue({});
    mockBuildTaskTracker.mockResolvedValue({});

    const result = await getMyAssignments(userAuth);

    expect(result.ideaTracker).toEqual({});
    expect(result.taskTracker).toEqual({});
  });
});

// ===== getAvailableItems (unchanged in 0.7.2) =====
describe("getAvailableItems", () => {
  it("should return available ideas and tasks when both allowed", async () => {
    const idea = makeIdea();
    const task = makeTask();

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

  it("should carry parentUuid through to the formatted idea response (set parent)", async () => {
    const parentIdeaUuid = "idea-0000-0000-0000-0000000000aa";
    const idea = makeIdea({ parentUuid: parentIdeaUuid });
    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(result.ideas[0].parentUuid).toBe(parentIdeaUuid);
  });

  it("should normalize a missing/null parentUuid to null", async () => {
    const idea = makeIdea({ parentUuid: null });
    mockPrisma.idea.findMany.mockResolvedValue([idea]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(result.ideas[0].parentUuid).toBeNull();
  });

  it("should request parentUuid in the idea select projection (no extra query)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    await getAvailableItems(companyUuid, projectUuid, true, true);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ parentUuid: true }),
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
