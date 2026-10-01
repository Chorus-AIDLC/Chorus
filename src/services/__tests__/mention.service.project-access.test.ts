import { describe, it, expect, vi, beforeEach } from "vitest";

// Private-project isolation for @mentions (add-private-project-access, D4
// "Mentions"): targets without viewer access to the entity's project get no
// Mention row and no notification; entity-scoped mentionable search returns only
// member users + agents whose owner is a member. Uses the REAL
// project-access.filterRecipientsByProjectAccess over a mocked Prisma, so the
// membership / agent-owner resolution is exercised end to end.

// ===== Mocks (hoisted) =====

const { mockPrisma, mockGetPreferences, mockCreateBatch } = vi.hoisted(() => ({
  mockPrisma: {
    mention: { createMany: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findFirst: vi.fn(), findMany: vi.fn() },
    project: { findUnique: vi.fn(), findFirst: vi.fn() },
    projectMember: { findMany: vi.fn() },
    projectGroupMember: { findMany: vi.fn() },
    comment: { findUnique: vi.fn() },
    task: { findFirst: vi.fn() },
    daemonConnection: { findMany: vi.fn() },
    daemonExecution: { groupBy: vi.fn() },
    projectAgentCwdPreference: { findMany: vi.fn() },
    idea: { findFirst: vi.fn() },
  },
  mockGetPreferences: vi.fn(),
  mockCreateBatch: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/uuid-resolver", () => ({
  getActorName: vi.fn().mockResolvedValue("Test Actor"),
  resolveAssigneeAgentUuid: vi.fn().mockResolvedValue(null),
  resolveAssigneeInstanceInfo: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/notification.service", () => ({
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  createBatch: (...args: unknown[]) => mockCreateBatch(...args),
}));
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: vi.fn().mockResolvedValue({ rootIdeaUuid: null, directIdeaUuid: null }),
}));
vi.mock("@/services/project-agent-cwd.service", () => ({
  resolveProjectAgentCwdTarget: vi.fn().mockResolvedValue(null),
}));

import { createMentions, searchMentionables } from "@/services/mention.service";

// ===== Test Data =====

const COMPANY = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333"; // member user (author / searcher)
const MEMBER_USER = "44444444-4444-4444-4444-444444444444";
const OUTSIDER_USER = "45454545-4545-4545-4545-454545454545";
const MEMBER_AGENT = "55555555-5555-5555-5555-555555555555"; // owned by MEMBER_USER
const OUTSIDER_AGENT = "56565656-5656-5656-5656-565656565656"; // owned by OUTSIDER_USER
const ORPHAN_AGENT = "57575757-5757-5757-5757-575757575757"; // no owner
const SOURCE = "66666666-6666-6666-6666-666666666666";
const TASK = "77777777-7777-7777-7777-777777777777";

const OWNERS: Record<string, string | null> = {
  [MEMBER_AGENT]: MEMBER_USER,
  [OUTSIDER_AGENT]: OUTSIDER_USER,
  [ORPHAN_AGENT]: null,
};
const MEMBERS = new Set([ACTOR, MEMBER_USER]);

let visibility: "public" | "private" = "private";
let groupUuid: string | null = null;
const groupMembers = new Set<string>();
let userPool: { uuid: string; name: string; email: string; avatarUrl: null }[] = [];

