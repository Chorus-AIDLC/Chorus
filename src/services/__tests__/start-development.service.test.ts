import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma, mockEventBus, mockCreateActivity } = vi.hoisted(() => ({
  mockPrisma: {
    idea: {
      findFirst: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    task: {
      count: vi.fn(),
    },
    agentInstance: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    daemonConnection: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    projectAgentCwdPreference: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
  mockEventBus: { emitChange: vi.fn() },
  mockCreateActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/services", () => ({
  activityService: { createActivity: mockCreateActivity },
}));

import { startDevelopment } from "@/services/start-development.service";

// ===== Test Data =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const IDEA_UUID = "idea-2222-2222-2222-222222222222";
const PROJECT_UUID = "project-5555-5555-5555-555555555555";
const USER_UUID = "user-6666-6666-6666-666666666666";
const AGENT_UUID = "agent-7777-7777-7777-777777777777";
const INSTANCE_UUID = "instance-8888-8888-8888-888888888888";
const PROPOSAL_UUID = "proposal-9999-9999-9999-999999999999";

function makeIdea(overrides: Record<string, unknown> = {}) {
  return {
    uuid: IDEA_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: PROJECT_UUID,
    status: "elaborated",
    elaborationStatus: "resolved",
    assigneeType: "agent",
    assigneeUuid: AGENT_UUID,
    ...overrides,
  };
}

const PARAMS = {
  companyUuid: COMPANY_UUID,
  ideaUuid: IDEA_UUID,
  actorUuid: USER_UUID,
  actorType: "user",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Happy path by default: agent assignee, approved proposal, 3 unfinished
  // tasks, online connection.
  mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
  mockPrisma.proposal.findFirst.mockResolvedValue({ uuid: PROPOSAL_UUID });
  mockPrisma.task.count.mockResolvedValue(3);
  mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: "conn-1" });
  mockPrisma.daemonConnection.findMany.mockResolvedValue([{
    uuid: "conn-1", agentUuid: AGENT_UUID, clientType: "claude_code",
    clientVersion: null, host: "Laptop-Q3", cwd: "/home/u/dev/payments",
    startedAt: null, status: "online", connectedAt: new Date(),
    lastSeenAt: new Date(), disconnectedAt: null, agentInstanceUuid: INSTANCE_UUID,
    agent: { name: "Agent", ownerUuid: USER_UUID },
  }]);
  mockPrisma.agentInstance.upsert.mockResolvedValue({ uuid: INSTANCE_UUID });
  mockPrisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: AGENT_UUID });
  mockPrisma.projectAgentCwdPreference.findFirst.mockResolvedValue(null);
});

describe("startDevelopment — success", () => {
  it("emits exactly one start_development activity with proposalUuid + remainingTasks and no state transition", async () => {
    await startDevelopment(PARAMS);

    expect(mockCreateActivity).toHaveBeenCalledTimes(1);
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "start_development",
        targetType: "idea",
        targetUuid: IDEA_UUID,
        projectUuid: PROJECT_UUID,
        actorType: "user",
        actorUuid: USER_UUID,
        value: expect.objectContaining({
          proposalUuid: PROPOSAL_UUID,
          remainingTasks: 3,
        }),
      })
    );
    // Wake-only: the framework was given no transition, so nothing may touch
    // the Idea beyond the initial company-scoped read.
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea", entityUuid: IDEA_UUID })
    );
  });

  it("queries the approved proposal scoped by company, project, and idea membership", async () => {
    await startDevelopment(PARAMS);

    expect(mockPrisma.proposal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid: COMPANY_UUID,
          projectUuid: PROJECT_UUID,
          status: "approved",
          inputUuids: { array_contains: [IDEA_UUID] },
        }),
      })
    );
  });

  it("counts only unfinished tasks: status notIn done/closed (to_verify counts as unfinished)", async () => {
    // A proposal whose only remaining task is in to_verify still passes (Q3).
    mockPrisma.task.count.mockResolvedValue(1);

    await startDevelopment(PARAMS);

    expect(mockPrisma.task.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyUuid: COMPANY_UUID,
          proposalUuid: PROPOSAL_UUID,
          status: { notIn: ["done", "closed"] },
        }),
      })
    );
    expect(mockCreateActivity).toHaveBeenCalled();
  });

  it("accepts an agent_instance assignee, checking that pinned instance's own connection is online", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "agent_instance", assigneeUuid: INSTANCE_UUID })
    );
    mockPrisma.agentInstance.findFirst.mockResolvedValue({
      agentUuid: AGENT_UUID,
      host: "Laptop-Q3",
      cwd: "/home/u/dev/payments",
    });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: "conn-pinned" });

    await startDevelopment(PARAMS);

    expect(mockPrisma.agentInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          uuid: INSTANCE_UUID,
          companyUuid: COMPANY_UUID,
        }),
      })
    );
    // HARD pin: the liveness check targets the pinned instance's exact (host, cwd) place.
    expect(mockPrisma.daemonConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid: COMPANY_UUID, agentUuid: AGENT_UUID },
      })
    );
    expect(mockCreateActivity).toHaveBeenCalled();
  });
});

describe("startDevelopment — precondition failures (each emits nothing)", () => {
  it("rejects a human assignee with ASSIGNEE_NOT_AGENT", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "user", assigneeUuid: USER_UUID })
    );

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "ASSIGNEE_NOT_AGENT",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects an unassigned idea with ASSIGNEE_NOT_AGENT", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: null, assigneeUuid: null })
    );

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "ASSIGNEE_NOT_AGENT",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with reason no_approved_proposal when none exists", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "no_approved_proposal",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with reason no_unfinished_tasks when every task is done/closed", async () => {
    mockPrisma.task.count.mockResolvedValue(0);

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "no_unfinished_tasks",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with AGENT_OFFLINE when the agent has no effectively-online connection", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]);

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "AGENT_OFFLINE",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with INSTANCE_OFFLINE when the pinned instance has no online connection", async () => {
    // An agent_instance-pinned idea whose pinned (host, cwd) has no online connection: the
    // HARD pin is notify-only, so require_online fails distinguishably (INSTANCE_OFFLINE,
    // not AGENT_OFFLINE) and no other cwd is woken.
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "agent_instance", assigneeUuid: INSTANCE_UUID })
    );
    mockPrisma.agentInstance.findFirst.mockResolvedValue({
      agentUuid: AGENT_UUID,
      host: "Laptop-Q3",
      cwd: "/home/u/dev/payments",
    });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]);

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "INSTANCE_OFFLINE",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with FIXED_CWD_HOST_OFFLINE when another Agent host is online", async () => {
    mockPrisma.projectAgentCwdPreference.findFirst.mockResolvedValue({
      uuid: "pref-1",
      host: "fixed-host",
      cwd: "/work/fixed",
      anchorAgentInstanceUuid: INSTANCE_UUID,
    });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    await expect(startDevelopment(PARAMS)).rejects.toMatchObject({
      code: "FIXED_CWD_HOST_OFFLINE",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects a cross-company idea as IDEA_NOT_FOUND without disclosure", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      startDevelopment({ ...PARAMS, companyUuid: "other-company" })
    ).rejects.toMatchObject({ code: "IDEA_NOT_FOUND" });

    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID, companyUuid: "other-company" },
      })
    );
    expect(mockPrisma.proposal.findFirst).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects an agent caller with NOT_HUMAN before any lookup", async () => {
    await expect(
      startDevelopment({ ...PARAMS, actorType: "agent" })
    ).rejects.toMatchObject({ code: "NOT_HUMAN" });

    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});
