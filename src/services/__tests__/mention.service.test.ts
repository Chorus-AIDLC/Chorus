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
    // Agent-liveness enrichment (searchMentionables): online via connections,
    // activeCount via execution groupBy.
    daemonConnection: {
      findMany: vi.fn(),
    },
    daemonExecution: {
      groupBy: vi.fn(),
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
  // Default liveness enrichment to "no connections / no executions" so existing
  // searchMentionables tests (which return agents) don't hit undefined mocks.
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);
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
    // Online-first ordering: agents (even offline, rank 1) sort ahead of users
    // (rank 2). AliceBot has no online connection in this test, so it is an
    // offline agent and still ranks above the user.
    expect(results[0]).toEqual(
      expect.objectContaining({
        type: "agent",
        uuid: AGENT_UUID,
        name: "AliceBot",
      })
    );
    expect(results[1]).toEqual(
      expect.objectContaining({
        type: "user",
        uuid: USER_UUID,
        name: "Alice",
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

describe("searchMentionables — agent liveness enrichment", () => {
  const FRESH = new Date(); // within STALE_THRESHOLD_MS
  const STALE = new Date(Date.now() - 10 * 60_000); // 10 min ago → stale

  it("marks an agent online iff it has an effectively-online connection, and reports activeCount (search branch)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_UUID, name: "AliceBot", roles: ["pm_agent"] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: AGENT_UUID, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([
      { agentUuid: AGENT_UUID, _count: { _all: 3 } },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "alice",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    const agent = results.find((r) => r.type === "agent")!;
    expect(agent.online).toBe(true);
    expect(agent.activeCount).toBe(3);

    // Both liveness queries are companyUuid-scoped over the agent uuid set.
    expect(mockPrisma.daemonConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid: COMPANY_UUID, agentUuid: { in: [AGENT_UUID] } },
      })
    );
    const gb = mockPrisma.daemonExecution.groupBy.mock.calls[0][0];
    expect(gb.by).toEqual(["agentUuid"]);
    expect(gb.where.companyUuid).toBe(COMPANY_UUID);
    expect(gb.where.agentUuid).toEqual({ in: [AGENT_UUID] });
    expect(gb.where.status).toEqual({ in: ["running", "queued"] });
  });

  it("enriches agents in the EMPTY-query branch too (the popup-just-opened case)", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_UUID, name: "MyBot", roles: ["developer_agent"] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: AGENT_UUID, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([
      { agentUuid: AGENT_UUID, _count: { _all: 1 } },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(results).toHaveLength(1);
    expect(results[0].online).toBe(true);
    expect(results[0].activeCount).toBe(1);
    // Liveness WAS resolved even though the user-search branch never ran.
    expect(mockPrisma.daemonConnection.findMany).toHaveBeenCalledTimes(1);
  });

  it("treats a stale connection as offline and forces activeCount to 0 (coherent with online)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_UUID, name: "StaleBot", roles: [] },
    ]);
    // Only connection is stale → not effectively online.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: AGENT_UUID, status: "online", lastSeenAt: STALE },
    ]);
    // Even if execution rows exist, an offline agent must report 0.
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([
      { agentUuid: AGENT_UUID, _count: { _all: 5 } },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "stale",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    const agent = results.find((r) => r.type === "agent")!;
    expect(agent.online).toBe(false);
    expect(agent.activeCount).toBe(0);
  });

  it("reports online with activeCount 0 when the agent has a live connection but no active executions", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_UUID, name: "IdleBot", roles: [] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: AGENT_UUID, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([]); // no active rows

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "idle",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    const agent = results.find((r) => r.type === "agent")!;
    expect(agent.online).toBe(true);
    expect(agent.activeCount).toBe(0);
  });

  it("does NOT enrich user candidates and issues NO liveness query when there are no agents", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: USER_UUID, name: "Alice", email: "alice@example.com", avatarUrl: null },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([]); // no agents match

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "alice",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    const user = results.find((r) => r.type === "user")!;
    expect(user.online).toBeUndefined();
    expect(user.activeCount).toBeUndefined();
    // Cheap empty path: zero agent candidates ⇒ no liveness/count query at all.
    expect(mockPrisma.daemonConnection.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.daemonExecution.groupBy).not.toHaveBeenCalled();
  });
});

