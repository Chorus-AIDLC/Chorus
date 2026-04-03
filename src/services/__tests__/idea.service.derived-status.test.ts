import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    idea: {
      findMany: vi.fn(),
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
  getIdeasWithDerivedStatus,
} from "@/services/idea.service";

// ===== Test Data =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const PROJECT_UUID = "project-2222-2222-2222-222222222222";
const now = new Date("2026-01-15T10:00:00Z");

function makeIdea(uuid: string, status: string, elaborationStatus?: string | null) {
  return { uuid, title: `Idea ${uuid}`, status, elaborationStatus: elaborationStatus ?? null, createdAt: now, updatedAt: now };
}

// ===== computeDerivedStatus (pure function tests) =====

describe("computeDerivedStatus", () => {
  it('maps "completed" → done/done', () => {
    const result = computeDerivedStatus({ ideaStatus: "completed", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("done");
    expect(result.badgeHint).toBe("done");
  });

  it('maps "closed" → closed/closed', () => {
    const result = computeDerivedStatus({ ideaStatus: "closed", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("closed");
    expect(result.badgeHint).toBe("closed");
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

  it('maps "proposal_created" with pending proposal → human_conduct_required/review_proposal', () => {
    const result = computeDerivedStatus({ ideaStatus: "proposal_created", hasPendingProposal: true, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("review_proposal");
  });

  it('maps "proposal_created" without approved or pending proposal → in_progress/planning', () => {
    const result = computeDerivedStatus({ ideaStatus: "proposal_created", hasPendingProposal: false, hasApprovedProposal: false, taskStatuses: [] });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("planning");
  });

  it('maps "proposal_created" with approved proposal and mixed in_progress+to_verify → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "to_verify", "done"],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps "proposal_created" with approved proposal and all done/to_verify → human_conduct_required/verify_work', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["to_verify", "done", "closed"],
    });
    expect(result.derivedStatus).toBe("human_conduct_required");
    expect(result.badgeHint).toBe("verify_work");
  });

  it('maps "proposal_created" with approved proposal and in_progress tasks → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["in_progress", "done"],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps "proposal_created" with approved proposal and all tasks done → done/done', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["done", "done"],
    });
    expect(result.derivedStatus).toBe("done");
    expect(result.badgeHint).toBe("done");
  });

  it('maps "proposal_created" with approved proposal and only open tasks → in_progress/building', () => {
    const result = computeDerivedStatus({
      ideaStatus: "proposal_created",
      hasPendingProposal: false,
      hasApprovedProposal: true,
      taskStatuses: ["open"],
    });
    expect(result.derivedStatus).toBe("in_progress");
    expect(result.badgeHint).toBe("building");
  });

  it('maps "proposal_created" with approved proposal and no tasks → in_progress/building', () => {
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

  it("returns human_conduct_required for proposal_created with pending proposal", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "proposal_created")]);
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

    mockPrisma.idea.findMany.mockResolvedValue([makeIdea(ideaUuid, "proposal_created")]);
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

  it("returns done for completed ideas", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "completed")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("done");
    expect(result[0].badgeHint).toBe("done");
  });

  it("returns closed for closed ideas", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "closed")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(result[0].derivedStatus).toBe("closed");
    expect(result[0].badgeHint).toBe("closed");
  });

  it("uses the latest approved proposal when multiple exist for one idea", async () => {
    const ideaUuid = "idea-1";
    const oldProposalUuid = "proposal-old";
    const newProposalUuid = "proposal-new";

    mockPrisma.idea.findMany.mockResolvedValue([makeIdea(ideaUuid, "proposal_created")]);
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
      makeIdea("idea-prop-pending", "proposal_created"),
      makeIdea("idea-done", "completed"),
      makeIdea("idea-closed", "closed"),
      makeIdea("idea-verify", "proposal_created"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: proposalUuid, status: "approved", inputUuids: ["idea-verify"], createdAt: now },
      { uuid: "proposal-pending", status: "pending", inputUuids: ["idea-prop-pending"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid, status: "to_verify" },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    const statusMap = Object.fromEntries(result.map((r) => [r.uuid, r.derivedStatus]));
    expect(statusMap["idea-open"]).toBe("todo");
    expect(statusMap["idea-elab"]).toBe("in_progress");
    expect(statusMap["idea-elab-pending"]).toBe("human_conduct_required");
    expect(statusMap["idea-prop-pending"]).toBe("human_conduct_required");
    expect(statusMap["idea-done"]).toBe("done");
    expect(statusMap["idea-closed"]).toBe("closed");
    expect(statusMap["idea-verify"]).toBe("human_conduct_required");

    const badgeMap = Object.fromEntries(result.map((r) => [r.uuid, r.badgeHint]));
    expect(badgeMap["idea-open"]).toBe("open");
    expect(badgeMap["idea-elab"]).toBe("researching");
    expect(badgeMap["idea-elab-pending"]).toBe("answer_questions");
    expect(badgeMap["idea-prop-pending"]).toBe("review_proposal");
    expect(badgeMap["idea-done"]).toBe("done");
    expect(badgeMap["idea-closed"]).toBe("closed");
    expect(badgeMap["idea-verify"]).toBe("verify_work");
  });

  it("skips task query when no relevant proposals exist", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "open")]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("handles proposal with non-array inputUuids gracefully", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", "proposal_created")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-bad", status: "approved", inputUuids: "not-an-array", createdAt: now },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY_UUID, PROJECT_UUID);

    // Should not crash; no valid proposal mapping → no approved, no pending → in_progress
    expect(result[0].derivedStatus).toBe("in_progress");
    expect(result[0].badgeHint).toBe("planning");
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });
});