function setupPrisma() {
  userPool = [
    { uuid: MEMBER_USER, name: "Member", email: "m@x.io", avatarUrl: null },
    { uuid: OUTSIDER_USER, name: "Outsider", email: "o@x.io", avatarUrl: null },
  ];
  mockPrisma.project.findFirst.mockImplementation(async () => ({ uuid: PROJECT, visibility, groupUuid }));
  mockPrisma.projectGroupMember.findMany.mockImplementation(async ({ where }: { where: { userUuid?: { in: string[] } } }) =>
    [...groupMembers].filter((u) => !where.userUuid || where.userUuid.in.includes(u)).map((userUuid) => ({ userUuid })),
  );
  mockPrisma.project.findUnique.mockResolvedValue({ name: "Secret Project" });
  mockPrisma.user.findFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) => ({
    uuid: where.uuid,
  }));
  mockPrisma.agent.findFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) => ({
    uuid: where.uuid,
  }));
  // agent.findMany serves both the mentionable search (name filter) and the
  // access filter's owner lookup (uuid IN).
  mockPrisma.agent.findMany.mockImplementation(
    async ({ where, take }: { where: { uuid?: { in: string[] }; ownerUuid?: string | { in: string[] } }; take?: number }) => {
      if (where.uuid?.in) {
        return where.uuid.in.map((uuid) => ({ uuid, ownerUuid: OWNERS[uuid] ?? null }));
      }
      const owner = where.ownerUuid;
      return [MEMBER_AGENT, OUTSIDER_AGENT, ORPHAN_AGENT]
        .filter((uuid) =>
          owner === undefined ? true
            : typeof owner === "string" ? OWNERS[uuid] === owner
            : owner.in.includes(OWNERS[uuid] ?? "__none__"))
        .slice(0, take ?? Infinity)
        .map((uuid) => ({ uuid, name: `agent-${uuid.slice(0, 2)}`, roles: [] }));
    },
  );
  // Serves both the private-project member list (projectUuid only) and the
  // access filter's batched membership check (userUuid IN).
  mockPrisma.projectMember.findMany.mockImplementation(
    async ({ where }: { where: { userUuid?: { in: string[] } } }) =>
      (where.userUuid ? where.userUuid.in.filter((u) => MEMBERS.has(u)) : [...MEMBERS]).map((userUuid) => ({ userUuid })),
  );
  // Honors `uuid IN` scoping and `take`, so a non-member flood can be modelled.
  mockPrisma.user.findMany.mockImplementation(
    async ({ where, take }: { where: { uuid?: { in: string[] } }; take?: number }) =>
      userPool
        .filter((u) => !where.uuid || where.uuid.in.includes(u.uuid))
        .slice(0, take ?? Infinity),
  );
  mockPrisma.comment.findUnique.mockResolvedValue({ targetType: "task", targetUuid: TASK });
  mockPrisma.task.findFirst.mockResolvedValue({ projectUuid: PROJECT });
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);
  mockPrisma.projectAgentCwdPreference.findMany.mockResolvedValue([]);
  mockGetPreferences.mockResolvedValue({ mentioned: true });
  mockCreateBatch.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  visibility = "private";
  groupUuid = null;
  groupMembers.clear();
  setupPrisma();
});

function mentionContent(...targets: Array<["user" | "agent", string]>): string {
  return targets.map(([type, uuid]) => `@[x](${type}:${uuid})`).join(" ") + " please look";
}

async function mention(...targets: Array<["user" | "agent", string]>) {
  await createMentions({
    companyUuid: COMPANY,
    sourceType: "comment",
    sourceUuid: SOURCE,
    content: mentionContent(...targets),
    actorType: "user",
    actorUuid: ACTOR,
    projectUuid: PROJECT,
    entityTitle: "Task",
  });
}

function mentionedUuids(): string[] {
  if (mockPrisma.mention.createMany.mock.calls.length === 0) return [];
  return mockPrisma.mention.createMany.mock.calls[0][0].data.map(
    (d: { mentionedUuid: string }) => d.mentionedUuid,
  );
}

function notifiedUuids(): string[] {
  if (mockCreateBatch.mock.calls.length === 0) return [];
  return mockCreateBatch.mock.calls[0][0].map((n: { recipientUuid: string }) => n.recipientUuid);
}

// ===== createMentions =====

