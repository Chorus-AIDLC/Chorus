import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    idea: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: vi.fn().mockResolvedValue(null),
  formatCreatedBy: vi.fn().mockResolvedValue({ type: "user", uuid: "u", name: "U" }),
}));
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/activity.service", () => ({
  createActivity: vi.fn().mockResolvedValue(undefined),
}));

import {
  computeDerivedStatus,
  getIdeaWithDerivedStatus,
  getIdeasWithDerivedStatus,
  getTrackerGroups,
} from "@/services/idea.service";

// ===== Test Data =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const PROJECT_UUID = "project-2222-2222-2222-222222222222";
const now = new Date("2026-01-15T10:00:00Z");

function makeIdea(uuid: string, status: string, elaborationStatus?: string | null) {
  return { uuid, title: `Idea ${uuid}`, status, elaborationStatus: elaborationStatus ?? null, createdAt: now, updatedAt: now };
}

function makeFullIdea(uuid: string, status: string, elaborationStatus?: string | null) {
  return {
    uuid,
    title: `Idea ${uuid}`,
    content: null,
    attachments: null,
    status,
    elaborationStatus: elaborationStatus ?? null,
    elaborationDepth: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    createdByUuid: "creator-uuid",
    createdAt: now,
    updatedAt: now,
    project: { uuid: PROJECT_UUID, name: "Test Project" },
  };
}

// ===== computeDerivedStatus (pure function tests) =====

describe("computeDerivedStatus", () => {
  it('maps legacy "completed" (normalizes to elaborated) with no proposal → in_progress/planning', () => {
    const result = computeDerivedStatus({ ideaStatus: "completed", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("planning");
  });

  it('maps legacy "closed" (normalizes to elaborated) with no proposal → in_progress/planning', () => {
    const result = computeDerivedStatus({ ideaStatus: "closed", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("planning");
  });

  it('maps "open" → todo/open', () => {
    const result = computeDerivedStatus({ ideaStatus: "open", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("todo");
    expect(result.badgeHint).toBe("open");
  });

  it('maps "elaborating" + pending_answers → human_conduct_required/answer_questions', () => {
    const r = computeDerivedStatus({ ideaStatus: "elaborating", elaborationStatus: "pending_answers", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(r.derivedStatus).toBe("human_conduct_required");
    expect(r.badgeHint).toBe("answer_questions");
  });

  it('maps "elaborating" + validating → in_progress/researching', () => {
    const r = computeDerivedStatus({ ideaStatus: "elaborating", elaborationStatus: "validating", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(r.derivedStatus).toBe("in_progress");
    expect(r.badgeHint).toBe("researching");
  });

  it('maps "elaborating" + no elaborationStatus → in_progress/researching', () => {
    const r = computeDerivedStatus({ ideaStatus: "elaborating", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(r.derivedStatus).toBe("in_progress");
    expect(r.badgeHint).toBe("researching");
  });

  it('maps legacy "proposal_created" (normalizes to elaborated) with pending proposal → human_conduct_required/review_proposal', () => {
    const result = computeDerivedStatus({ ideaStatus: "proposal_created", hasPendingProposal: true, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("review_proposal");
  });

  it('maps legacy "proposal_created" (normalizes to elaborated) without approved or pending proposal → in_progress/planning', () => {
    const result = computeDerivedStatus({ ideaStatus: "proposal_created", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("planning");
  });

  it('maps legacy "proposal_created" with approved proposal and mixed in_progress+to_verify → verify_work (any to_verify triggers)', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "to_verify", "done"],
    });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("verify_work");
  });

  it('maps legacy "proposal_created" with approved proposal and all done/to_verify → human_conduct_required/verify_work', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["to_verify", "done", "closed"],
    });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("verify_work");
  });

  it('maps legacy "proposal_created" with approved proposal and in_progress tasks (no to_verify) → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "done"],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps legacy "proposal_created" with approved proposal and all tasks done → done/done', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["done", "done"],
    });
    expect(result.derivedStatus).toBe("done");
    expect(result.badgeHint).toBe("done");
  });

  it('maps legacy "proposal_created" with approved proposal and only open tasks → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["open"],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps legacy "proposal_created" with approved proposal and no tasks → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: [],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps legacy "assigned" (normalizes to elaborating, no elaborationStatus) → in_progress/researching', () => {
    const result = computeDerivedStatus({ ideaStatus: "assigned", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("researching");
  });

  // ===== "elaborated" status — the primary post-elaboration state =====

  it('"elaborated" with approved proposal and incomplete tasks → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "open"],
    });
    // EXPECTED: should derive from task progress → in_progress/building
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('"elaborated" with approved proposal and all done tasks → done/done', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["done", "done"],
    });
    // EXPECTED: all tasks done → done/done
    expect(result.derivedStatus).toBe("done");
    expect(result.badgeHint).toBe("done");
  });

  it('"elaborated" with pending proposal → human_conduct_required/review_proposal', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: true,
      hasApprovedProposal: false,
      taskStatuses: [],
    });
    // EXPECTED: pending proposal → human_conduct_required/review_proposal
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("review_proposal");
  });

  it('"elaborated" with no proposal → in_progress/planning', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: false,
      taskStatuses: [],
    });
    // EXPECTED: no proposal yet → in_progress/planning
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("planning");
  });

  it('"elaborated" with approved proposal and to_verify tasks → human_conduct_required/verify_work', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["done", "to_verify"],
    });
    // EXPECTED: all finished with some to_verify → human_conduct_required/verify_work
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("verify_work");
  });

  // ===== verify_work trigger: ANY to_verify (not all must be finished) =====

  it('"elaborated" with approved proposal and mixed in_progress+to_verify → verify_work (any to_verify triggers)', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "to_verify", "done"],
    });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("verify_work");
  });

  it('"elaborated" with approved proposal and single to_verify among open tasks → verify_work', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["open", "to_verify", "open"],
    });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("verify_work");
  });

  it('"elaborated" with approved proposal and no to_verify, some in_progress → building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "elaborated",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "done", "open"],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps unknown status → todo/open', () => {
    const result = computeDerivedStatus({ ideaStatus: "some_unknown", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("todo");
    expect(result.badgeHint).toBe("open");
  });
});

