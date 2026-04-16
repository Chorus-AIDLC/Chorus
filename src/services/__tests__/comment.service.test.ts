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
    findFirst: vi.fn(),
  },
  idea: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  proposal: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  document: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  agent: {
    findMany: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
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
  resolveProjectUuid,
  resolveAgentOwners,
} from "@/services/comment.service";
import { parseMentions, createMentions } from "@/services/mention.service";
import { createActivity } from "@/services/activity.service";
import { eventBus } from "@/lib/event-bus";

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

  it("should emit SSE event when projectUuid resolves", async () => {
    const record = makeCommentRecord();
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(eventBus.emitChange).toHaveBeenCalledWith({
      companyUuid,
      projectUuid,
      entityType: "task",
      entityUuid: targetUuid,
      action: "updated",
      actorUuid: authorUuid,
    });
  });

  it("should process mentions when comment contains @mentions", async () => {
    const record = makeCommentRecord({ content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });
    mockPrisma.task.findUnique.mockResolvedValue({ title: "Test Task" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(parseMentions).toHaveBeenCalledWith("Hello @user(uuid-123,John)");
    expect(createMentions).toHaveBeenCalledWith({
      companyUuid,
      sourceType: "comment",
      sourceUuid: commentUuid,
      content: "Hello @user(uuid-123,John)",
      actorType: "user",
      actorUuid: authorUuid,
      projectUuid,
      entityTitle: "Test Task",
    });
    expect(createActivity).toHaveBeenCalledWith({
      companyUuid,
      projectUuid,
      targetType: "task",
      targetUuid,
      actorType: "user",
      actorUuid: authorUuid,
      action: "mentioned",
      value: {
        mentionedType: "user",
        mentionedUuid: "uuid-123",
        mentionedName: "John",
        sourceType: "comment",
        sourceUuid: commentUuid,
      },
    });
  });

  it("should skip self-mentions when processing mentions", async () => {
    const record = makeCommentRecord({ content: "Hello @user(user-0000-0000-0000-000000000001,Myself)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid, title: "Test Task" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: authorUuid, displayName: "Myself" },
    ]);

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello @user(user-0000-0000-0000-000000000001,Myself)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createActivity).not.toHaveBeenCalled();
  });

  it("should handle multiple mentions", async () => {
    const record = makeCommentRecord({ content: "@user(uuid-1,John) @agent(uuid-2,Bot)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid, title: "Test Task" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-1", displayName: "John" },
      { type: "agent", uuid: "uuid-2", displayName: "Bot" },
    ]);

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "@user(uuid-1,John) @agent(uuid-2,Bot)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createActivity).toHaveBeenCalledTimes(2);
  });

  it("should not process mentions when content has no mentions", async () => {
    const record = makeCommentRecord();
    mockPrisma.comment.create.mockResolvedValue(record);
    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello world",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createMentions).not.toHaveBeenCalled();
    expect(createActivity).not.toHaveBeenCalled();
  });

  it("should handle mention processing errors gracefully", async () => {
    const record = makeCommentRecord({ content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid, title: "Test Task" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);
    (createMentions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("should process mentions for idea target type", async () => {
    const ideaUuid = "idea-0000-0000-0000-000000000001";
    const record = makeCommentRecord({ targetType: "idea", targetUuid: ideaUuid, content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.idea.findFirst.mockResolvedValue({ projectUuid });
    mockPrisma.idea.findUnique.mockResolvedValue({ title: "Test Idea" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);

    await createComment({
      companyUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        entityTitle: "Test Idea",
      })
    );
  });

  it("should process mentions for proposal target type", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000001";
    const record = makeCommentRecord({ targetType: "proposal", targetUuid: proposalUuid, content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.proposal.findFirst.mockResolvedValue({ projectUuid });
    mockPrisma.proposal.findUnique.mockResolvedValue({ title: "Test Proposal" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);

    await createComment({
      companyUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        entityTitle: "Test Proposal",
      })
    );
  });

  it("should process mentions for document target type", async () => {
    const docUuid = "doc-0000-0000-0000-000000000001";
    const record = makeCommentRecord({ targetType: "document", targetUuid: docUuid, content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.document.findFirst.mockResolvedValue({ projectUuid });
    mockPrisma.document.findUnique.mockResolvedValue({ title: "Test Document" });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);

    await createComment({
      companyUuid,
      targetType: "document",
      targetUuid: docUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        entityTitle: "Test Document",
      })
    );
  });

  it("should handle unknown entity type in resolveEntityTitle", async () => {
    const unknownUuid = "unknown-0000-0000-0000-000000000001";
    const record = makeCommentRecord({ targetType: "unknown", targetUuid: unknownUuid, content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);

    // Mock resolveProjectUuid to return null for unknown type (default case)
    // We need to make sure processCommentMentions doesn't proceed when projectUuid is null
    // Actually looking at the code, if projectUuid is null, processCommentMentions returns early
    // So this test should verify that createMentions is NOT called

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);

    await createComment({
      companyUuid,
      targetType: "unknown" as "task",
      targetUuid: unknownUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not create mentions when projectUuid resolution fails
    expect(createMentions).not.toHaveBeenCalled();
  });

  it("should use fallback title when entity not found in resolveEntityTitle", async () => {
    const record = makeCommentRecord({ content: "Hello @user(uuid-123,John)" });
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);

    // Mock findUnique to return different values based on the select clause
    mockPrisma.task.findUnique.mockImplementation((args: any) => {
      if (args.select?.projectUuid) {
        // resolveProjectUuid call - return projectUuid
        return Promise.resolve({ projectUuid });
      } else if (args.select?.title) {
        // resolveEntityTitle call - return null to trigger fallback
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    (parseMentions as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "user", uuid: "uuid-123", displayName: "John" },
    ]);

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello @user(uuid-123,John)",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(createMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        entityTitle: "Unknown Task",
      })
    );
  });

  it("should not emit SSE event when projectUuid is null", async () => {
    const record = makeCommentRecord();
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(eventBus.emitChange).not.toHaveBeenCalled();
  });

  it("should handle SSE event emission errors gracefully", async () => {
    const record = makeCommentRecord();
    const projectUuid = "project-0000-0000-0000-000000000001";
    mockPrisma.comment.create.mockResolvedValue(record);
    mockPrisma.task.findUnique.mockRejectedValue(new Error("DB error"));

    await createComment({
      companyUuid,
      targetType: "task",
      targetUuid,
      content: "Hello",
      authorType: "user",
      authorUuid,
    });

    // Give async fire-and-forget time to resolve and fail silently
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not throw, fire-and-forget handles errors
    expect(eventBus.emitChange).not.toHaveBeenCalled();
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

  it("should handle pagination with skip and take", async () => {
    const records = [
      makeCommentRecord({ uuid: "comment-1" }),
      makeCommentRecord({ uuid: "comment-2" }),
    ];
    mockPrisma.comment.findMany.mockResolvedValue(records);
    mockPrisma.comment.count.mockResolvedValue(10);

    const result = await listComments({
      companyUuid,
      targetType: "task",
      targetUuid,
      skip: 5,
      take: 2,
    });

    expect(result.comments).toHaveLength(2);
    expect(result.total).toBe(10);
    expect(mockPrisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 5,
        take: 2,
      })
    );
  });

  it("should use 'Unknown' when author name is null", async () => {
    mockGetActorName.mockResolvedValue(null);
    mockPrisma.comment.findMany.mockResolvedValue([makeCommentRecord()]);
    mockPrisma.comment.count.mockResolvedValue(1);

    const result = await listComments({
      companyUuid,
      targetType: "task",
      targetUuid,
      skip: 0,
      take: 20,
    });

    expect(result.comments[0].author.name).toBe("Unknown");
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

// ===== resolveProjectUuid =====
describe("resolveProjectUuid", () => {
  it("should resolve projectUuid for task", async () => {
    const projectUuid = "project-123";
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });

    const result = await resolveProjectUuid("task", "task-123");

    expect(result).toBe(projectUuid);
    expect(mockPrisma.task.findFirst).toHaveBeenCalledWith({
      where: { uuid: "task-123" },
      select: { projectUuid: true },
    });
  });

  it("should resolve projectUuid for idea", async () => {
    const projectUuid = "project-456";
    mockPrisma.idea.findFirst.mockResolvedValue({ projectUuid });

    const result = await resolveProjectUuid("idea", "idea-123");

    expect(result).toBe(projectUuid);
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith({
      where: { uuid: "idea-123" },
      select: { projectUuid: true },
    });
  });

  it("should resolve projectUuid for proposal", async () => {
    const projectUuid = "project-789";
    mockPrisma.proposal.findFirst.mockResolvedValue({ projectUuid });

    const result = await resolveProjectUuid("proposal", "proposal-123");

    expect(result).toBe(projectUuid);
    expect(mockPrisma.proposal.findFirst).toHaveBeenCalledWith({
      where: { uuid: "proposal-123" },
      select: { projectUuid: true },
    });
  });

  it("should resolve projectUuid for document", async () => {
    const projectUuid = "project-abc";
    mockPrisma.document.findFirst.mockResolvedValue({ projectUuid });

    const result = await resolveProjectUuid("document", "doc-123");

    expect(result).toBe(projectUuid);
    expect(mockPrisma.document.findFirst).toHaveBeenCalledWith({
      where: { uuid: "doc-123" },
      select: { projectUuid: true },
    });
  });

  it("should return null for unknown target type", async () => {
    const result = await resolveProjectUuid("unknown", "unknown-123");

    expect(result).toBeNull();
  });

  it("should return null when entity not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const result = await resolveProjectUuid("task", "nonexistent");

    expect(result).toBeNull();
  });

  it("should pass companyUuid filter when provided", async () => {
    const projectUuid = "project-scoped";
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });

    const result = await resolveProjectUuid("task", "task-123", "company-abc");

    expect(result).toBe(projectUuid);
    expect(mockPrisma.task.findFirst).toHaveBeenCalledWith({
      where: { uuid: "task-123", companyUuid: "company-abc" },
      select: { projectUuid: true },
    });
  });

  it("should not include companyUuid filter when not provided", async () => {
    const projectUuid = "project-unscoped";
    mockPrisma.idea.findFirst.mockResolvedValue({ projectUuid });

    const result = await resolveProjectUuid("idea", "idea-123");

    expect(result).toBe(projectUuid);
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith({
      where: { uuid: "idea-123" },
      select: { projectUuid: true },
    });
  });
});

// ===== resolveAgentOwners =====
describe("resolveAgentOwners", () => {
  const makeComment = (overrides = {}) => ({
    uuid: "comment-001",
    targetType: "task",
    targetUuid: "task-001",
    content: "Hello",
    author: { type: "user", uuid: "user-001", name: "Dev" },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  });

  it("should return comments unchanged when no agent authors", async () => {
    const comments = [makeComment()];
    const result = await resolveAgentOwners(comments);

    expect(result).toHaveLength(1);
    expect(result[0].author.owner).toBeUndefined();
    expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
  });

  it("should resolve agent owner from Agent + User tables", async () => {
    const comments = [
      makeComment({ author: { type: "agent", uuid: "agent-001", name: "Bot" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-001", ownerUuid: "owner-001" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: "owner-001", name: "Alice", email: "alice@test.com" },
    ]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toEqual({ uuid: "owner-001", name: "Alice" });
    expect(mockPrisma.agent.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it("should handle agent without owner", async () => {
    const comments = [
      makeComment({ author: { type: "agent", uuid: "agent-002", name: "Bot2" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-002", ownerUuid: null },
    ]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toBeUndefined();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("should batch resolve multiple agents in 2 queries", async () => {
    const comments = [
      makeComment({ uuid: "c1", author: { type: "agent", uuid: "agent-a", name: "BotA" } }),
      makeComment({ uuid: "c2", author: { type: "user", uuid: "user-001", name: "Dev" } }),
      makeComment({ uuid: "c3", author: { type: "agent", uuid: "agent-b", name: "BotB" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-a", ownerUuid: "owner-x" },
      { uuid: "agent-b", ownerUuid: "owner-x" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: "owner-x", name: "Shared Owner", email: "shared@test.com" },
    ]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toEqual({ uuid: "owner-x", name: "Shared Owner" });
    expect(result[1].author.owner).toBeUndefined();
    expect(result[2].author.owner).toEqual({ uuid: "owner-x", name: "Shared Owner" });
    expect(mockPrisma.agent.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it("should use email as fallback when owner name is null", async () => {
    const comments = [
      makeComment({ author: { type: "agent", uuid: "agent-003", name: "Bot3" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-003", ownerUuid: "owner-002" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: "owner-002", name: null, email: "fallback@test.com" },
    ]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toEqual({ uuid: "owner-002", name: "fallback@test.com" });
  });

  it("should use 'Unknown' when both name and email are null", async () => {
    const comments = [
      makeComment({ author: { type: "agent", uuid: "agent-004", name: "Bot4" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-004", ownerUuid: "owner-003" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: "owner-003", name: null, email: null },
    ]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toEqual({ uuid: "owner-003", name: "Unknown" });
  });

  it("should skip owner when agent exists but ownerUuid user not found in DB", async () => {
    const comments = [
      makeComment({ author: { type: "agent", uuid: "agent-005", name: "Bot5" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-005", ownerUuid: "nonexistent-owner" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toBeUndefined();
  });

  it("should deduplicate agent UUIDs", async () => {
    const comments = [
      makeComment({ uuid: "c1", author: { type: "agent", uuid: "agent-same", name: "Bot" } }),
      makeComment({ uuid: "c2", author: { type: "agent", uuid: "agent-same", name: "Bot" } }),
    ];
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-same", ownerUuid: "owner-dedup" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: "owner-dedup", name: "Dedup Owner", email: "d@test.com" },
    ]);

    const result = await resolveAgentOwners(comments);

    expect(result[0].author.owner).toEqual({ uuid: "owner-dedup", name: "Dedup Owner" });
    expect(result[1].author.owner).toEqual({ uuid: "owner-dedup", name: "Dedup Owner" });
    // Only 1 agent query despite 2 comments with same agent
    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ["agent-same"] } },
      select: { uuid: true, ownerUuid: true },
    });
  });
});
