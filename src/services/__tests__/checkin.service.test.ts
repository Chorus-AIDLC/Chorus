import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted) =====

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agent: {
      update: vi.fn(),
    },
    idea: {
      findMany: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
    },
  },
}));

const { mockNotificationService } = vi.hoisted(() => ({
  mockNotificationService: {
    list: vi.fn(),
    markRead: vi.fn(),
    emitAgentCheckinIfFirst: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn(), emit: vi.fn() } }));
vi.mock("@/services/notification.service", () => mockNotificationService);

import { buildCheckinResponse } from "@/services/checkin.service";
import type { AuthContext } from "@/types/auth";

// ===== Test fixtures =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const AGENT_UUID = "agent-2222-2222-2222-222222222222";
const OWNER_UUID = "owner-3333-3333-3333-333333333333";
const PROJECT_A = "project-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "project-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const now = new Date("2026-04-23T10:00:00Z");

const auth: AuthContext = {
  type: "agent",
  companyUuid: COMPANY_UUID,
  actorUuid: AGENT_UUID,
  ownerUuid: OWNER_UUID,
  roles: ["developer"],
};

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    uuid: AGENT_UUID,
    name: "Dev Agent",
    roles: ["developer"],
    persona: null,
    systemPrompt: null,
    ownerUuid: OWNER_UUID,
    owner: { uuid: OWNER_UUID, name: "Owner User", email: "owner@example.com" },
    ...overrides,
  };
}