// ===== getIdeasWithDerivedStatus (integration with prisma mocks) =====

describe("getIdeasWithDerivedStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns todo for open ideas", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "open")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].derivedStatus).toBe("todo");
    expect(result[0].badgeHint).toBe("open");
  });

  it("returns in_progress for elaborating ideas with validating status", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "elaborating", "validating")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("in_progress");
    expect(result[0].badgeHint).toBe("researching");
  });

  it("returns human_conduct_required for elaborating ideas with pending_answers", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "elaborating", "pending_answers")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("human_conduct_required");
    expect(result[0].badgeHint).toBe("answer_questions");
  });

  it("returns human_conduct_required for elaborated idea with pending proposal", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-1", status: "pending", inputUuids: ["idea-1"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("human_conduct_required");
    expect(result[0].badgeHint).toBe("review_proposal");
  });

  it("returns human_conduct_required for approved proposal with to_verify task", async () => {
    const proposalUuid = "proposal-aaa";
    const ideaUuid = "idea-1";

    mockPrisma.idea.findMany.mockResolvedValue([makeIdea(ideaUuid, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: proposalUuid, status: "approved", inputUuids: [ideaUuid], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid, status: "to_verify" },
      { proposalUuid, status: "done" },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("human_conduct_required");
    expect(result[0].badgeHint).toBe("verify_work");
    // Verify batch queries were used (not N+1)
    expect(mockPrisma.idea.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns planning for legacy completed ideas (normalizes to elaborated, no proposal)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "completed")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("in_progress");
    expect(result[0].badgeHint).toBe("planning");
  });

  it("returns planning for legacy closed ideas (normalizes to elaborated, no proposal)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "closed")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("in_progress");
    expect(result[0].badgeHint).toBe("planning");
  });

  it("uses the latest approved proposal when multiple exist for one idea", async () => {
    const ideaUuid = "idea-1";
    const oldProposalUuid = "proposal-old";
    const newProposalUuid = "proposal-new";

    mockPrisma.idea.findMany.mockResolvedValue([makeIdea(ideaUuid, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: newProposalUuid, status: "approved", inputUuids: [ideaUuid], createdAt: new Date("2026-02-01T00:00:00Z") },
      { uuid: oldProposalUuid, status: "approved", inputUuids: [ideaUuid], createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: newProposalUuid, status: "done" },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    // Should use the NEW proposal — all tasks done → done
    expect(result[0].derivedStatus).toBe("done");
    expect(result[0].badgeHint).toBe("done");
  });

  it("handles mixed statuses across multiple ideas", async () => {
    const proposalUuid = "proposal-x";

    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-open", "open"),
      makeIdea("idea-elab", "elaborating", "validating"),
      makeIdea("idea-elab-pending", "elaborating", "pending_answers"),
      makeIdea("idea-prop-pending", "elaborated"),
      makeIdea("idea-done-tasks", "elaborated"),
      makeIdea("idea-no-proposal", "elaborated"),
      makeIdea("idea-verify", "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: proposalUuid, status: "approved", inputUuids: ["idea-verify"], createdAt: now },
      { uuid: "proposal-done", status: "approved", inputUuids: ["idea-done-tasks"], createdAt: now },
      { uuid: "proposal-pending", status: "pending", inputUuids: ["idea-prop-pending"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid, status: "to_verify" },
      { proposalUuid: "proposal-done", status: "done" },
      { proposalUuid: "proposal-done", status: "done" },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    const statusMap = Object.fromEntries(result.map((r) => [r.uuid, r.derivedStatus]));
    expect(statusMap["idea-open"]).toBe("todo");
    expect(statusMap["idea-elab"]).toBe("in_progress");
    expect(statusMap["idea-elab-pending"]).toBe("human_conduct_required");
    expect(statusMap["idea-prop-pending"]).toBe("human_conduct_required");
    expect(statusMap["idea-done-tasks"]).toBe("done");
    expect(statusMap["idea-no-proposal"]).toBe("in_progress");
    expect(statusMap["idea-verify"]).toBe("human_conduct_required");

    const badgeMap = Object.fromEntries(result.map((r) => [r.uuid, r.badgeHint]));
    expect(badgeMap["idea-open"]).toBe("open");
    expect(badgeMap["idea-elab"]).toBe("researching");
    expect(badgeMap["idea-elab-pending"]).toBe("answer_questions");
    expect(badgeMap["idea-prop-pending"]).toBe("review_proposal");
    expect(badgeMap["idea-done-tasks"]).toBe("done");
    expect(badgeMap["idea-no-proposal"]).toBe("planning");
    expect(badgeMap["idea-verify"]).toBe("verify_work");
  });

  it("skips task query when no relevant proposals exist", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "open")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("handles proposal with non-array inputUuids gracefully", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-bad", status: "approved", inputUuids: "not-an-array", createdAt: now },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    // Should not crash; no valid proposal mapping → no approved, no pending → in_progress/planning
    expect(result[0].derivedStatus).toBe("in_progress");
    expect(result[0].badgeHint).toBe("planning");
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });
});

// ===== getIdeaWithDerivedStatus (single idea) =====

describe("getIdeaWithDerivedStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    const result = await getIdeaWithDerivedStatus(COMPANY_UUID, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns idea with derivedStatus and badgeHint for open idea", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeFullIdea("idea-1", "open"));
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    const result = await getIdeaWithDerivedStatus(COMPANY_UUID, "idea-1");

    expect(result).not.toBeNull();
    expect(result!.derivedStatus).toBe("todo");
    expect(result!.badgeHint).toBe("open");
    expect(result!.uuid).toBe("idea-1");
  });

  it("computes building when approved proposal has active tasks", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeFullIdea("idea-1", "elaborated"));
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-1", status: "approved" },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { status: "in_progress" },
      { status: "open" },
    ]);

    const result = await getIdeaWithDerivedStatus(COMPANY_UUID, "idea-1");

    expect(result!.derivedStatus).toBe("in_progress");
    expect(result!.badgeHint).toBe("building");
  });

  it("computes done when all tasks are done/closed", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeFullIdea("idea-1", "elaborated"));
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-1", status: "approved" },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { status: "done" },
      { status: "closed" },
    ]);

    const result = await getIdeaWithDerivedStatus(COMPANY_UUID, "idea-1");

    expect(result!.derivedStatus).toBe("done");
    expect(result!.badgeHint).toBe("done");
  });

  it("computes verify_work when any task is to_verify", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeFullIdea("idea-1", "elaborated"));
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-1", status: "approved" },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { status: "done" },
      { status: "to_verify" },
    ]);

    const result = await getIdeaWithDerivedStatus(COMPANY_UUID, "idea-1");

    expect(result!.derivedStatus).toBe("human_conduct_required");
    expect(result!.badgeHint).toBe("verify_work");
  });

  it("computes review_proposal when pending proposal exists", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeFullIdea("idea-1", "elaborated"));
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-1", status: "pending" },
    ]);

    const result = await getIdeaWithDerivedStatus(COMPANY_UUID, "idea-1");

    expect(result!.derivedStatus).toBe("human_conduct_required");
    expect(result!.badgeHint).toBe("review_proposal");
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("skips task query when no approved proposal", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeFullIdea("idea-1", "elaborated"));
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    await getIdeaWithDerivedStatus(COMPANY_UUID, "idea-1");

    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });
});

