import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma, mockGetActorName, mockGetPreferences, mockCreateBatch } = vi.hoisted(() => ({
  mockPrisma: {
    mention: {
      createMany: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    agent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
    },
    comment: {
      findUnique: vi.fn(),
    },
  },
  mockGetActorName: vi.fn().mockResolvedValue("Test Actor"),
  mockGetPreferences: vi.fn().mockResolvedValue({ mentioned: true }),
  mockCreateBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/uuid-resolver", () => ({
  getActorName: mockGetActorName,
}));
vi.mock("@/services/notification.service", () => ({
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  createBatch: (...args: unknown[]) => mockCreateBatch(...args),
}));

import { createMentions, searchMentionables } from "@/services/mention.service";

// ===== Test Data (UUIDs must be valid hex for mention regex to match) =====

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const ACTOR_UUID = "33333333-3333-3333-3333-333333333333";
const USER_UUID = "44444444-4444-4444-4444-444444444444";
const AGENT_UUID = "55555555-5555-5555-5555-555555555555";
const SOURCE_UUID = "66666666-6666-6666-6666-666666666666";

// ===== Tests =====

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPreferences.mockResolvedValue({ mentioned: true });
});

describe("createMentions", () => {
  it("should parse, validate, create records, and send notifications", async () => {
    const content = `Hello @[Alice](user:${USER_UUID}) and @[Bot](agent:${AGENT_UUID})!`;

    mockPrisma.user.findFirst.mockResolvedValue({ uuid: USER_UUID });
    mockPrisma.agent.findFirst.mockResolvedValue({ uuid: AGENT_UUID });
    mockPrisma.mention.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.project.findUnique.mockResolvedValue({
      uuid: PROJECT_UUID,
      name: "Test Project",
    });

    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "idea",
      sourceUuid: SOURCE_UUID,
      content,
      actorType: "user",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Idea",
    });

    // Verify mention records created
    expect(mockPrisma.mention.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          companyUuid: COMPANY_UUID,
          sourceType: "idea",
          sourceUuid: SOURCE_UUID,
          mentionedType: "user",
          mentionedUuid: USER_UUID,
        }),
        expect.objectContaining({
          mentionedType: "agent",
          mentionedUuid: AGENT_UUID,
        }),
      ]),
    });

    // Verify notifications created
    expect(mockGetPreferences).toHaveBeenCalledTimes(2);
    expect(mockCreateBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          recipientType: "user",
          recipientUuid: USER_UUID,
          action: "mentioned",
        }),
        expect.objectContaining({
          recipientType: "agent",
          recipientUuid: AGENT_UUID,
          action: "mentioned",
        }),
      ])
    );
  });

  it("should skip if content has no mentions", async () => {
    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "idea",
      sourceUuid: SOURCE_UUID,
      content: "No mentions here.",
      actorType: "user",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Idea",
    });

    expect(mockPrisma.mention.createMany).not.toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it("should filter out self-mentions", async () => {
    const content = `I @[Me](user:${ACTOR_UUID}) did this.`;

    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "idea",
      sourceUuid: SOURCE_UUID,
      content,
      actorType: "user",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Idea",
    });

    expect(mockPrisma.mention.createMany).not.toHaveBeenCalled();
  });

  it("should skip mentions for targets that do not exist in company", async () => {
    const content = `@[Ghost](user:${USER_UUID}) does not exist`;

    mockPrisma.user.findFirst.mockResolvedValue(null);

    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "idea",
      sourceUuid: SOURCE_UUID,
      content,
      actorType: "agent",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Idea",
    });

    expect(mockPrisma.mention.createMany).not.toHaveBeenCalled();
  });

  it("should skip notifications when preference is disabled", async () => {
    const content = `@[Alice](user:${USER_UUID}) check this`;

    mockPrisma.user.findFirst.mockResolvedValue({ uuid: USER_UUID });
    mockPrisma.mention.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.project.findUnique.mockResolvedValue({
      uuid: PROJECT_UUID,
      name: "Test Project",
    });
    mockGetPreferences.mockResolvedValue({ mentioned: false });

    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "idea",
      sourceUuid: SOURCE_UUID,
      content,
      actorType: "agent",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Idea",
    });

    // Mentions created, but no notifications
    expect(mockPrisma.mention.createMany).toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it("should resolve comment parent entity for notification when sourceType is comment", async () => {
    const content = `@[Alice](user:${USER_UUID}) see this`;

    mockPrisma.user.findFirst.mockResolvedValue({ uuid: USER_UUID });
    mockPrisma.mention.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.project.findUnique.mockResolvedValue({
      uuid: PROJECT_UUID,
      name: "Test Project",
    });
    mockPrisma.comment.findUnique.mockResolvedValue({
      targetType: "task",
      targetUuid: "aabbccdd-1234-5678-abcd-ef1234567890",
    });

    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "comment",
      sourceUuid: SOURCE_UUID,
      content,
      actorType: "agent",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Task",
    });

    // Notification should reference the task, not the comment
    expect(mockCreateBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "task",
          entityUuid: "aabbccdd-1234-5678-abcd-ef1234567890",
        }),
      ])
    );
  });
});

describe("searchMentionables", () => {
  it("should return users and agents matching query for user caller", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: USER_UUID, name: "Alice", email: "alice@example.com", avatarUrl: null },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_UUID, name: "AliceBot", roles: ["pm_agent"] },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "alice",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(
      expect.objectContaining({
        type: "user",
        uuid: USER_UUID,
        name: "Alice",
      })
    );
    expect(results[1]).toEqual(
      expect.objectContaining({
        type: "agent",
        uuid: AGENT_UUID,
        name: "AliceBot",
      })
    );

    // Verify agent query is scoped to actorUuid (owner)
    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid: COMPANY_UUID,
          ownerUuid: ACTOR_UUID,
        }),
      })
    );
  });

  it("should return only own agents for empty query", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_UUID, name: "MyBot", roles: ["developer_agent"] },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("agent");
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("should scope agents by ownerUuid for agent caller", async () => {
    const ownerUuid = "77777777-7777-7777-7777-777777777777";

    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([]);

    await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "bot",
      actorType: "agent",
      actorUuid: ACTOR_UUID,
      ownerUuid,
    });

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerUuid,
        }),
      })
    );
  });

  it("should enforce max limit of 50", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([]);

    await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "test",
      actorType: "user",
      actorUuid: ACTOR_UUID,
      limit: 100,
    });

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
      })
    );
  });
});