function makeIdea(
  uuid: string,
  projectUuid: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    uuid,
    title: `Idea ${uuid}`,
    status,
    elaborationStatus: null,
    projectUuid,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function emptyNotifications() {
  return { notifications: [], total: 0, unreadCount: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.agent.update.mockResolvedValue(makeAgent());
  mockPrisma.idea.findMany.mockResolvedValue([]);
  mockPrisma.proposal.findMany.mockResolvedValue([]);
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.project.findMany.mockResolvedValue([]);
  mockNotificationService.list.mockResolvedValue(emptyNotifications());
  mockNotificationService.markRead.mockResolvedValue({});
  mockNotificationService.emitAgentCheckinIfFirst.mockResolvedValue(true);
});

// ===== Agent info =====

describe("buildCheckinResponse — agent info", () => {
  it("returns agent identity with owner", async () => {
    const result = await buildCheckinResponse(auth);

    expect(result.agent.uuid).toBe(AGENT_UUID);
    expect(result.agent.name).toBe("Dev Agent");
    expect(result.agent.roles).toEqual(["developer"]);
    expect(result.agent.owner).toEqual({
      uuid: OWNER_UUID,
      name: "Owner User",
      email: "owner@example.com",
    });
  });

  it("returns custom persona when set", async () => {
    mockPrisma.agent.update.mockResolvedValue(makeAgent({ persona: "custom-persona" }));

    const result = await buildCheckinResponse(auth);

    expect(result.agent.persona).toBe("custom-persona");
  });

  it("returns null persona when agent has none", async () => {
    mockPrisma.agent.update.mockResolvedValue(makeAgent({ persona: null }));

    const result = await buildCheckinResponse(auth);

    expect(result.agent.persona).toBeNull();
  });

  it("returns null owner when agent has none", async () => {
    mockPrisma.agent.update.mockResolvedValue(makeAgent({ ownerUuid: null, owner: null }));

    const result = await buildCheckinResponse({ ...auth, ownerUuid: undefined });

    expect(result.agent.owner).toBeNull();
    expect(mockNotificationService.emitAgentCheckinIfFirst).not.toHaveBeenCalled();
  });

  it("emits first-checkin notification when owner is present", async () => {
    await buildCheckinResponse(auth);

    expect(mockNotificationService.emitAgentCheckinIfFirst).toHaveBeenCalledWith({
      companyUuid: COMPANY_UUID,
      agentUuid: AGENT_UUID,
      agentName: "Dev Agent",
      ownerUuid: OWNER_UUID,
    });
  });

  it("sets checkinTime to an ISO string", async () => {
    const result = await buildCheckinResponse(auth);
    expect(result.checkinTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ===== Idea tracker =====

describe("buildCheckinResponse — ideaTracker", () => {
  it("returns empty tracker when agent has no assigned ideas", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);

    const result = await buildCheckinResponse(auth);

    expect(result.ideaTracker).toEqual({});
  });

  it("queries ideas assigned to agent OR agent's owner", async () => {
    await buildCheckinResponse(auth);

    const call = mockPrisma.idea.findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { assigneeType: "agent", assigneeUuid: AGENT_UUID },
      { assigneeType: "user", assigneeUuid: OWNER_UUID },
    ]);
    expect(call.where.status).toEqual({ not: "closed" });
    expect(call.where.companyUuid).toBe(COMPANY_UUID);
  });

  it("queries only agent condition when owner is absent", async () => {
    await buildCheckinResponse({ ...auth, ownerUuid: undefined });

    const call = mockPrisma.idea.findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([{ assigneeType: "agent", assigneeUuid: AGENT_UUID }]);
  });

  it("groups ideas by project with project name", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-a1", PROJECT_A, "open"),
      makeIdea("idea-a2", PROJECT_A, "elaborating", { elaborationStatus: "validating" }),
      makeIdea("idea-b1", PROJECT_B, "open"),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: PROJECT_A, name: "Project A" },
      { uuid: PROJECT_B, name: "Project B" },
    ]);

    const result = await buildCheckinResponse(auth);

    expect(result.ideaTracker[PROJECT_A].name).toBe("Project A");
    expect(result.ideaTracker[PROJECT_A].ideas).toHaveLength(2);
    expect(result.ideaTracker[PROJECT_B].name).toBe("Project B");
    expect(result.ideaTracker[PROJECT_B].ideas).toHaveLength(1);
  });

  it("emits derived status for each idea", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-todo", PROJECT_A, "open"),
      makeIdea("idea-research", PROJECT_A, "elaborating", { elaborationStatus: "validating" }),
      makeIdea("idea-answer", PROJECT_A, "elaborating", { elaborationStatus: "pending_answers" }),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    const byUuid = Object.fromEntries(result.ideaTracker[PROJECT_A].ideas.map((i) => [i.uuid, i]));
    expect(byUuid["idea-todo"].status).toBe("todo");
    expect(byUuid["idea-research"].status).toBe("in_progress");
    expect(byUuid["idea-answer"].status).toBe("human_conduct_required");
  });

  it("filters out ideas with derivedStatus=done", async () => {
    const doneProposal = "proposal-done";
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("idea-active", PROJECT_A, "open"),
      makeIdea("idea-done", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: doneProposal, status: "approved", inputUuids: ["idea-done"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: doneProposal, status: "done" },
      { proposalUuid: doneProposal, status: "done" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    expect(result.ideaTracker[PROJECT_A].ideas.map((i) => i.uuid)).toEqual(["idea-active"]);
  });

  it("excludes closed ideas at the query level", async () => {
    // The Prisma query filter (not: "closed") is responsible for excluding closed ideas.
    // Verify that filter is actually on the query so it can't regress silently.
    await buildCheckinResponse(auth);
    const call = mockPrisma.idea.findMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ not: "closed" });
  });

  it("computes proposals count across pending + approved", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-p", status: "pending", inputUuids: ["idea-1"], createdAt: now },
      { uuid: "proposal-a", status: "approved", inputUuids: ["idea-1"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: "proposal-a", status: "open" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    const idea = result.ideaTracker[PROJECT_A].ideas[0];
    expect(idea.proposals).toBe(2);
    expect(idea.tasks).toBe(1);
  });

  it("reports 0 tasks when idea has no approved proposal", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "proposal-p", status: "pending", inputUuids: ["idea-1"], createdAt: now },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    const idea = result.ideaTracker[PROJECT_A].ideas[0];
    expect(idea.proposals).toBe(1);
    expect(idea.tasks).toBe(0);
  });

  it("uses the latest approved proposal for task counting", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      {
        uuid: "proposal-new",
        status: "approved",
        inputUuids: ["idea-1"],
        createdAt: new Date("2026-03-01T00:00:00Z"),
      },
      {
        uuid: "proposal-old",
        status: "approved",
        inputUuids: ["idea-1"],
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: "proposal-new", status: "open" },
      { proposalUuid: "proposal-new", status: "in_progress" },
      { proposalUuid: "proposal-old", status: "done" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    const idea = result.ideaTracker[PROJECT_A].ideas[0];
    expect(idea.proposals).toBe(2);
    expect(idea.tasks).toBe(2);
  });

  it("ignores proposal inputUuids that point to ideas outside the tracked set", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      {
        uuid: "proposal-x",
        status: "approved",
        inputUuids: ["idea-1", "idea-unrelated"],
        createdAt: now,
      },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([{ proposalUuid: "proposal-x", status: "open" }]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    expect(result.ideaTracker[PROJECT_A].ideas[0].proposals).toBe(1);
  });

  it("skips task query when no approved proposals are in scope", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "open")]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    await buildCheckinResponse(auth);

    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("falls back to empty name when project not found", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "open")]);
    mockPrisma.project.findMany.mockResolvedValue([]);

    const result = await buildCheckinResponse(auth);

    expect(result.ideaTracker[PROJECT_A].name).toBe("");
  });

  it("tolerates proposals with non-array inputUuids", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p-bad", status: "approved", inputUuids: "oops", createdAt: now },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const result = await buildCheckinResponse(auth);

    const idea = result.ideaTracker[PROJECT_A].ideas[0];
    expect(idea.proposals).toBe(0);
    expect(idea.tasks).toBe(0);
  });

  it("runs exactly 3 entity queries when there are approved proposals", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([makeIdea("idea-1", PROJECT_A, "elaborated")]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p-1", status: "approved", inputUuids: ["idea-1"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([{ proposalUuid: "p-1", status: "open" }]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    await buildCheckinResponse(auth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.project.findMany).toHaveBeenCalledTimes(1);
  });
});

