import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  activity: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ===== Event bus mock =====
const mockEventBus = vi.hoisted(() => ({
  emit: vi.fn(),
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

// ===== UUID resolver mock =====
const mockGetActorName = vi.fn();
vi.mock("@/lib/uuid-resolver", () => ({
  getActorName: (...args: unknown[]) => mockGetActorName(...args),
}));

import {
  listActivities,
  listActivitiesWithActorNames,
  createActivity,
} from "@/services/activity.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const targetUuid = "task-0000-0000-0000-000000000001";
const actorUuid = "user-0000-0000-0000-000000000001";
const activityUuid = "activity-0000-0000-0000-000000000001";

function makeActivity(overrides: Record<string, unknown> = {}) {
  return {
    uuid: activityUuid,
    companyUuid,
    projectUuid,
    targetType: "task",
    targetUuid,
    actorType: "user",
    actorUuid,
    action: "task_created",
    value: null,
    sessionUuid: null,
    sessionName: null,
    createdAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorName.mockResolvedValue("Test User");
});

// ===== listActivities =====
describe("listActivities", () => {
  it("should return paginated activities", async () => {
    const activity = makeActivity();
    mockPrisma.activity.findMany.mockResolvedValue([activity]);
    mockPrisma.activity.count.mockResolvedValue(1);

    const result = await listActivities({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(result.activities).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.activities[0].uuid).toBe(activityUuid);
    expect(result.activities[0].action).toBe("task_created");
  });

  it("should filter by targetType when provided", async () => {
    mockPrisma.activity.findMany.mockResolvedValue([]);
    mockPrisma.activity.count.mockResolvedValue(0);

    await listActivities({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
      targetType: "idea",
    });

    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetType: "idea" }),
      })
    );
  });

  it("should filter by targetUuid when provided", async () => {
    mockPrisma.activity.findMany.mockResolvedValue([]);
    mockPrisma.activity.count.mockResolvedValue(0);

    await listActivities({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
      targetUuid: "specific-uuid",
    });

    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetUuid: "specific-uuid" }),
      })
    );
  });

  it("should order by createdAt desc", async () => {
    mockPrisma.activity.findMany.mockResolvedValue([]);
    mockPrisma.activity.count.mockResolvedValue(0);

    await listActivities({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("should pass skip and take to prisma", async () => {
    mockPrisma.activity.findMany.mockResolvedValue([]);
    mockPrisma.activity.count.mockResolvedValue(0);

    await listActivities({
      companyUuid,
      projectUuid,
      skip: 10,
      take: 5,
    });

    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });
});

// ===== listActivitiesWithActorNames =====
describe("listActivitiesWithActorNames", () => {
  it("should resolve actor names and format response", async () => {
    const activity = makeActivity();
    mockPrisma.activity.findMany.mockResolvedValue([activity]);
    mockPrisma.activity.count.mockResolvedValue(1);
    mockGetActorName.mockResolvedValue("John Doe");

    const result = await listActivitiesWithActorNames({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0].actorName).toBe("John Doe");
    expect(result.activities[0].createdAt).toBe(now.toISOString());
    expect(mockGetActorName).toHaveBeenCalledWith("user", actorUuid);
  });

  it("should use 'Unknown' when actor name is null", async () => {
    const activity = makeActivity();
    mockPrisma.activity.findMany.mockResolvedValue([activity]);
    mockPrisma.activity.count.mockResolvedValue(1);
    mockGetActorName.mockResolvedValue(null);

    const result = await listActivitiesWithActorNames({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(result.activities[0].actorName).toBe("Unknown");
  });

  it("should include session info when present", async () => {
    const activity = makeActivity({
      sessionUuid: "session-123",
      sessionName: "test-session",
    });
    mockPrisma.activity.findMany.mockResolvedValue([activity]);
    mockPrisma.activity.count.mockResolvedValue(1);

    const result = await listActivitiesWithActorNames({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(result.activities[0].sessionUuid).toBe("session-123");
    expect(result.activities[0].sessionName).toBe("test-session");
  });

  it("should batch resolve multiple actor names", async () => {
    const activities = [
      makeActivity({ uuid: "act-1", actorUuid: "user-1" }),
      makeActivity({ uuid: "act-2", actorUuid: "user-2" }),
      makeActivity({ uuid: "act-3", actorUuid: "agent-1", actorType: "agent" }),
    ];
    mockPrisma.activity.findMany.mockResolvedValue(activities);
    mockPrisma.activity.count.mockResolvedValue(3);
    mockGetActorName.mockImplementation((type, uuid) =>
      Promise.resolve(`${type}-${uuid}`)
    );

    const result = await listActivitiesWithActorNames({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(result.activities).toHaveLength(3);
    expect(mockGetActorName).toHaveBeenCalledTimes(3);
    expect(result.activities[0].actorName).toBe("user-user-1");
    expect(result.activities[2].actorName).toBe("agent-agent-1");
  });
});

// ===== createActivity =====
describe("createActivity", () => {
  it("should create activity and emit event", async () => {
    const activity = makeActivity();
    mockPrisma.activity.create.mockResolvedValue(activity);

    const result = await createActivity({
      companyUuid,
      projectUuid,
      targetType: "task",
      targetUuid,
      actorType: "user",
      actorUuid,
      action: "task_created",
    });

    expect(result.uuid).toBe(activityUuid);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: {
        companyUuid,
        projectUuid,
        targetType: "task",
        targetUuid,
        actorType: "user",
        actorUuid,
        action: "task_created",
        value: undefined,
        sessionUuid: undefined,
        sessionName: undefined,
      },
    });
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "activity",
      expect.objectContaining({
        companyUuid,
        projectUuid,
        targetType: "task",
        targetUuid,
        action: "task_created",
        uuid: activityUuid,
      })
    );
  });

  it("should handle value parameter", async () => {
    const activity = makeActivity({ value: { status: "done" } });
    mockPrisma.activity.create.mockResolvedValue(activity);

    await createActivity({
      companyUuid,
      projectUuid,
      targetType: "task",
      targetUuid,
      actorType: "user",
      actorUuid,
      action: "task_updated",
      value: { status: "done" },
    });

    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          value: { status: "done" },
        }),
      })
    );
  });

  it("should handle session info", async () => {
    const activity = makeActivity({
      sessionUuid: "session-123",
      sessionName: "worker-1",
    });
    mockPrisma.activity.create.mockResolvedValue(activity);

    await createActivity({
      companyUuid,
      projectUuid,
      targetType: "task",
      targetUuid,
      actorType: "agent",
      actorUuid,
      action: "task_claimed",
      sessionUuid: "session-123",
      sessionName: "worker-1",
    });

    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionUuid: "session-123",
          sessionName: "worker-1",
        }),
      })
    );
  });

  it("should convert null value to undefined", async () => {
    const activity = makeActivity();
    mockPrisma.activity.create.mockResolvedValue(activity);

    await createActivity({
      companyUuid,
      projectUuid,
      targetType: "idea",
      targetUuid,
      actorType: "user",
      actorUuid,
      action: "idea_created",
      value: null,
    });

    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          value: undefined,
        }),
      })
    );
  });

  it("should support different target types", async () => {
    const targetTypes = ["idea", "task", "proposal", "document"] as const;

    for (const targetType of targetTypes) {
      const activity = makeActivity({ targetType });
      mockPrisma.activity.create.mockResolvedValue(activity);

      await createActivity({
        companyUuid,
        projectUuid,
        targetType,
        targetUuid,
        actorType: "user",
        actorUuid,
        action: `${targetType}_created`,
      });

      expect(mockPrisma.activity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ targetType }),
        })
      );
    }
  });
});
