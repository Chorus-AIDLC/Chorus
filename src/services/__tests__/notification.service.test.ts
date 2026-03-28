import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  notification: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  notificationPreference: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockEventBus = vi.hoisted(() => ({
  emit: vi.fn(),
  emitChange: vi.fn(),
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

import {
  create,
  createBatch,
  list,
  markRead,
  markAllRead,
  getUnreadCount,
  archive,
  emitAgentCheckinIfFirst,
} from "@/services/notification.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const recipientUuid = "user-0000-0000-0000-000000000001";
const notifUuid = "notif-0000-0000-0000-000000000001";

function makeNotifParams(overrides: Record<string, unknown> = {}) {
  return {
    companyUuid,
    projectUuid: "project-0000-0000-0000-000000000001",
    recipientType: "user",
    recipientUuid,
    entityType: "task",
    entityUuid: "task-0000-0000-0000-000000000001",
    entityTitle: "Test Task",
    projectName: "Test Project",
    action: "assigned",
    message: "You were assigned to a task",
    actorType: "agent",
    actorUuid: "agent-0000-0000-0000-000000000001",
    actorName: "PM Agent",
    ...overrides,
  };
}

function makeNotifRecord(overrides: Record<string, unknown> = {}) {
  return {
    uuid: notifUuid,
    ...makeNotifParams(),
    readAt: null,
    archivedAt: null,
    createdAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===== create =====
describe("create", () => {
  it("should create notification and emit SSE event", async () => {
    const record = makeNotifRecord();
    mockPrisma.notification.create.mockResolvedValue(record);
    mockPrisma.notification.count.mockResolvedValue(5);

    const result = await create(makeNotifParams());

    expect(result.uuid).toBe(notifUuid);
    expect(result.readAt).toBeNull();
    expect(result.createdAt).toBe(now.toISOString());
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      `notification:user:${recipientUuid}`,
      expect.objectContaining({ type: "new_notification", unreadCount: 5 })
    );
  });
});

// ===== createBatch =====
describe("createBatch", () => {
  it("should create multiple notifications and emit per-recipient events", async () => {
    const recipient2 = "user-0000-0000-0000-000000000002";
    const params1 = makeNotifParams();
    const params2 = makeNotifParams({ recipientUuid: recipient2 });

    const record1 = makeNotifRecord();
    const record2 = makeNotifRecord({ uuid: "notif-0000-0000-0000-000000000002", recipientUuid: recipient2 });

    mockPrisma.notification.create
      .mockResolvedValueOnce(record1)
      .mockResolvedValueOnce(record2);
    mockPrisma.notification.count.mockResolvedValue(3);

    const result = await createBatch([params1, params2]);

    expect(result).toHaveLength(2);
    // Two distinct recipients should trigger two emit calls
    expect(mockEventBus.emit).toHaveBeenCalledTimes(2);
  });

  it("should deduplicate recipients and emit once per recipient", async () => {
    const params = makeNotifParams();
    const record = makeNotifRecord();

    mockPrisma.notification.create
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, uuid: "notif-2" });
    mockPrisma.notification.count.mockResolvedValue(2);

    await createBatch([params, params]);

    // Same recipient => one emit
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
  });
});

// ===== list =====
describe("list", () => {
  it("should return paginated notifications with unread count", async () => {
    const record = makeNotifRecord();
    mockPrisma.notification.findMany.mockResolvedValue([record]);
    mockPrisma.notification.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(5); // unreadCount

    const result = await list({
      companyUuid,
      recipientType: "user",
      recipientUuid,
      skip: 0,
      take: 20,
    });

    expect(result.notifications).toHaveLength(1);
    expect(result.total).toBe(10);
    expect(result.unreadCount).toBe(5);
  });

  it("should apply unread filter", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.count.mockResolvedValue(0);

    await list({
      companyUuid,
      recipientType: "user",
      recipientUuid,
      readFilter: "unread",
      skip: 0,
      take: 20,
    });

    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ readAt: null }),
      })
    );
  });

  it("should apply read filter", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.count.mockResolvedValue(0);

    await list({
      companyUuid,
      recipientType: "user",
      recipientUuid,
      readFilter: "read",
      skip: 0,
      take: 20,
    });

    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ readAt: { not: null } }),
      })
    );
  });

  it("should filter by projectUuid when provided", async () => {
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.count.mockResolvedValue(0);

    await list({
      companyUuid,
      recipientType: "user",
      recipientUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectUuid }),
      })
    );
  });
});