// ===== Notifications =====

describe("buildCheckinResponse — notifications", () => {
  it("returns empty recent list when no unread notifications", async () => {
    const result = await buildCheckinResponse(auth);

    expect(result.notifications.recent).toEqual([]);
    expect(result.notifications.unread).toBe(0);
    expect(mockNotificationService.markRead).not.toHaveBeenCalled();
  });

  it("returns top 5 unread in slim format and marks them as read", async () => {
    mockNotificationService.list.mockResolvedValue({
      notifications: [
        {
          uuid: "notif-1",
          action: "mentioned",
          entityType: "task",
          entityTitle: "Fix bug X",
          actorName: "Alice",
          createdAt: "2026-04-23T09:00:00.000Z",
        },
        {
          uuid: "notif-2",
          action: "task_assigned",
          entityType: "task",
          entityTitle: "Ship feature Y",
          actorName: "Bob",
          createdAt: "2026-04-23T08:30:00.000Z",
        },
      ],
      total: 2,
      unreadCount: 7,
    });

    const result = await buildCheckinResponse(auth);

    expect(result.notifications.recent).toEqual([
      {
        uuid: "notif-1",
        action: "mentioned",
        entity: "task",
        title: "Fix bug X",
        actor: "Alice",
        at: "2026-04-23T09:00:00.000Z",
      },
      {
        uuid: "notif-2",
        action: "task_assigned",
        entity: "task",
        title: "Ship feature Y",
        actor: "Bob",
        at: "2026-04-23T08:30:00.000Z",
      },
    ]);
    expect(mockNotificationService.markRead).toHaveBeenCalledTimes(2);
    expect(mockNotificationService.markRead).toHaveBeenCalledWith(
      "notif-1",
      COMPANY_UUID,
      "agent",
      AGENT_UUID,
    );
    // unread = total unread (7) - marked (2)
    expect(result.notifications.unread).toBe(5);
  });

  it("passes readFilter=unread and take=5 to notification list", async () => {
    await buildCheckinResponse(auth);

    expect(mockNotificationService.list).toHaveBeenCalledWith({
      companyUuid: COMPANY_UUID,
      recipientType: "agent",
      recipientUuid: AGENT_UUID,
      readFilter: "unread",
      take: 5,
    });
  });

  it("tolerates markRead failures without throwing — failed marks are not subtracted", async () => {
    mockNotificationService.list.mockResolvedValue({
      notifications: [
        {
          uuid: "notif-1",
          action: "mentioned",
          entityType: "task",
          entityTitle: "T",
          actorName: "A",
          createdAt: "2026-04-23T09:00:00.000Z",
        },
        {
          uuid: "notif-stale",
          action: "mentioned",
          entityType: "task",
          entityTitle: "T",
          actorName: "A",
          createdAt: "2026-04-23T08:59:00.000Z",
        },
      ],
      total: 2,
      unreadCount: 3,
    });
    mockNotificationService.markRead.mockImplementation(async (uuid: string) => {
      if (uuid === "notif-stale") throw new Error("stale");
      return {};
    });

    const result = await buildCheckinResponse(auth);

    // 3 unread - 1 successfully marked = 2 remaining
    expect(result.notifications.unread).toBe(2);
    expect(result.notifications.recent).toHaveLength(2);
  });

  it("never reports negative unread (clamped at 0)", async () => {
    mockNotificationService.list.mockResolvedValue({
      notifications: [
        {
          uuid: "notif-1",
          action: "mentioned",
          entityType: "task",
          entityTitle: "T",
          actorName: "A",
          createdAt: "2026-04-23T09:00:00.000Z",
        },
      ],
      total: 1,
      // unreadCount stale/racey: fewer than what we just marked
      unreadCount: 0,
    });

    const result = await buildCheckinResponse(auth);
    expect(result.notifications.unread).toBe(0);
  });
});

// ===== Empty state sanity =====

describe("buildCheckinResponse — empty state", () => {
  it("returns a well-formed response with no assignments or notifications", async () => {
    const result = await buildCheckinResponse(auth);

    expect(result).toEqual({
      checkinTime: expect.any(String),
      agent: {
        uuid: AGENT_UUID,
        name: "Dev Agent",
        roles: ["developer"],
        persona: null,
        systemPrompt: null,
        owner: { uuid: OWNER_UUID, name: "Owner User", email: "owner@example.com" },
      },
      ideaTracker: {},
      notifications: { unread: 0, recent: [] },
    });
  });
});