// ===== getTrackerGroups (grouping + formatting) =====

describe("getTrackerGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty groups when project has no ideas", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    const result = await getTrackerGroups(COMPANY_UUID, PROJECT_UUID);

    expect(result.groups.todo).toEqual([]);
    expect(result.groups.in_progress).toEqual([]);
    expect(result.groups.human_conduct_required).toEqual([]);
    expect(result.groups.done).toEqual([]);
    expect(result.counts.todo).toBe(0);
    expect(result.counts.in_progress).toBe(0);
    expect(result.counts.human_conduct_required).toBe(0);
    expect(result.counts.done).toBe(0);
  });

  it("legacy closed ideas normalize to elaborated (shown as in_progress/planning with no proposal)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-closed", "closed"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getTrackerGroups(COMPANY_UUID, PROJECT_UUID);

    // Legacy "closed" normalizes to "elaborated", which with no proposal becomes in_progress/planning
    const allItems = Object.values(result.groups).flat();
    expect(allItems).toHaveLength(1);
    expect(allItems[0].derivedStatus).toBe("in_progress");
    expect(allItems[0].badgeHint).toBe("planning");
  });

  it("groups ideas by derived status with correct counts", async () => {
    const proposalUuid = "proposal-approved";
    const doneProposalUuid = "proposal-done";

    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-open", "open"),
      makeIdea("idea-elab", "elaborating", "validating"),
      makeIdea("idea-pending", "elaborating", "pending_answers"),
      makeIdea("idea-done", "elaborated"),
      makeIdea("idea-building", "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: proposalUuid, status: "approved", inputUuids: ["idea-building"], createdAt: now },
      { uuid: doneProposalUuid, status: "approved", inputUuids: ["idea-done"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid, status: "in_progress" },
      { proposalUuid: doneProposalUuid, status: "done" },
      { proposalUuid: doneProposalUuid, status: "done" },
    ]);

    const result = await getTrackerGroups(COMPANY_UUID, PROJECT_UUID);

    expect(result.counts.todo).toBe(1);
    expect(result.counts.in_progress).toBe(2); // elaborating + building
    expect(result.counts.human_conduct_required).toBe(1); // pending_answers
    expect(result.counts.done).toBe(1);

    const allUuids = Object.values(result.groups).flat().map((i) => i.uuid);
    expect(allUuids).toHaveLength(5);
  });

  it("formats TrackerIdeaItem fields correctly", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "open")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    const result = await getTrackerGroups(COMPANY_UUID, PROJECT_UUID);

    const item = result.groups.todo[0];
    expect(item).toEqual({
      uuid: "idea-1",
      title: "Idea idea-1",
      status: "open",
      derivedStatus: "todo",
      badgeHint: "open",
      createdAt: now.toISOString(),
    });
  });

  it("places multiple ideas in the same group", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-a", "open"),
      makeIdea("idea-b", "open"),
      makeIdea("idea-c", "open"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    const result = await getTrackerGroups(COMPANY_UUID, PROJECT_UUID);

    expect(result.groups.todo).toHaveLength(3);
    expect(result.counts.todo).toBe(3);
  });
});
