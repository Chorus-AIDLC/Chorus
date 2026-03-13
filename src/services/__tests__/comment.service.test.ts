import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  comment: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  task: {
    findUnique: vi.fn(),
  },
  idea: {
    findUnique: vi.fn(),
  },
  proposal: {
    findUnique: vi.fn(),
  },
  document: {
    findUnique: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/event-bus", () => ({
  eventBus: { emitChange: vi.fn() },
}));

const mockGetActorName = vi.fn();
const mockValidateTargetExists = vi.fn();
vi.mock("@/lib/uuid-resolver", () => ({
  getActorName: (...args: unknown[]) => mockGetActorName(...args),
  validateTargetExists: (...args: unknown[]) => mockValidateTargetExists(...args),
}));

vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn(),
}));

vi.mock("@/services/activity.service", () => ({
  createActivity: vi.fn(),
}));

import {
  createComment,
  listComments,
  batchCommentCounts,
} from "@/services/comment.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const targetUuid = "task-0000-0000-0000-000000000001";
const authorUuid = "user-0000-0000-0000-000000000001";
const commentUuid = "comment-0000-0000-0000-000000000001";

function makeCommentRecord(overrides: Record<string, unknown> = {}) {
  return {
    uuid: commentUuid,
    targetType: "task",
    targetUuid,
    content: "Hello world",
    authorType: "user",
    authorUuid,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorName.mockResolvedValue("Test User");
  mockValidateTargetExists.mockResolvedValue(true);
});

// ===== createComment =====
describe("createComment", () => {
  it("should create comment and return formatted response", async () => {
    const record = makeCommentRecord();
    mockPrisma.comment.create.mockResolvedValue(record);

    const result = await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello world",
      authorType: "user",
      authorUuid,
    });

    expect(result.uuid).toBe(commentUuid);
    expect(result.content).toBe("Hello world");
    expect(result.author.type).toBe("user");
    expect(result.author.uuid).toBe(authorUuid);
    expect(result.author.name).toBe("Test User");
    expect(result.createdAt).toBe(now.toISOString());
  });

  it("should throw when target does not exist", async () => {
    mockValidateTargetExists.mockResolvedValue(false);

    await expect(
      createComment({
        companyUuid,
        targetType: "task",
        targetUuid: "nonexistent",
        content: "Hello",
        authorType: "user",
        authorUuid,
      })
    ).rejects.toThrow("Target task with UUID nonexistent not found");
  });

  it("should use 'Unknown' when author name is null", async () => {
    mockGetActorName.mockResolvedValue(null);
    mockPrisma.comment.create.mockResolvedValue(makeCommentRecord());

    const result = await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello",
      authorType: "user",
      authorUuid,
    });

    expect(result.author.name).toBe("Unknown");
  });
});

// ===== listComments =====
describe("listComments", () => {
  it("should return paginated comments with author names", async () => {
    const record = makeCommentRecord();
    mockPrisma.comment.findMany.mockResolvedValue([record]);
    mockPrisma.comment.count.mockResolvedValue(1);

    const result = await listComments({
      companyUuid,
      targetType: "task",
      targetUuid,
      skip: 0,
      take: 20,
    });

    expect(result.comments).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.comments[0].author.name).toBe("Test User");
  });

  it("should return empty when target does not exist", async () => {
    mockValidateTargetExists.mockResolvedValue(false);

    const result = await listComments({
      companyUuid,
      targetType: "task",
      targetUuid: "nonexistent",
      skip: 0,
      take: 20,
    });

    expect(result.comments).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ===== batchCommentCounts =====
describe("batchCommentCounts", () => {
  it("should return empty object for empty input", async () => {
    const result = await batchCommentCounts(companyUuid, "task", []);
    expect(result).toEqual({});
  });

  it("should return counts grouped by targetUuid", async () => {
    const uuid1 = "task-0000-0000-0000-000000000001";
    const uuid2 = "task-0000-0000-0000-000000000002";

    mockPrisma.comment.groupBy.mockResolvedValue([
      { targetUuid: uuid1, _count: { targetUuid: 3 } },
    ]);

    const result = await batchCommentCounts(companyUuid, "task", [uuid1, uuid2]);

    expect(result[uuid1]).toBe(3);
    expect(result[uuid2]).toBe(0);
  });

  it("should initialize all requested UUIDs to 0", async () => {
    const uuids = ["a", "b", "c"];
    mockPrisma.comment.groupBy.mockResolvedValue([]);

    const result = await batchCommentCounts(companyUuid, "task", uuids);

    expect(result).toEqual({ a: 0, b: 0, c: 0 });
  });
});
