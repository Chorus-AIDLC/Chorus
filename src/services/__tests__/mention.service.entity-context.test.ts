import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted) =====
// This suite covers the pin-cwd-before-wake Part 2a additions: searchMentionables'
// optional entity context (entityType/entityUuid) and the enrichRootIdeaContext
// helper it delegates to. Both the shared root-idea resolver (dynamically imported
// by enrichRootIdeaContext to break the module cycle) and the two uuid-resolver
// helpers are mocked so the annotation logic is asserted in isolation.

const {
  mockPrisma,
  mockGetActorName,
  mockResolveAssigneeAgentUuid,
  mockResolveAssigneeInstanceInfo,
  mockGetPreferences,
  mockCreateBatch,
  mockResolveRootIdea,
} = vi.hoisted(() => ({
  mockPrisma: {
    mention: { createMany: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findFirst: vi.fn(), findMany: vi.fn() },
    project: { findUnique: vi.fn() },
    comment: { findUnique: vi.fn() },
    idea: { findFirst: vi.fn() },
    daemonConnection: { findMany: vi.fn() },
    daemonExecution: { groupBy: vi.fn() },
  },
  mockGetActorName: vi.fn().mockResolvedValue("Test Actor"),
  mockResolveAssigneeAgentUuid: vi.fn(),
  mockResolveAssigneeInstanceInfo: vi.fn(),
  mockGetPreferences: vi.fn().mockResolvedValue({ mentioned: true }),
  mockCreateBatch: vi.fn().mockResolvedValue([]),
  mockResolveRootIdea: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/uuid-resolver", () => ({
  getActorName: mockGetActorName,
  resolveAssigneeAgentUuid: (...args: unknown[]) => mockResolveAssigneeAgentUuid(...args),
  resolveAssigneeInstanceInfo: (...args: unknown[]) => mockResolveAssigneeInstanceInfo(...args),
}));
vi.mock("@/services/notification.service", () => ({
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  createBatch: (...args: unknown[]) => mockCreateBatch(...args),
}));
// enrichRootIdeaContext pulls resolveRootIdea in via a lazy `await import(...)` to
// break the module cycle; vi.mock intercepts the dynamic import too.
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: (...args: unknown[]) => mockResolveRootIdea(...args),
}));

import {
  enrichRootIdeaContext,
  searchMentionables,
  type Mentionable,
} from "@/services/mention.service";

// ===== Test Data (UUIDs must be valid hex) =====

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const ACTOR_UUID = "33333333-3333-3333-3333-333333333333";
const USER_UUID = "44444444-4444-4444-4444-444444444444";
// AGENT_G is the root idea's assignee (owning) agent; AGENT_H is a different agent.
const AGENT_G = "aaaaaaaa-1111-1111-1111-111111111111";
const AGENT_H = "bbbbbbbb-2222-2222-2222-222222222222";
// The AgentInstance.uuid the root idea is pinned to (assigneeUuid when instance-pinned).
const INSTANCE_A = "cccccccc-3333-3333-3333-333333333333";
const ROOT_IDEA_UUID = "dddddddd-4444-4444-4444-444444444444";
const TASK_UUID = "eeeeeeee-5555-5555-5555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPreferences.mockResolvedValue({ mentioned: true });
  // Default liveness enrichment to "no connections / no executions" so the search
  // path (which returns agents) never hits an undefined mock.
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);
});

