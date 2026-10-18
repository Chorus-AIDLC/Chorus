import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  user: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  agent: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  idea: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  proposal: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  task: { create: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/services/mention.service", () => ({}));

import { listIdeas } from "@/services/idea.service";
import { getProposal, getProposalsByIdeaUuid, listProposals } from "@/services/proposal.service";
import { createTasksFromProposal } from "@/services/task.service";

const companyUuid = "tenant";
const projectUuid = "authorized-project";
const timestamp = new Date("2020-01-01T00:00:00Z");
const params = { companyUuid, projectUuid, skip: 0, take: 30 };
let seed = "current-seed";

function proposal(overrides = {}) {
  return {
    companyUuid, projectUuid, uuid: "proposal", title: "Proposal", description: null,
    inputType: "idea", inputUuids: ["idea"], documentDrafts: null, taskDrafts: null,
    status: "approved", createdByType: "user", createdByUuid: "shared",
    reviewedByUuid: "shared", reviewNote: "Approved", reviewedAt: timestamp,
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function idea(overrides = {}) {
  return {
    companyUuid, projectUuid, uuid: "idea", title: "Idea", content: null, attachments: null,
    status: "open", isContainer: false, parentUuid: null, createdByUuid: "shared",
    assigneeType: "user", assigneeUuid: "shared", assignedByType: "user", assignedByUuid: "shared",
    assignedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

type IdentityQuery = { where: { companyUuid: string; uuid: { in: string[] } } };

beforeEach(() => {
  vi.resetAllMocks();
  seed = "current-seed";
  database.user.findMany.mockImplementation(async ({ where }: IdentityQuery) => [
    { uuid: "shared", companyUuid, name: "Human", email: "human@example.com", avatarSeed: seed },
    { uuid: "foreign", companyUuid: "other-tenant", name: "Private", avatarSeed: "private-seed" },
    { uuid: "unrelated", companyUuid, name: "Not returned", avatarSeed: "unrelated-seed" },
  ].filter(user => user.companyUuid === where.companyUuid && where.uuid.in.includes(user.uuid)));
  database.agent.findMany.mockImplementation(async ({ where }: IdentityQuery) => [
    { uuid: "shared", companyUuid, name: "Agent" },
    { uuid: "agent-only", companyUuid, name: "Legacy Agent" },
  ].filter(agent => agent.companyUuid === where.companyUuid && where.uuid.in.includes(agent.uuid)));
  database.proposal.findMany.mockResolvedValue([]);
  database.proposal.count.mockResolvedValue(0);
  database.idea.findMany.mockResolvedValue([]);
  database.idea.count.mockResolvedValue(0);
  database.idea.groupBy.mockResolvedValue([]);
});

function expectBatchedIdentities(userUuids: string[], agentUuids: string[]) {
  expect(database.user.findMany).toHaveBeenCalledExactlyOnceWith({
    where: { companyUuid, uuid: { in: userUuids } },
    select: { uuid: true, name: true, email: true, avatarSeed: true },
  });
  expect(database.agent.findMany).toHaveBeenCalledExactlyOnceWith({
    where: { companyUuid, uuid: { in: agentUuids } },
    select: { uuid: true, name: true },
  });
  expect(database.user.findFirst).not.toHaveBeenCalled();
  expect(database.user.findUnique).not.toHaveBeenCalled();
  expect(database.agent.findFirst).not.toHaveBeenCalled();
  expect(database.agent.findUnique).not.toHaveBeenCalled();
}

describe("proposal lists resolve current avatar identities once per list", () => {
  it("regresses the five-proposal repeated human creator probe without querying agents", async () => {
    database.proposal.findMany.mockResolvedValue(Array.from({ length: 5 }, () => proposal({ reviewedByUuid: null })));
    const result = await listProposals(params);
    expect(result.proposals.map(row => row.createdBy?.avatarSeed)).toEqual(Array(5).fill(seed));
    expect(database.user.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { companyUuid, uuid: { in: ["shared"] } },
      select: { uuid: true, name: true, email: true, avatarSeed: true },
    });
    expect(database.agent.findMany).not.toHaveBeenCalled();
  });

  it.each([1, 5, 30])("deduplicates creators and reviewers across %i proposals", async count => {
    database.proposal.findMany.mockResolvedValue(Array.from({ length: count }, (_, index) => proposal({ uuid: `proposal-${index}` })));
    const result = await listProposals(params);
    expect(result.proposals).toHaveLength(count);
    for (const row of result.proposals) {
      expect(row.createdBy).toMatchObject({ type: "user", avatarSeed: seed });
      expect(row.review?.reviewedBy.avatarSeed).toBe(seed);
    }
    expectBatchedIdentities(["shared"], ["shared"]);
    expect(database.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyUuid, projectUuid }, skip: 0, take: 30 }));
  });

  it.each(["project", "idea"])("keeps actor types distinct without retrying unresolved actors in the %s list", async scope => {
    database.proposal.findMany.mockResolvedValue([
      proposal(), proposal({ createdByType: "agent" }),
      proposal({ createdByUuid: "foreign", reviewedByUuid: "missing" }),
      proposal({ createdByUuid: "missing", reviewedByUuid: "agent-only" }),
    ]);
    const proposals = scope === "project"
      ? (await listProposals(params)).proposals
      : await getProposalsByIdeaUuid(companyUuid, projectUuid, "idea");
    expect(proposals[0].createdBy).toEqual({ type: "user", uuid: "shared", name: "Human", avatarSeed: seed });
    expect(proposals[1].createdBy).toEqual({ type: "agent", uuid: "shared", name: "Agent" });
    expect(proposals[2].createdBy).toBeNull();
    expect(proposals[2].review).toBeNull();
    expect(proposals[3].createdBy).toBeNull();
    expect(proposals[3].review?.reviewedBy).toEqual({ type: "agent", uuid: "agent-only", name: "Legacy Agent" });
    expectBatchedIdentities(["shared", "foreign", "missing", "agent-only"], ["shared", "missing", "agent-only"]);
  });

  it("batches only proposals matching the idea and refreshes historical creators", async () => {
    database.proposal.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, () => proposal()),
      proposal({ inputUuids: ["other-idea"], createdByUuid: "unrelated", reviewedByUuid: "unrelated" }),
    ]);
    const first = await getProposalsByIdeaUuid(companyUuid, projectUuid, "idea");
    expect(first).toHaveLength(5);
    expect(first[0].createdBy?.avatarSeed).toBe(seed);
    expectBatchedIdentities(["shared"], ["shared"]);
    seed = "newly-saved-seed";
    const second = await getProposalsByIdeaUuid(companyUuid, projectUuid, "idea");
    expect(second[0].createdBy?.avatarSeed).toBe(seed);
    expect(database.user.findMany).toHaveBeenCalledTimes(2);
    expect(database.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyUuid, projectUuid } }));
  });

  it("preserves the single-resource formatter path", async () => {
    database.proposal.findFirst.mockResolvedValue(proposal());
    const result = await getProposal(companyUuid, "proposal");
    expect(result?.createdBy?.avatarSeed).toBe(seed);
    expect(result?.review?.reviewedBy.avatarSeed).toBe(seed);
    expect(database.user.findMany).toHaveBeenCalledTimes(2);
    expect(database.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { uuid: "proposal", companyUuid } }));
  });
});

