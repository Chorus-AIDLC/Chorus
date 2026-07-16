import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted) =====
// This suite covers the pin-cwd-before-wake Part 2a additions: searchMentionables'
// optional entity context (entityType/entityUuid) and the enrichIdeaContext
// helper it delegates to. Both the shared lineage resolver (dynamically imported
// by enrichIdeaContext to break the module cycle) and the two uuid-resolver
// helpers are mocked so the annotation logic is asserted in isolation.
//
// KEY CONTRACT (fixed after live testing): enrichIdeaContext keys on the
// resolver's `directIdeaUuid` (the idea the comment attaches to — for an idea
// entity, ITSELF, never its lineage parent/root), NOT `rootIdeaUuid`. The
// child-vs-root regression test below pins this: a derived child idea with no
// assignee must NOT inherit its pinned lineage root's pin.

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
// enrichIdeaContext pulls resolveRootIdea in via a lazy `await import(...)` to
// break the module cycle; vi.mock intercepts the dynamic import too.
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: (...args: unknown[]) => mockResolveRootIdea(...args),
}));

import {
  enrichIdeaContext,
  searchMentionables,
  type Mentionable,
} from "@/services/mention.service";

// ===== Test Data (UUIDs must be valid hex) =====

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const ACTOR_UUID = "33333333-3333-3333-3333-333333333333";
const USER_UUID = "44444444-4444-4444-4444-444444444444";
// AGENT_G is the direct idea's assignee (owning) agent; AGENT_H is a different agent.
const AGENT_G = "aaaaaaaa-1111-1111-1111-111111111111";
const AGENT_H = "bbbbbbbb-2222-2222-2222-222222222222";
// The AgentInstance.uuid the direct idea is pinned to (assigneeUuid when instance-pinned).
const INSTANCE_A = "cccccccc-3333-3333-3333-333333333333";
// A child idea (the comment's DIRECT idea) and its distinct lineage ROOT.
const DIRECT_IDEA_UUID = "dddddddd-4444-4444-4444-444444444444";
const ROOT_IDEA_UUID = "ffffffff-6666-6666-6666-666666666666";
const TASK_UUID = "eeeeeeee-5555-5555-5555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPreferences.mockResolvedValue({ mentioned: true });
  // Default liveness enrichment to "no connections / no executions" so the search
  // path (which returns agents) never hits an undefined mock.
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);
});