describe("enrichRootIdeaContext (pin-cwd-before-wake, Part 2a)", () => {
  it("annotates the instance-pinned root idea's assignee agent with the pin, and marks a different agent isRootIdeaAssignee:false with no pin", async () => {
    // Root idea is instance-pinned to INSTANCE_A, owned by AGENT_G.
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: ROOT_IDEA_UUID });
    mockPrisma.idea.findFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE_A,
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(AGENT_G);
    mockResolveAssigneeInstanceInfo.mockResolvedValue({
      agentUuid: AGENT_G,
      host: "Laptop-Q3",
      cwd: "/home/u/dev/chorus",
    });

    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_G, name: "G" },
      { type: "agent", uuid: AGENT_H, name: "H" },
    ];
    await enrichRootIdeaContext(COMPANY_UUID, results, "task", TASK_UUID);

    // (a) assignee agent → isRootIdeaAssignee:true + rootIdeaPin{host,cwd,agentInstanceUuid}
    expect(results[0].isRootIdeaAssignee).toBe(true);
    expect(results[0].rootIdeaPin).toEqual({
      host: "Laptop-Q3",
      cwd: "/home/u/dev/chorus",
      // The pin's durable handle is the AgentInstance uuid (the idea's assigneeUuid).
      agentInstanceUuid: INSTANCE_A,
    });
    // (b) a different agent → isRootIdeaAssignee:false, no pin
    expect(results[1].isRootIdeaAssignee).toBe(false);
    expect(results[1].rootIdeaPin).toBeUndefined();

    // Company-scoped resolve + a single idea read scoped to (uuid, companyUuid).
    expect(mockResolveRootIdea).toHaveBeenCalledWith(COMPANY_UUID, "task", TASK_UUID);
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: ROOT_IDEA_UUID, companyUuid: COMPANY_UUID } }),
    );
    // Bounded: exactly one root-idea resolve + one owning-agent resolve + one place lookup.
    expect(mockResolveRootIdea).toHaveBeenCalledTimes(1);
    expect(mockResolveAssigneeInstanceInfo).toHaveBeenCalledTimes(1);
  });

  it("marks the assignee agent isRootIdeaAssignee:true with NO pin when the root idea is a bare agent (not instance-pinned)", async () => {
    // Root idea assigned to bare agent G — no instance pin.
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: ROOT_IDEA_UUID });
    mockPrisma.idea.findFirst.mockResolvedValue({
      assigneeType: "agent",
      assigneeUuid: AGENT_G,
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(AGENT_G);

    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_G, name: "G" },
      { type: "agent", uuid: AGENT_H, name: "H" },
    ];
    await enrichRootIdeaContext(COMPANY_UUID, results, "task", TASK_UUID);

    expect(results[0].isRootIdeaAssignee).toBe(true);
    expect(results[0].rootIdeaPin).toBeUndefined();
    expect(results[1].isRootIdeaAssignee).toBe(false);
    expect(results[1].rootIdeaPin).toBeUndefined();
    // The place lookup is gated on the instance-pinned case — never runs for a bare agent.
    expect(mockResolveAssigneeInstanceInfo).not.toHaveBeenCalled();
  });

  it("does no resolve and adds no annotation when there are no agent candidates (cheap path)", async () => {
    const results: Mentionable[] = [{ type: "user", uuid: USER_UUID, name: "Alice" }];
    await enrichRootIdeaContext(COMPANY_UUID, results, "task", TASK_UUID);

    expect(mockResolveRootIdea).not.toHaveBeenCalled();
    expect(results[0].isRootIdeaAssignee).toBeUndefined();
    expect(results[0].rootIdeaPin).toBeUndefined();
  });

  it("adds no annotation when the entity has no root idea (null rootIdeaUuid)", async () => {
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: null });

    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_G, name: "G" },
      { type: "agent", uuid: AGENT_H, name: "H" },
    ];
    await enrichRootIdeaContext(COMPANY_UUID, results, "document", TASK_UUID);

    expect(results[0].isRootIdeaAssignee).toBeUndefined();
    expect(results[0].rootIdeaPin).toBeUndefined();
    expect(results[1].isRootIdeaAssignee).toBeUndefined();
    expect(results[1].rootIdeaPin).toBeUndefined();
    // Bailed after the null resolve — no idea read, no assignee resolve.
    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled();
    expect(mockResolveAssigneeAgentUuid).not.toHaveBeenCalled();
  });

  it("never annotates user candidates", async () => {
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: ROOT_IDEA_UUID });
    mockPrisma.idea.findFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE_A,
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(AGENT_G);
    mockResolveAssigneeInstanceInfo.mockResolvedValue({
      agentUuid: AGENT_G,
      host: "H1",
      cwd: "/w",
    });

    const results: Mentionable[] = [
      { type: "user", uuid: USER_UUID, name: "Alice" },
      { type: "agent", uuid: AGENT_G, name: "G" },
    ];
    await enrichRootIdeaContext(COMPANY_UUID, results, "idea", ROOT_IDEA_UUID);

    expect(results[0].isRootIdeaAssignee).toBeUndefined();
    expect(results[0].rootIdeaPin).toBeUndefined();
    expect(results[1].isRootIdeaAssignee).toBe(true);
    expect(results[1].rootIdeaPin).toBeDefined();
  });
});

describe("searchMentionables — entity context threading (pin-cwd-before-wake, Part 2a)", () => {
  it("annotates the returned agent candidates when entityType + entityUuid are supplied", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_G, name: "G", roles: [] },
      { uuid: AGENT_H, name: "H", roles: [] },
    ]);
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: ROOT_IDEA_UUID });
    mockPrisma.idea.findFirst.mockResolvedValue({
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE_A,
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(AGENT_G);
    mockResolveAssigneeInstanceInfo.mockResolvedValue({
      agentUuid: AGENT_G,
      host: "Laptop-Q3",
      cwd: "/home/u/dev/chorus",
    });

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "g",
      actorType: "user",
      actorUuid: ACTOR_UUID,
      entityType: "task",
      entityUuid: TASK_UUID,
    });

    const g = results.find((r) => r.uuid === AGENT_G)!;
    const h = results.find((r) => r.uuid === AGENT_H)!;
    expect(g.isRootIdeaAssignee).toBe(true);
    expect(g.rootIdeaPin).toEqual({
      host: "Laptop-Q3",
      cwd: "/home/u/dev/chorus",
      agentInstanceUuid: INSTANCE_A,
    });
    expect(h.isRootIdeaAssignee).toBe(false);
    expect(h.rootIdeaPin).toBeUndefined();
    // The route threads the comment's target entity straight through, company-scoped.
    expect(mockResolveRootIdea).toHaveBeenCalledWith(COMPANY_UUID, "task", TASK_UUID);
  });

  it("leaves the search identical to before when no entity context is supplied", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_G, name: "G", roles: [] },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "g",
      actorType: "user",
      actorUuid: ACTOR_UUID,
    });

    expect(mockResolveRootIdea).not.toHaveBeenCalled();
    expect(results[0].isRootIdeaAssignee).toBeUndefined();
    expect(results[0].rootIdeaPin).toBeUndefined();
  });

  it("ignores a partial entity context (entityType without entityUuid) → no annotation, unchanged search", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_G, name: "G", roles: [] },
    ]);

    const results = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "g",
      actorType: "user",
      actorUuid: ACTOR_UUID,
      entityType: "task",
      // entityUuid deliberately omitted — either part alone is ignored.
    });

    expect(mockResolveRootIdea).not.toHaveBeenCalled();
    expect(results[0].isRootIdeaAssignee).toBeUndefined();
  });
});