// ===== markRead =====
describe("markRead", () => {
  it("should mark notification as read and emit count update", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const record = makeNotifRecord({ readAt: now });
    mockPrisma.notification.findFirst.mockResolvedValue(record);
    mockPrisma.notification.count.mockResolvedValue(4);

    const result = await markRead(notifUuid, companyUuid, "user", recipientUuid);

    expect(result.readAt).toBe(now.toISOString());
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      `notification:user:${recipientUuid}`,
      expect.objectContaining({ type: "count_update", unreadCount: 4 })
    );
  });

  it("should throw when notification not found after update", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notification.count.mockResolvedValue(0);

    await expect(markRead(notifUuid, companyUuid, "user", recipientUuid)).rejects.toThrow(
      "Notification not found"
    );
  });
});

// ===== markAllRead =====
describe("markAllRead", () => {
  it("should mark all unread notifications as read", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });
    mockPrisma.notification.count.mockResolvedValue(0);

    const result = await markAllRead(companyUuid, "user", recipientUuid);

    expect(result.count).toBe(5);
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      `notification:user:${recipientUuid}`,
      expect.objectContaining({ type: "count_update", unreadCount: 0 })
    );
  });

  it("should scope to projectUuid when provided", async () => {
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.notification.count.mockResolvedValue(3);

    await markAllRead(companyUuid, "user", recipientUuid, projectUuid);

    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectUuid }),
      })
    );
  });
});

// ===== getUnreadCount =====
describe("getUnreadCount", () => {
  it("should return count of unread non-archived notifications", async () => {
    mockPrisma.notification.count.mockResolvedValue(7);

    const result = await getUnreadCount(companyUuid, "user", recipientUuid);

    expect(result).toBe(7);
    expect(mockPrisma.notification.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          readAt: null,
          archivedAt: null,
        }),
      })
    );
  });
});

// ===== archive =====
describe("archive", () => {
  it("should archive notification and emit count update", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
    const record = makeNotifRecord({ archivedAt: now });
    mockPrisma.notification.findFirst.mockResolvedValue(record);
    mockPrisma.notification.count.mockResolvedValue(2);

    const result = await archive(notifUuid, companyUuid, "user", recipientUuid);

    expect(result.archivedAt).toBe(now.toISOString());
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      `notification:user:${recipientUuid}`,
      expect.objectContaining({ type: "count_update" })
    );
  });

  it("should throw when notification not found after archive", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notification.count.mockResolvedValue(0);

    await expect(archive(notifUuid, companyUuid, "user", recipientUuid)).rejects.toThrow(
      "Notification not found"
    );
  });
});

// ===== emitAgentCheckinIfFirst =====

describe("emitAgentCheckinIfFirst", () => {
  const agentUuid = "agent-0000-0000-0000-000000000001";
  const agentName = "Test Agent";
  const ownerUuid = "user-0000-0000-0000-000000000001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create agent_checkin notification on first checkin", async () => {
    // No existing notification
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    // Mock create
    mockPrisma.notification.create.mockResolvedValue({
      uuid: "notif-new",
      companyUuid,
      projectUuid: "system",
      recipientType: "user",
      recipientUuid: ownerUuid,
      entityType: "agent",
      entityUuid: agentUuid,
      entityTitle: agentName,
      projectName: "",
      action: "agent_checkin",
      message: `Agent "${agentName}" connected successfully`,
      actorType: "agent",
      actorUuid: agentUuid,
      actorName: agentName,
      readAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    mockPrisma.notification.count.mockResolvedValue(1);

    const result = await emitAgentCheckinIfFirst({
      companyUuid,
      agentUuid,
      agentName,
      ownerUuid,
    });

    expect(result).toBe(true);
    // Verify findFirst was called with correct filters
    expect(mockPrisma.notification.findFirst).toHaveBeenCalledWith({
      where: {
        companyUuid,
        action: "agent_checkin",
        actorType: "agent",
        actorUuid: agentUuid,
      },
      select: { uuid: true },
    });
    // Verify notification was created
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "agent_checkin",
          recipientType: "user",
          recipientUuid: ownerUuid,
          entityUuid: agentUuid,
          actorUuid: agentUuid,
        }),
      })
    );
    // Verify SSE event was emitted
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      `notification:user:${ownerUuid}`,
      expect.objectContaining({ type: "new_notification" })
    );
  });

  it("should NOT create duplicate notification on subsequent checkin", async () => {
    // Existing notification found
    mockPrisma.notification.findFirst.mockResolvedValue({ uuid: "existing-notif" });

    const result = await emitAgentCheckinIfFirst({
      companyUuid,
      agentUuid,
      agentName,
      ownerUuid,
    });

    expect(result).toBe(false);
    // Verify create was NOT called
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    // Verify no SSE event
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });
});
