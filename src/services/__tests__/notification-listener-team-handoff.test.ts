import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orchestrators: vi.fn(),
  createBatch: vi.fn(),
  prisma: {
    task: { findUnique: vi.fn(async () => ({ title: "Build it" })) },
    proposal: { findUnique: vi.fn(async () => ({ title: "Plan" })) },
    idea: { findUnique: vi.fn() },
    document: { findUnique: vi.fn() },
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

  it("ignores unrelated events and never notifies the orchestrator about its own action", async () => {
    await notifyIdeaTeamHandoff(event({ action: "status_changed", value: { status: "in_progress" } }));
    await notifyIdeaTeamHandoff(event({ action: "assigned" }));
    expect(mocks.orchestrators).not.toHaveBeenCalled();
    await notifyIdeaTeamHandoff(event({ actorUuid: "orchestrator" }));
    expect(mocks.createBatch).not.toHaveBeenCalled();
  });

  it("does nothing for unmanaged work and swallows lookup failures", async () => {
    mocks.orchestrators.mockResolvedValueOnce([]);
    await notifyIdeaTeamHandoff(event());
    mocks.orchestrators.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyIdeaTeamHandoff(event())).resolves.toBeUndefined();
    expect(mocks.createBatch).not.toHaveBeenCalled();
  });
});
