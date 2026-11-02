import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orchestrators: vi.fn(),
  createBatch: vi.fn(),
  prisma: {
    task: { findUnique: vi.fn(async () => ({ title: "Build it" })), count: vi.fn() },
    proposal: { findUnique: vi.fn(async () => ({ title: "Plan" })), findMany: vi.fn() },
    idea: { findUnique: vi.fn() },
    document: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn(async () => null) },
    agent: { findUnique: vi.fn(async () => ({ name: "Dev" })) },
    project: { findFirst: vi.fn(async () => ({ name: "Project" })) },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { on: vi.fn(), emitChange: vi.fn() } }));
vi.mock("@/services/notification.service", () => ({ createBatch: mocks.createBatch, getPreferences: vi.fn() }));
vi.mock("@/services/idea-team.service", () => ({ getIdeaTeamOrchestrators: mocks.orchestrators }));
vi.mock("@/services/project-access.service", () => ({ filterRecipientsByProjectAccess: vi.fn(async (_c: string, _p: string, recipients: unknown[]) => recipients) }));

import { notifyIdeaTeamHandoff } from "@/services/notification-listener";

const event = (overrides: Record<string, unknown> = {}) => ({
  uuid: "activity", companyUuid: "company", projectUuid: "project", targetType: "task", targetUuid: "task",
  actorType: "agent", actorUuid: "developer", action: "submitted", ...overrides,
});