describe("createMentions — private project isolation", () => {
  it("notifies group-only users and their agents, then drops them on revocation while retaining local members", async () => {
    groupUuid = "private-group";
    groupMembers.add(OUTSIDER_USER);
    await mention(["user", OUTSIDER_USER], ["agent", OUTSIDER_AGENT], ["user", MEMBER_USER]);
    expect(mentionedUuids()).toEqual([OUTSIDER_USER, OUTSIDER_AGENT, MEMBER_USER]);
    expect(notifiedUuids()).toEqual([OUTSIDER_USER, OUTSIDER_AGENT, MEMBER_USER]);
    vi.clearAllMocks();
    groupMembers.clear();
    await mention(["user", OUTSIDER_USER], ["agent", OUTSIDER_AGENT], ["user", MEMBER_USER]);
    expect(mentionedUuids()).toEqual([MEMBER_USER]);
    expect(notifiedUuids()).toEqual([MEMBER_USER]);
  });
  it("mentioning a non-member user creates no mention and no notification", async () => {
    await mention(["user", OUTSIDER_USER]);
    expect(mockPrisma.mention.createMany).not.toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it("mentioning an agent whose owner is a non-member creates no mention and no notification", async () => {
    await mention(["agent", OUTSIDER_AGENT]);
    expect(mockPrisma.mention.createMany).not.toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it("an ownerless agent cannot be mentioned in a private project", async () => {
    await mention(["agent", ORPHAN_AGENT]);
    expect(mockPrisma.mention.createMany).not.toHaveBeenCalled();
  });

  it("member user and agent-of-member are mentioned; outsiders in the same content are dropped without failing", async () => {
    await mention(
      ["user", MEMBER_USER],
      ["user", OUTSIDER_USER],
      ["agent", MEMBER_AGENT],
      ["agent", OUTSIDER_AGENT],
    );
    expect(mentionedUuids()).toEqual([MEMBER_USER, MEMBER_AGENT]);
    expect(notifiedUuids()).toEqual([MEMBER_USER, MEMBER_AGENT]);
  });

  it("batches the access check: one project, one agent-owner and one membership query", async () => {
    await mention(
      ["user", MEMBER_USER],
      ["user", OUTSIDER_USER],
      ["agent", MEMBER_AGENT],
      ["agent", OUTSIDER_AGENT],
    );
    expect(mockPrisma.project.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agent.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectMember.findMany).toHaveBeenCalledTimes(1);
  });

  it("public project: non-members are still mentioned (unchanged)", async () => {
    visibility = "public";
    await mention(["user", OUTSIDER_USER], ["agent", OUTSIDER_AGENT]);
    expect(mentionedUuids()).toEqual([OUTSIDER_USER, OUTSIDER_AGENT]);
    expect(notifiedUuids()).toEqual([OUTSIDER_USER, OUTSIDER_AGENT]);
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
  });
});

// ===== searchMentionables =====

describe("searchMentionables — entity-scoped private project filter", () => {
  async function search(extra: Partial<Parameters<typeof searchMentionables>[0]> = {}) {
    return searchMentionables({
      companyUuid: COMPANY,
      query: "a",
      actorType: "agent",
      actorUuid: "88888888-8888-8888-8888-888888888888",
      // No ownerUuid → agent search is not owner-scoped, so every agent is a candidate.
      ...extra,
    });
  }

  it("includes inherited members in the database candidate filter before applying the limit", async () => {
    groupUuid = "private-group";
    groupMembers.add(OUTSIDER_USER);
    const results = await search({ entityType: "task", entityUuid: TASK });
    expect(results.map((r) => r.uuid)).toEqual(expect.arrayContaining([MEMBER_USER, OUTSIDER_USER, MEMBER_AGENT, OUTSIDER_AGENT]));
    expect(results.map((r) => r.uuid)).not.toContain(ORPHAN_AGENT);
  });

  it("with entity context in a private project returns only members + agents owned by members", async () => {
    const results = await search({ entityType: "task", entityUuid: TASK });
    expect(results.map((r) => r.uuid).sort()).toEqual([MEMBER_AGENT, MEMBER_USER].sort());
    // Candidate queries are scoped to members in the database (before `take`).
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ uuid: { in: expect.arrayContaining([MEMBER_USER]) } }),
    }));
  });

  it("non-members cannot crowd members out of the capped result set", async () => {
    // 12 matching outsiders listed BEFORE the member; the UI asks for limit=10.
    userPool = [
      ...Array.from({ length: 12 }, (_, i) => ({
        uuid: `outsider-${i}`, name: `Alice ${i}`, email: `a${i}@x.io`, avatarUrl: null,
      })),
      { uuid: MEMBER_USER, name: "Alice Member", email: "m@x.io", avatarUrl: null },
    ];
    const results = await search({ query: "alice", limit: 10, entityType: "task", entityUuid: TASK });
    expect(results.map((r) => r.uuid)).toContain(MEMBER_USER);
    expect(results.some((r) => r.uuid.startsWith("outsider-"))).toBe(false);
  });

  it("empty-query branch with entity context is filtered too", async () => {
    // Empty query → only the caller-owner's agents; an outsider owner's agent is filtered out.
    const results = await search({
      query: "",
      ownerUuid: OUTSIDER_USER,
      entityType: "task",
      entityUuid: TASK,
    });
    expect(results).toEqual([]);
    const own = await search({
      query: "",
      ownerUuid: MEMBER_USER,
      entityType: "task",
      entityUuid: TASK,
    });
    expect(own.map((r) => r.uuid)).toEqual([MEMBER_AGENT]);
  });

  it("without entity context the search is unchanged (no access filtering)", async () => {
    const results = await search();
    expect(results.map((r) => r.uuid).sort()).toEqual(
      [MEMBER_AGENT, OUTSIDER_AGENT, ORPHAN_AGENT, MEMBER_USER, OUTSIDER_USER].sort(),
    );
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
  });

  it("with entity context in a public project the search is unchanged", async () => {
    visibility = "public";
    const results = await search({ entityType: "task", entityUuid: TASK });
    expect(results).toHaveLength(5);
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ uuid: expect.anything() }),
    }));
  });

  it("resolves the entity's project once per search", async () => {
    // User caller owning MEMBER_AGENT → project-fixed cwd enrichment runs too and
    // reuses the already-resolved project instead of re-resolving it.
    const results = await search({
      entityType: "task",
      entityUuid: TASK,
      actorType: "user",
      actorUuid: MEMBER_USER,
    });
    expect(results.map((r) => r.uuid)).toContain(MEMBER_AGENT);
    expect(mockPrisma.projectAgentCwdPreference.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.findFirst).toHaveBeenCalledTimes(1);
  });
});