describe("searchMentionables — online-first ordering", () => {
  const FRESH = new Date(); // within STALE_THRESHOLD_MS

  // Distinct, valid hex UUIDs for multi-candidate scenarios.
  const A1 = "a1a1a1a1-0000-0000-0000-000000000001";
  const A2 = "a2a2a2a2-0000-0000-0000-000000000002";
  const A3 = "a3a3a3a3-0000-0000-0000-000000000003";
  const U1 = "b1b1b1b1-0000-0000-0000-000000000001";
  const U2 = "b2b2b2b2-0000-0000-0000-000000000002";
  const U3 = "b3b3b3b3-0000-0000-0000-000000000003";
  const U4 = "b4b4b4b4-0000-0000-0000-000000000004";
  const U5 = "b5b5b5b5-0000-0000-0000-000000000005";

  // Scenario 1 (§5.1): online agent on top of an offline agent and a user.
  it("places an online agent above an offline agent and a user", async () => {
    // DB returns users first, then agents (current insertion order).
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: U1, name: "Carol", email: "carol@example.com", avatarUrl: null },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: A1, name: "OnlineBot", roles: [] },
      { uuid: A2, name: "OfflineBot", roles: [] },
    ]);
    // Only A1 has a fresh online connection.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: A1, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "o",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(results.map((r) => ({ type: r.type, uuid: r.uuid }))).toEqual([
      { type: "agent", uuid: A1 }, // online agent
      { type: "agent", uuid: A2 }, // offline agent
      { type: "user", uuid: U1 }, // user last
    ]);
  });

  // Scenario 2 (§5.2): among online agents, idle (lower activeCount) first.
  it("orders online agents by activeCount ascending (idle first)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    // Busy agent returned BEFORE the idle one by the DB.
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: A1, name: "BusyBot", roles: [] },
      { uuid: A2, name: "IdleBot", roles: [] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: A1, status: "online", lastSeenAt: FRESH },
      { agentUuid: A2, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([
      { agentUuid: A1, _count: { _all: 2 } }, // busy
      // A2 has no active executions → activeCount 0
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "bot",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(results.map((r) => r.uuid)).toEqual([A2, A1]); // idle (0) before busy (2)
    expect(results[0].activeCount).toBe(0);
    expect(results[1].activeCount).toBe(2);
  });

  // Scenario 3 (§5.3): equal activeCount → name ascending tie-break.
  it("tie-breaks online agents with equal activeCount by name ascending", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    // DB returns Zeta before Alpha; both idle.
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: A1, name: "Zeta", roles: [] },
      { uuid: A2, name: "Alpha", roles: [] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: A1, status: "online", lastSeenAt: FRESH },
      { agentUuid: A2, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "a",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(results.map((r) => r.name)).toEqual(["Alpha", "Zeta"]);
  });

  // Scenario 4 (§5.4) — CORE REGRESSION: reserved slot for online agent.
  // limit=2, 5 matching users (returned first by DB) + 1 online agent.
  // The online agent must SURVIVE the slice and sit at index 0.
  it("keeps an online agent at index 0 even when many users match and limit is small", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: U1, name: "User1", email: "u1@example.com", avatarUrl: null },
      { uuid: U2, name: "User2", email: "u2@example.com", avatarUrl: null },
      { uuid: U3, name: "User3", email: "u3@example.com", avatarUrl: null },
      { uuid: U4, name: "User4", email: "u4@example.com", avatarUrl: null },
      { uuid: U5, name: "User5", email: "u5@example.com", avatarUrl: null },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: A1, name: "OnlineBot", roles: [] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: A1, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "user",
      actorType: "user",
      actorUuid: ACTOR_UUID,
      limit: 2,
    });

    expect(results).toHaveLength(2);
    // Online agent reserved the top slot despite 5 users matching first.
    expect(results[0]).toEqual(
      expect.objectContaining({ type: "agent", uuid: A1, online: true })
    );
    expect(results.some((r) => r.type === "agent" && r.uuid === A1)).toBe(true);
    // Agent candidate pool is widened to effectiveLimit (not effectiveLimit - users.length).
    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 })
    );
  });

  // Scenario 5 (§5.5): empty-query branch — an online agent that is NOT the most
  // recently created still gets surfaced to the top of the display.
  it("surfaces an online agent in the empty-query branch even if it is not newest", async () => {
    // orderBy createdAt desc → newest first. Newest two are offline; the online
    // one (A3) is older and would previously have been at the bottom / cut.
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: A1, name: "NewestBot", roles: [] },
      { uuid: A2, name: "MiddleBot", roles: [] },
      { uuid: A3, name: "OlderOnlineBot", roles: [] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: A3, status: "online", lastSeenAt: FRESH },
    ]);
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    // Empty-query is agent-only; online agent climbs to the front.
    expect(results[0]).toEqual(
      expect.objectContaining({ type: "agent", uuid: A3, online: true })
    );
    // Offline agents keep their DB (createdAt desc) order after the online one.
    expect(results.map((r) => r.uuid)).toEqual([A3, A1, A2]);
    // Candidate pool was widened to effectiveLimit so a non-newest online agent
    // can be considered (default limit 10 here).
    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });

  // Scenario 6 (§5.6): same-rank stability — offline agents and users keep
  // their original relative order (stable sort regression).
  it("preserves stable order among same-rank offline agents and among users", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { uuid: U1, name: "Ursula", email: "u1@example.com", avatarUrl: null },
      { uuid: U2, name: "Aaron", email: "u2@example.com", avatarUrl: null },
    ]);
    // Two offline agents, neither online → both rank 1, keep DB order.
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: A1, name: "ZebraBot", roles: [] },
      { uuid: A2, name: "AntBot", roles: [] },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]); // all offline
    mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "a",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    // Offline agents (rank 1) come before users (rank 2); within each rank the
    // DB / match insertion order is preserved (no name reordering off-rank).
    expect(results.map((r) => ({ type: r.type, uuid: r.uuid }))).toEqual([
      { type: "agent", uuid: A1 }, // ZebraBot kept before AntBot (stable)
      { type: "agent", uuid: A2 },
      { type: "user", uuid: U1 }, // Ursula kept before Aaron (stable)
      { type: "user", uuid: U2 },
    ]);
  });
});