describe("idea lists share identities across all author roles", () => {
  it.each([1, 5, 30])("deduplicates creators, assignees and assigners across %i ideas", async count => {
    database.idea.findMany.mockResolvedValue(Array.from({ length: count }, (_, index) => idea({ uuid: `idea-${index}` })));
    const result = await listIdeas(params);
    expect(result.ideas).toHaveLength(count);
    for (const row of result.ideas) {
      expect(row.createdBy?.avatarSeed).toBe(seed);
      expect(row.assignee?.avatarSeed).toBe(seed);
      expect(row.assignee?.assignedBy?.avatarSeed).toBe(seed);
    }
    expectBatchedIdentities(["shared"], ["shared"]);
    expect(database.idea.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyUuid, projectUuid }, skip: 0, take: 30 }));
  });

  it("preserves typed and legacy attribution without cross-type or cross-tenant seed fallback", async () => {
    database.idea.findMany.mockResolvedValue([
      idea(),
      idea({ assigneeType: "agent", assignedByType: "agent" }),
      idea({ createdByUuid: "agent-only", assignedByType: null, assignedByUuid: "agent-only" }),
      idea({ createdByUuid: "foreign", assigneeUuid: "foreign" }),
      idea({ createdByUuid: "missing", assignedByUuid: "missing" }),
      idea({ assignedByType: null }),
    ]);
    const { ideas } = await listIdeas(params);
    expect(ideas[0].assignee?.avatarSeed).toBe(seed);
    expect(ideas[1].assignee).toMatchObject({ type: "agent", name: "Agent", assignedBy: { type: "agent", name: "Agent" } });
    expect(ideas[1].assignee).not.toHaveProperty("avatarSeed");
    expect(ideas[1].assignee?.assignedBy).not.toHaveProperty("avatarSeed");
    expect(ideas[2].createdBy).toEqual({ type: "agent", uuid: "agent-only", name: "Legacy Agent" });
    expect(ideas[2].assignee?.assignedBy).toEqual(ideas[2].createdBy);
    expect(ideas[3].createdBy).toBeNull();
    expect(ideas[3].assignee).toBeNull();
    expect(ideas[4].createdBy).toBeNull();
    expect(ideas[4].assignee?.assignedBy).toBeNull();
    expect(ideas[5].assignee?.assignedBy?.avatarSeed).toBe(seed);
    expectBatchedIdentities(["shared", "agent-only", "foreign", "missing"], ["shared", "agent-only", "foreign", "missing"]);
  });

  it("does not query identities for empty or unrelated lists", async () => {
    await listIdeas(params);
    await listProposals(params);
    database.proposal.findMany.mockResolvedValue([proposal({ inputUuids: ["other-idea"] })]);
    expect(await getProposalsByIdeaUuid(companyUuid, projectUuid, "idea")).toEqual([]);
    expect(database.user.findMany).not.toHaveBeenCalled();
    expect(database.agent.findMany).not.toHaveBeenCalled();
  });
});

describe("batch-created task response identities", () => {
  it("reuses the existing task batch formatter rather than resolving each creator", async () => {
    let createdCount = 0;
    database.task.create.mockImplementation(async ({ data }) => ({
      ...data, uuid: `task-${createdCount++}`, assigneeType: null, assigneeUuid: null,
      assignedAt: null, assignedByType: null, assignedByUuid: null,
      createdAt: timestamp, updatedAt: timestamp,
    }));
    const result = await createTasksFromProposal(companyUuid, projectUuid, "proposal", "shared",
      Array.from({ length: 5 }, (_, index) => ({ uuid: `draft-${index}`, title: `Task ${index}` })));
    expect(result.tasks).toHaveLength(5);
    for (const row of result.tasks) expect(row.createdBy?.avatarSeed).toBe(seed);
    expect(result.draftToTaskUuidMap.get("draft-3")).toBe("task-3");
    expect(database.user.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { companyUuid, uuid: { in: ["shared"] } },
      select: { uuid: true, name: true, email: true, avatarSeed: true },
    });
    expect(database.agent.findMany).not.toHaveBeenCalled();
    expect(database.user.findUnique).not.toHaveBeenCalled();
  });
});
