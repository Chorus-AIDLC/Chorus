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

// Mock the wake-notification → DaemonSessionTurn bridge so this suite stays focused on
// the notification chokepoint itself (the bridge's own action→trigger / instruction /
// failure-isolation behavior is exhaustively covered in notification-turn.test.ts).
// Mocking it also keeps the daemon-session / connection / lineage chains out of this
// unit test. We still assert the chokepoint INVOKES it for each created notification.
const mockMaybeCreateTurn = vi.hoisted(() => vi.fn());
vi.mock("@/services/notification-turn", () => ({
  maybeCreateTurnForWakeNotification: mockMaybeCreateTurn,
}));

import {
  create,
  createBatch,
  list,
  markRead,
  markAllRead,
  getUnreadCount,
  archive,
  emitAgentCheckin,
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
  // The bridge resolves to null by default (no turn created) — its real behavior is
  // tested separately; here we only care that the chokepoint calls it.
  mockMaybeCreateTurn.mockResolvedValue(null);
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

  it("should persist instructionText (write-once denormalized copy) and pass it to the turn bridge", async () => {
    const params = makeNotifParams({
      recipientType: "agent",
      recipientUuid: "agent-0000-0000-0000-000000000099",
      action: "human_instruction",
      instructionText: "Please refactor the auth module",
    });
    mockPrisma.notification.create.mockResolvedValue(makeNotifRecord(params));
    mockPrisma.notification.count.mockResolvedValue(1);

    await create(params);

    // The denormalized copy is written onto the notification row.
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          instructionText: "Please refactor the auth module",
        }),
      })
    );
    // The chokepoint invokes the bridge with the full params (incl. instructionText).
    expect(mockMaybeCreateTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "human_instruction",
        instructionText: "Please refactor the auth module",
      })
    );
  });

  it("should default instructionText to null when absent", async () => {
    mockPrisma.notification.create.mockResolvedValue(makeNotifRecord());
    mockPrisma.notification.count.mockResolvedValue(0);

    await create(makeNotifParams());

    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ instructionText: null }),
      })
    );
  });

  it("should invoke the turn bridge once after creating the notification", async () => {
    mockPrisma.notification.create.mockResolvedValue(makeNotifRecord());
    mockPrisma.notification.count.mockResolvedValue(0);

    await create(makeNotifParams());

    expect(mockMaybeCreateTurn).toHaveBeenCalledTimes(1);
  });

  it("surfaces instructionText in the READ projection so the daemon reads it with no extra fetch (子1)", async () => {
    // The daemon's event-router reads n.instructionText from the chorus_get_notifications
    // result — so the formatted projection MUST carry it through.
    mockPrisma.notification.create.mockResolvedValue(
      makeNotifRecord({ action: "human_instruction", instructionText: "Please rebase onto main" }),
    );
    mockPrisma.notification.count.mockResolvedValue(0);

    const result = await create(makeNotifParams());
    expect(result.instructionText).toBe("Please rebase onto main");
  });

  it("defaults the projected instructionText to null for a non-instruction notification", async () => {
    mockPrisma.notification.create.mockResolvedValue(makeNotifRecord()); // no instructionText column
    mockPrisma.notification.count.mockResolvedValue(0);

    const result = await create(makeNotifParams());
    expect(result.instructionText).toBeNull();
  });

  it("should still return the notification when the turn bridge resolves (failure-isolated)", async () => {
    // The bridge never throws (it logs+swallows internally), but assert create() does
    // not depend on the bridge's outcome: the notification is returned regardless.
    mockMaybeCreateTurn.mockResolvedValue(null);
    mockPrisma.notification.create.mockResolvedValue(makeNotifRecord());
    mockPrisma.notification.count.mockResolvedValue(0);

    const result = await create(makeNotifParams());

    expect(result.uuid).toBe(notifUuid);
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

  it("should invoke the turn bridge once per notification param (not deduped)", async () => {
    const recipient2 = "agent-0000-0000-0000-000000000002";
    const params1 = makeNotifParams({ recipientType: "agent", action: "task_assigned" });
    const params2 = makeNotifParams({
      recipientType: "agent",
      recipientUuid: recipient2,
      action: "mentioned",
    });
    mockPrisma.notification.create
      .mockResolvedValueOnce(makeNotifRecord(params1))
      .mockResolvedValueOnce(makeNotifRecord(params2));
    mockPrisma.notification.count.mockResolvedValue(1);

    await createBatch([params1, params2]);

    // One bridge call per param (the bridge itself decides whether a turn is created).
    expect(mockMaybeCreateTurn).toHaveBeenCalledTimes(2);
    expect(mockMaybeCreateTurn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task_assigned" })
    );
    expect(mockMaybeCreateTurn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mentioned" })
    );
  });

  it("should persist instructionText per notification in the batch", async () => {
    const params = makeNotifParams({
      recipientType: "agent",
      action: "human_instruction",
      instructionText: "do the thing",
    });
    mockPrisma.notification.create.mockResolvedValue(makeNotifRecord(params));
    mockPrisma.notification.count.mockResolvedValue(1);

    await createBatch([params]);

    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ instructionText: "do the thing" }),
      })
    );
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

// ===== emitAgentCheckin =====

describe("emitAgentCheckin", () => {
  const agentUuid = "agent-0000-0000-0000-000000000001";
  const agentName = "Test Agent";
  const ownerUuid = "user-0000-0000-0000-000000000001";

  it("should emit SSE event without creating a DB row", () => {
    emitAgentCheckin({ agentUuid, agentName, ownerUuid });

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      `notification:user:${ownerUuid}`,
      expect.objectContaining({
        type: "new_notification",
        action: "agent_checkin",
        entityUuid: agentUuid,
      })
    );
  });
});
