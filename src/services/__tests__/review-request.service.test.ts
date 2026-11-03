import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockCreateComment, mockCreateActivity, mockDirectIdea, mockFilter, mockDelegate } = vi.hoisted(() => ({
  mockPrisma: {
    task: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() },
    idea: { findFirst: vi.fn() },
    agent: { findFirst: vi.fn() },
    agentInstance: { findFirst: vi.fn() },
  },
  mockCreateComment: vi.fn(),
  mockCreateActivity: vi.fn(),
  mockDirectIdea: vi.fn(),
  mockFilter: vi.fn(),
  mockDelegate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/services/comment.service", () => ({ createComment: mockCreateComment }));
vi.mock("@/services/activity.service", () => ({ createActivity: mockCreateActivity }));
vi.mock("@/services/lineage.service", () => ({ resolveDirectIdeaUuid: mockDirectIdea }));
vi.mock("@/services/project-access.service", () => ({ filterRecipientsByProjectAccess: mockFilter }));
vi.mock("@/services/idea-team.service", () => ({ getIdeaTeamProductDelegate: mockDelegate }));

import { requestReview, ReviewRequestError } from "@/services/review-request.service";

const COMPANY = "c0000000-0000-0000-0000-000000000000";
const PROJECT = "p0000000-0000-0000-0000-000000000000";
const IDEA = "i0000000-0000-0000-0000-000000000000";
const TASK = "t0000000-0000-0000-0000-000000000000";
const ORCH = "o0000000-0000-0000-0000-000000000000";
const DEV = "d0000000-0000-0000-0000-000000000000";
const PRODUCT = "a0000000-0000-0000-0000-000000000000";
const names: Record<string, string> = { [ORCH]: "Clay", [DEV]: "Leo", [PRODUCT]: "Pam" };

const base = { companyUuid: COMPANY, actorUuid: ORCH, targetType: "task" as const, targetUuid: TASK, reviewerUuid: DEV, round: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.task.findFirst.mockResolvedValue({ projectUuid: PROJECT, title: "T1", assigneeType: "agent", assigneeUuid: DEV });
  mockPrisma.proposal.findFirst.mockResolvedValue({ projectUuid: PROJECT, title: "P1" });
  mockPrisma.idea.findFirst.mockResolvedValue({ projectUuid: PROJECT, title: "I1", assigneeType: "agent", assigneeUuid: ORCH });
  mockPrisma.agent.findFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) =>
    names[where.uuid] ? { uuid: where.uuid, name: names[where.uuid] } : null);
  mockDirectIdea.mockResolvedValue(IDEA);
  mockFilter.mockImplementation(async (_c: string, _p: string, r: unknown[]) => r);
  mockCreateComment.mockResolvedValue({ uuid: "comment-1", reviewDelivered: true });
  mockDelegate.mockResolvedValue(null);
});

describe("requestReview", () => {
  it("posts the rendered envelope and anchors only the named reviewer", async () => {
    const result = await requestReview({ ...base, note: "Check AC-1." });
    const call = mockCreateComment.mock.calls[0][0];
    expect(call.content.split("\n")[0]).toBe("Team review request — task, round 1");
    expect(call.content).toContain(`Reviewer: @[Leo](agent:${DEV})`);
    expect(call.content).toContain(`PASS / PASS WITH NOTES: Clay (agent ${ORCH})`);
    expect(call.content).toContain(`FAIL: Leo (agent ${DEV}), the task developer`);
    expect(call.content).toContain("Check AC-1.");
    expect(call.reviewAnchor).toEqual({ agentUuid: DEV, sessionAnchorHint: `review:task:${TASK}` });
    expect(mockCreateActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: "review_requested", value: expect.objectContaining({ kind: "task", round: 1, reviewerUuid: DEV }),
    }));
    expect(result).toMatchObject({ commentUuid: "comment-1", sessionId: `review:task:${TASK}` });
  });

  it.each([["proposal", "proposal", "review:proposal:"], ["idea", "code", "review:idea:"]] as const)(
    "maps %s targets to the %s envelope", async (targetType, kind, prefix) => {
      await requestReview({ ...base, targetType, targetUuid: IDEA, round: 2 });
      const call = mockCreateComment.mock.calls[0][0];
      expect(call.content.split("\n")[0]).toBe(`Team review request — ${kind}, round 2`);
      expect(call.reviewAnchor.sessionAnchorHint).toBe(`${prefix}${IDEA}`);
    });

  it("resolves an agent_instance task assignee to its logical developer", async () => {
    mockPrisma.task.findFirst.mockResolvedValue({ projectUuid: PROJECT, title: "T1", assigneeType: "agent_instance", assigneeUuid: "inst-1" });
    mockPrisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: DEV });
    await requestReview(base);
    expect(mockCreateComment.mock.calls[0][0].content).toContain(`FAIL: Leo (agent ${DEV})`);
  });

  it.each([
    ["round 0", { round: 0 }, "round must be"],
    ["round 4", { round: 4 }, "round must be"],
    ["self review", { reviewerUuid: ORCH }, "different agent"],
    ["unknown reviewer", { reviewerUuid: "x0000000-0000-0000-0000-000000000000" }, "reviewer agent"],
  ])("rejects %s visibly without posting", async (_label, patch, message) => {
    await expect(requestReview({ ...base, ...patch })).rejects.toThrow(message);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("rejects unknown targets, targets without Idea lineage, and reviewers without project access", async () => {
    mockPrisma.task.findFirst.mockResolvedValueOnce(null);
    await expect(requestReview(base)).rejects.toBeInstanceOf(ReviewRequestError);
    mockDirectIdea.mockResolvedValueOnce(null);
    await expect(requestReview(base)).rejects.toThrow("no direct Idea");
    mockFilter.mockResolvedValueOnce([]);
    await expect(requestReview(base)).rejects.toThrow("no access");
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("sends a delegated proposal FAIL to the current product delegate", async () => {
    mockDelegate.mockResolvedValue(PRODUCT);
    await requestReview({ ...base, targetType: "proposal", targetUuid: "prop-1" });
    expect(mockCreateComment.mock.calls[0][0].content).toContain(`FAIL: Pam (agent ${PRODUCT}), the product delegate`);
  });

  it("sends an undelegated proposal FAIL to the orchestrator", async () => {
    await requestReview({ ...base, targetType: "proposal", targetUuid: "prop-1" });
    expect(mockCreateComment.mock.calls[0][0].content).toContain(`FAIL: Clay (agent ${ORCH}), the orchestrator`);
  });

  it("rejects unresolved recipients instead of inventing them", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ projectUuid: PROJECT, title: "I1", assigneeType: null, assigneeUuid: null });
    await expect(requestReview(base)).rejects.toThrow("no agent orchestrator");
    mockPrisma.task.findFirst.mockResolvedValueOnce({ projectUuid: PROJECT, title: "T1", assigneeType: null, assigneeUuid: null });
    await expect(requestReview(base)).rejects.toThrow("no agent developer");
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("never reports success when the reviewer was not notified", async () => {
    mockCreateComment.mockResolvedValue({ uuid: "comment-2", reviewDelivered: false });
    await expect(requestReview(base)).rejects.toThrow("could not be notified");
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});