describe("enrichIdeaContext (pin-cwd-before-wake, Part 2a)", () => {
  it("annotates the instance-pinned DIRECT idea's assignee agent with the pin, and marks a different agent isIdeaAssignee:false with no pin", async () => {
    // Direct idea is instance-pinned to INSTANCE_A, owned by AGENT_G. (directIdeaUuid === rootIdeaUuid here.)
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: DIRECT_IDEA_UUID,
      directIdeaUuid: DIRECT_IDEA_UUID,
    });
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
    await enrichIdeaContext(COMPANY_UUID, results, "task", TASK_UUID);

    // (a) assignee agent → isIdeaAssignee:true + ideaPin{host,cwd,agentInstanceUuid}
    expect(results[0].isIdeaAssignee).toBe(true);
    expect(results[0].ideaPin).toEqual({
      host: "Laptop-Q3",
      cwd: "/home/u/dev/chorus",
      // The pin's durable handle is the AgentInstance uuid (the idea's assigneeUuid).
      agentInstanceUuid: INSTANCE_A,
    });
    // (b) a different agent → isIdeaAssignee:false, no pin
    expect(results[1].isIdeaAssignee).toBe(false);
    expect(results[1].ideaPin).toBeUndefined();

    // Company-scoped resolve + a single idea read scoped to (uuid, companyUuid) keyed on the DIRECT idea.
    expect(mockResolveRootIdea).toHaveBeenCalledWith(COMPANY_UUID, "task", TASK_UUID);
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: DIRECT_IDEA_UUID, companyUuid: COMPANY_UUID } }),
    );
    // Bounded: exactly one lineage resolve + one owning-agent resolve + one place lookup.
    expect(mockResolveRootIdea).toHaveBeenCalledTimes(1);
    expect(mockResolveAssigneeInstanceInfo).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: an unassigned child idea does NOT inherit its pinned lineage root's pin (keys on directIdeaUuid, not rootIdeaUuid)", async () => {
    // The comment is on a DERIVED child idea (DIRECT_IDEA_UUID) whose lineage root
    // (ROOT_IDEA_UUID) is pinned to AGENT_G, but the child idea ITSELF is unassigned.
    // enrichIdeaContext must read the DIRECT (child) idea's assignee — empty — and
    // annotate NOTHING, so the mention falls back to normal picker behavior instead
    // of auto-inheriting the root's pin. (This is the live-testing bug being fixed.)
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: ROOT_IDEA_UUID,
      directIdeaUuid: DIRECT_IDEA_UUID,
    });
    // The DIRECT (child) idea has no assignee.
    mockPrisma.idea.findFirst.mockResolvedValue({
      assigneeType: null,
      assigneeUuid: null,
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(null);

    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_G, name: "G" },
      { type: "agent", uuid: AGENT_H, name: "H" },
    ];
    await enrichIdeaContext(COMPANY_UUID, results, "idea", DIRECT_IDEA_UUID);

    // The idea read is keyed on the DIRECT (child) idea, NOT the lineage root.
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: DIRECT_IDEA_UUID, companyUuid: COMPANY_UUID } }),
    );
    // No candidate is the child idea's assignee (it has none) → no inherited pin.
    // Even AGENT_G, which owns the pinned ROOT, gets no pin.
    expect(results[0].isIdeaAssignee).toBe(false);
    expect(results[0].ideaPin).toBeUndefined();
    expect(results[1].isIdeaAssignee).toBe(false);
    expect(results[1].ideaPin).toBeUndefined();
    // The place lookup never runs (child is not instance-pinned).
    expect(mockResolveAssigneeInstanceInfo).not.toHaveBeenCalled();
  });

  it("marks the assignee agent isIdeaAssignee:true with NO pin when the direct idea is a bare agent (not instance-pinned)", async () => {
    // Direct idea assigned to bare agent G — no instance pin.
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: DIRECT_IDEA_UUID,
      directIdeaUuid: DIRECT_IDEA_UUID,
    });
    mockPrisma.idea.findFirst.mockResolvedValue({
      assigneeType: "agent",
      assigneeUuid: AGENT_G,
    });
    mockResolveAssigneeAgentUuid.mockResolvedValue(AGENT_G);

    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_G, name: "G" },
      { type: "agent", uuid: AGENT_H, name: "H" },
    ];
    await enrichIdeaContext(COMPANY_UUID, results, "task", TASK_UUID);

    expect(results[0].isIdeaAssignee).toBe(true);
    expect(results[0].ideaPin).toBeUndefined();
    expect(results[1].isIdeaAssignee).toBe(false);
    expect(results[1].ideaPin).toBeUndefined();
    // The place lookup is gated on the instance-pinned case — never runs for a bare agent.
    expect(mockResolveAssigneeInstanceInfo).not.toHaveBeenCalled();
  });

  it("does no resolve and adds no annotation when there are no agent candidates (cheap path)", async () => {
    const results: Mentionable[] = [{ type: "user", uuid: USER_UUID, name: "Alice" }];
    await enrichIdeaContext(COMPANY_UUID, results, "task", TASK_UUID);

    expect(mockResolveRootIdea).not.toHaveBeenCalled();
    expect(results[0].isIdeaAssignee).toBeUndefined();
    expect(results[0].ideaPin).toBeUndefined();
  });

  it("adds no annotation when the entity has no idea ancestor (null directIdeaUuid)", async () => {
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: null, directIdeaUuid: null });

    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_G, name: "G" },
      { type: "agent", uuid: AGENT_H, name: "H" },
    ];
    await enrichIdeaContext(COMPANY_UUID, results, "document", TASK_UUID);

    expect(results[0].isIdeaAssignee).toBeUndefined();
    expect(results[0].ideaPin).toBeUndefined();
    expect(results[1].isIdeaAssignee).toBeUndefined();
    expect(results[1].ideaPin).toBeUndefined();
    // Bailed after the null resolve — no idea read, no assignee resolve.
    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled();
    expect(mockResolveAssigneeAgentUuid).not.toHaveBeenCalled();
  });

  it("never annotates user candidates", async () => {
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: DIRECT_IDEA_UUID,
      directIdeaUuid: DIRECT_IDEA_UUID,
    });
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
    await enrichIdeaContext(COMPANY_UUID, results, "idea", DIRECT_IDEA_UUID);

    expect(results[0].isIdeaAssignee).toBeUndefined();
    expect(results[0].ideaPin).toBeUndefined();
    expect(results[1].isIdeaAssignee).toBe(true);
    expect(results[1].ideaPin).toBeDefined();
  });
});

describe("searchMentionables — entity context threading (pin-cwd-before-wake, Part 2a)", () => {
  it("annotates the returned agent candidates when entityType + entityUuid are supplied", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_G, name: "G", roles: [] },
      { uuid: AGENT_H, name: "H", roles: [] },
    ]);
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: DIRECT_IDEA_UUID,
      directIdeaUuid: DIRECT_IDEA_UUID,
    });
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
    expect(g.isIdeaAssignee).toBe(true);
    expect(g.ideaPin).toEqual({
      host: "Laptop-Q3",
      cwd: "/home/u/dev/chorus",
      agentInstanceUuid: INSTANCE_A,
    });
    expect(h.isIdeaAssignee).toBe(false);
    expect(h.ideaPin).toBeUndefined();
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
    expect(results[0].isIdeaAssignee).toBeUndefined();
    expect(results[0].ideaPin).toBeUndefined();
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
    expect(results[0].isIdeaAssignee).toBeUndefined();
  });
});
