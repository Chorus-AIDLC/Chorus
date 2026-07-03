import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma, mockEventBus, mockCreateActivity } = vi.hoisted(() => ({
  mockPrisma: {
    idea: {
      findFirst: vi.fn(),
    },
    agentInstance: {
      findFirst: vi.fn(),
    },
    daemonConnection: {
      findFirst: vi.fn(),
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

import {
  executeStageAdvance,
  StageAdvanceError,
  type StageAdvanceDefinition,
} from "@/services/stage-advance.service";

// ===== Test Data =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const IDEA_UUID = "idea-2222-2222-2222-222222222222";
const PROJECT_UUID = "project-5555-5555-5555-555555555555";
const USER_UUID = "user-6666-6666-6666-666666666666";
const AGENT_UUID = "agent-7777-7777-7777-777777777777";
const INSTANCE_UUID = "instance-8888-8888-8888-888888888888";

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

function makeDefinition(
  overrides: Partial<StageAdvanceDefinition> = {}
): StageAdvanceDefinition {
  return {
    action: "test_stage_advance",
    precondition: vi.fn().mockResolvedValue({ payload: 1 }),
    offlinePolicy: "queue",
    ...overrides,
  };
}

const HUMAN_PARAMS = {
  companyUuid: COMPANY_UUID,
  ideaUuid: IDEA_UUID,
  actorUuid: USER_UUID,
  actorType: "user",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
  mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: "conn-1" });
  mockPrisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: AGENT_UUID });
});

describe("executeStageAdvance — actor gate", () => {
  it("rejects an agent caller with NOT_HUMAN and emits nothing", async () => {
    const definition = makeDefinition();

    await expect(
      executeStageAdvance(definition, { ...HUMAN_PARAMS, actorType: "agent" })
    ).rejects.toMatchObject({ code: "NOT_HUMAN" });

    // Rejected before any lookup, precondition, or emit.
    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled();
    expect(definition.precondition).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockEventBus.emitChange).not.toHaveBeenCalled();
  });

  it("accepts a super_admin caller", async () => {
    await executeStageAdvance(makeDefinition(), {
      ...HUMAN_PARAMS,
      actorType: "super_admin",
    });
    expect(mockCreateActivity).toHaveBeenCalled();
  });
});

describe("executeStageAdvance — company scoping", () => {
  it("rejects a cross-company Idea as not-found without disclosure", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);
    const definition = makeDefinition();

    await expect(
      executeStageAdvance(definition, {
        ...HUMAN_PARAMS,
        companyUuid: "other-company",
      })
    ).rejects.toMatchObject({ code: "IDEA_NOT_FOUND" });

    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID, companyUuid: "other-company" },
      })
    );
    expect(definition.precondition).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});

describe("executeStageAdvance — precondition", () => {
  it("a failed precondition emits no transition and no activity", async () => {
    const transition = vi.fn();
    const definition = makeDefinition({
      precondition: vi
        .fn()
        .mockRejectedValue(
          new StageAdvanceError("PRECONDITION_FAILED", "nope", "some_reason")
        ),
      transition,
    });

    await expect(
      executeStageAdvance(definition, HUMAN_PARAMS)
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", reason: "some_reason" });

    expect(transition).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockEventBus.emitChange).not.toHaveBeenCalled();
  });

  it("the precondition's return value becomes the activity payload", async () => {
    const definition = makeDefinition({
      precondition: vi.fn().mockResolvedValue({ proposalUuid: "p-1", remainingTasks: 3 }),
    });

    await executeStageAdvance(definition, HUMAN_PARAMS);

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "test_stage_advance",
        targetType: "idea",
        targetUuid: IDEA_UUID,
        projectUuid: PROJECT_UUID,
        value: { proposalUuid: "p-1", remainingTasks: 3 },
      })
    );
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea", entityUuid: IDEA_UUID })
    );
  });
});

describe("executeStageAdvance — offline policy", () => {
  it("queue policy never consults daemon liveness", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    await executeStageAdvance(makeDefinition({ offlinePolicy: "queue" }), HUMAN_PARAMS);

    expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
    expect(mockCreateActivity).toHaveBeenCalled();
  });

  it("require_online passes when the agent has an effectively-online connection", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: "conn-1" });

    await executeStageAdvance(
      makeDefinition({ offlinePolicy: "require_online" }),
      HUMAN_PARAMS
    );

    // The liveness query filters on status="online" AND a lastSeenAt floor
    // derived from STALE_THRESHOLD_MS.
    expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentUuid: AGENT_UUID,
          status: "online",
          lastSeenAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      })
    );
    expect(mockCreateActivity).toHaveBeenCalled();
  });

  it("require_online throws coded AGENT_OFFLINE when no live connection exists and emits nothing", async () => {
    const transition = vi.fn();
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    await expect(
      executeStageAdvance(
        makeDefinition({ offlinePolicy: "require_online", transition }),
        HUMAN_PARAMS
      )
    ).rejects.toMatchObject({ code: "AGENT_OFFLINE" });

    expect(transition).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("require_online resolves an agent_instance assignee to its owning agent", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "agent_instance", assigneeUuid: INSTANCE_UUID })
    );
    mockPrisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: AGENT_UUID });

    await executeStageAdvance(
      makeDefinition({ offlinePolicy: "require_online" }),
      HUMAN_PARAMS
    );

    expect(mockPrisma.agentInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uuid: INSTANCE_UUID, companyUuid: COMPANY_UUID }),
      })
    );
    expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentUuid: AGENT_UUID }),
      })
    );
  });

  it("require_online throws ASSIGNEE_NOT_AGENT for a human assignee and emits nothing", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "user", assigneeUuid: USER_UUID })
    );

    await expect(
      executeStageAdvance(
        makeDefinition({ offlinePolicy: "require_online" }),
        HUMAN_PARAMS
      )
    ).rejects.toMatchObject({ code: "ASSIGNEE_NOT_AGENT" });

    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});

describe("executeStageAdvance — transition ordering", () => {
  it("runs the transition after all gates and before the activity emit", async () => {
    const order: string[] = [];
    const definition = makeDefinition({
      precondition: vi.fn().mockImplementation(async () => {
        order.push("precondition");
        return {};
      }),
      transition: vi.fn().mockImplementation(async () => {
        order.push("transition");
      }),
    });
    mockCreateActivity.mockImplementation(async () => {
      order.push("activity");
    });

    await executeStageAdvance(definition, HUMAN_PARAMS);

    expect(order).toEqual(["precondition", "transition", "activity"]);
  });
});