describe("Idea Team lifecycle handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orchestrators.mockResolvedValue([{ ideaUuid: "idea", agentUuid: "orchestrator" }]);
    mocks.prisma.task.count.mockResolvedValue(0);
    mocks.prisma.proposal.findMany.mockResolvedValue([{ uuid: "proposal" }, { uuid: "other-proposal" }]);
    mocks.prisma.document.findMany.mockResolvedValue([]);
  });

  it.each([
    [{}],
    [{ action: "status_changed", value: { status: "to_verify" } }],
    [{ targetType: "proposal", targetUuid: "proposal", action: "submitted" }],
    [{ targetType: "proposal", targetUuid: "proposal", action: "approved", actorType: "user", actorUuid: "human" }],
  ])("wakes the orchestrator with a mention-shaped notification: %o", async (overrides) => {
    await notifyIdeaTeamHandoff(event(overrides));
    expect(mocks.createBatch).toHaveBeenCalledWith([expect.objectContaining({
      recipientType: "agent", recipientUuid: "orchestrator", action: "mentioned", message: expect.stringContaining("chorus_get_idea_team_context"),
    })]);
  });

  it("routes proposal review with the human / YOLO approval rule and no last-task lookup", async () => {
    await notifyIdeaTeamHandoff(event({ targetType: "proposal", targetUuid: "proposal" }));
    const message = mocks.createBatch.mock.calls[0][0][0].message;
    expect(message).toContain("chorus_recommend_team_agent({ideaUuid, role:'review', proposalUuid:'proposal'})");
    expect(message).toContain("A human approves");
    expect(message).toContain("only under human-requested YOLO for this Idea");
    expect(message).toContain("current-round PASS or PASS WITH NOTES VERDICT");
    expect(message).not.toContain("whole-Idea code review");
    expect(mocks.prisma.task.count).not.toHaveBeenCalled();
    expect(mocks.prisma.proposal.findMany).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { action: "status_changed", value: { status: "to_verify" } },
    { action: "status_changed", value: { to: "to_verify" } },
  ])("routes task review and starts whole-Idea review when all other tasks are ready: %o", async (overrides) => {
    await notifyIdeaTeamHandoff(event(overrides));
    const message = mocks.createBatch.mock.calls[0][0][0].message;
    expect(message).toContain("chorus_recommend_team_agent({ideaUuid, role:'review', taskUuid:'task'})");
    expect(message).toContain("verify only after a current-round PASS or PASS WITH NOTES VERDICT");
    expect(message).toContain("whole-Idea code review via chorus_recommend_team_agent({ideaUuid, role:'review'}) without a taskUuid or proposalUuid target");
    expect(message).toContain("in parallel with task reviews");
    expect(message).toContain("not individual task verification");
    expect(mocks.prisma.proposal.findMany).toHaveBeenCalledWith({
      where: { companyUuid: "company", inputType: "idea", inputUuids: { array_contains: ["idea"] } }, select: { uuid: true },
    });
    expect(mocks.prisma.task.count).toHaveBeenCalledExactlyOnceWith({
      where: { companyUuid: "company", proposalUuid: { in: ["proposal", "other-proposal"] }, uuid: { not: "task" }, status: { notIn: ["to_verify", "done", "closed"] } },
    });
  });

  it("does not start whole-Idea review while another source proposal still has work", async () => {
    mocks.prisma.task.count.mockResolvedValue(1);
    await notifyIdeaTeamHandoff(event());
    const message = mocks.createBatch.mock.calls[0][0][0].message;
    expect(message).toContain("Route the task review");
    expect(message).not.toContain("whole-Idea code review");
  });

  it("includes document-input source proposals and their fix tasks without repeating cycles", async () => {
    mocks.prisma.proposal.findMany.mockResolvedValueOnce([{ uuid: "proposal" }])
      .mockResolvedValueOnce([{ uuid: "document-proposal" }])
      .mockResolvedValueOnce([{ uuid: "proposal" }, { uuid: "document-proposal" }]);
    mocks.prisma.document.findMany.mockResolvedValueOnce([{ uuid: "document" }]).mockResolvedValueOnce([{ uuid: "next-document" }]);
    await notifyIdeaTeamHandoff(event());
    expect(mocks.prisma.proposal.findMany).toHaveBeenNthCalledWith(2, {
      where: { companyUuid: "company", inputType: "document", OR: [{ inputUuids: { array_contains: ["document"] } }] }, select: { uuid: true },
    });
    expect(mocks.prisma.task.count).toHaveBeenCalledExactlyOnceWith({
      where: { companyUuid: "company", proposalUuid: { in: ["proposal", "document-proposal"] }, uuid: { not: "task" }, status: { notIn: ["to_verify", "done", "closed"] } },
    });
  });

  it("checks each linked Idea separately", async () => {
    mocks.orchestrators.mockResolvedValue([{ ideaUuid: "idea", agentUuid: "orchestrator" }, { ideaUuid: "idea-2", agentUuid: "orchestrator" }]);
    mocks.prisma.task.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await notifyIdeaTeamHandoff(event());
    const message = mocks.createBatch.mock.calls[0][0][0].message;
    expect(message).toContain("For Idea(s) idea, also start");
    expect(message).not.toContain("For Idea(s) idea, idea-2, also start");
    expect(mocks.prisma.task.count).toHaveBeenCalledTimes(2);
  });

  it("only sends each orchestrator the whole-review instructions for their own Ideas", async () => {
    mocks.orchestrators.mockResolvedValue([{ ideaUuid: "idea", agentUuid: "orchestrator" }, { ideaUuid: "idea-2", agentUuid: "other-orchestrator" }]);
    mocks.prisma.task.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await notifyIdeaTeamHandoff(event());
    const notifications = mocks.createBatch.mock.calls[0][0];
    expect(notifications[0].message).toContain("Team-managed Idea(s) idea:");
    expect(notifications[0].message).toContain("For Idea(s) idea, also start");
    expect(notifications[1].message).toContain("Team-managed Idea(s) idea-2:");
    expect(notifications[1].message).not.toContain("whole-Idea code review");
  });

  it("leaves proposal approval development routing unchanged", async () => {
    await notifyIdeaTeamHandoff(event({ targetType: "proposal", action: "approved" }));
    const message = mocks.createBatch.mock.calls[0][0][0].message;
    expect(message).toContain("assign development");
    expect(message).not.toContain("role:'review'");
    expect(mocks.prisma.task.count).not.toHaveBeenCalled();
  });

  it("ignores unrelated events and never notifies the orchestrator about its own action", async () => {
    await notifyIdeaTeamHandoff(event({ action: "status_changed", value: { status: "in_progress" } }));
    await notifyIdeaTeamHandoff(event({ action: "assigned" }));
    expect(mocks.orchestrators).not.toHaveBeenCalled();
    await notifyIdeaTeamHandoff(event({ actorUuid: "orchestrator" }));
    expect(mocks.createBatch).not.toHaveBeenCalled();
    expect(mocks.prisma.task.count).not.toHaveBeenCalled();
    expect(mocks.prisma.proposal.findMany).not.toHaveBeenCalled();
  });

  it("does nothing for unmanaged work and swallows lookup failures", async () => {
    mocks.orchestrators.mockResolvedValueOnce([]);
    await notifyIdeaTeamHandoff(event());
    mocks.orchestrators.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyIdeaTeamHandoff(event())).resolves.toBeUndefined();
    expect(mocks.createBatch).not.toHaveBeenCalled();
    expect(mocks.prisma.task.count).not.toHaveBeenCalled();
    expect(mocks.prisma.proposal.findMany).not.toHaveBeenCalled();
  });
});
