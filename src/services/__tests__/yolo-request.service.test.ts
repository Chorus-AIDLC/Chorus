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
    },
    daemonConnection: {
      findFirst: vi.fn(),
    },
    projectAgentCwdPreference: {
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

import { requestYolo } from "@/services/yolo-request.service";

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
    status: "open",
    elaborationStatus: null,
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
  // Happy path by default: agent assignee, online connection. Note the idea is
  // in `open` status with NO proposal — Yolo must still accept it (Q1: any
  // incomplete stage), so the proposal/task mocks are intentionally left unset.
  mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
  mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: "conn-1" });
  mockPrisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: AGENT_UUID });
  mockPrisma.projectAgentCwdPreference.findFirst.mockResolvedValue(null);
});

describe("requestYolo — success", () => {
  it("emits exactly one yolo_requested activity and performs no state transition", async () => {
    await requestYolo(PARAMS);

    expect(mockCreateActivity).toHaveBeenCalledTimes(1);
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "yolo_requested",
        targetType: "idea",
        targetUuid: IDEA_UUID,
        projectUuid: PROJECT_UUID,
        actorType: "user",
        actorUuid: USER_UUID,
      })
    );
    // Wake-only: the framework was given no transition, so nothing may touch the
    // Idea beyond the initial company-scoped read.
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea", entityUuid: IDEA_UUID })
    );
  });

  it("accepts an idea with NO proposal and NO tasks (any incomplete stage)", async () => {
    // The whole point vs start_development: no proposal/task lookup. Assert the
    // service never queries them, and still emits.
    await requestYolo(PARAMS);

    expect(mockPrisma.proposal.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.task.count).not.toHaveBeenCalled();
    expect(mockCreateActivity).toHaveBeenCalledTimes(1);
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

    await requestYolo(PARAMS);

    expect(mockPrisma.agentInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          uuid: INSTANCE_UUID,
          companyUuid: COMPANY_UUID,
        }),
      })
    );
    // HARD pin: the liveness check targets the pinned instance's exact (host, cwd) place.
    expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentUuid: AGENT_UUID,
          host: "Laptop-Q3",
          cwd: "/home/u/dev/payments",
          status: "online",
        }),
      })
    );
    expect(mockCreateActivity).toHaveBeenCalled();
  });
});

describe("requestYolo — precondition failures (each emits nothing)", () => {
  it("rejects a human assignee with ASSIGNEE_NOT_AGENT", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "user", assigneeUuid: USER_UUID })
    );

    await expect(requestYolo(PARAMS)).rejects.toMatchObject({
      code: "ASSIGNEE_NOT_AGENT",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects an unassigned idea with ASSIGNEE_NOT_AGENT", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: null, assigneeUuid: null })
    );

    await expect(requestYolo(PARAMS)).rejects.toMatchObject({
      code: "ASSIGNEE_NOT_AGENT",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with AGENT_OFFLINE (distinguishable from ASSIGNEE_NOT_AGENT) when no online connection", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    await expect(requestYolo(PARAMS)).rejects.toMatchObject({
      code: "AGENT_OFFLINE",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with INSTANCE_OFFLINE when the pinned instance has no online connection", async () => {
    // An agent_instance-pinned idea whose pinned (host, cwd) is offline: HARD pin → the wake
    // would be notify-only, so Yolo fails distinguishably (INSTANCE_OFFLINE, not AGENT_OFFLINE)
    // and wakes no other cwd.
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeType: "agent_instance", assigneeUuid: INSTANCE_UUID })
    );
    mockPrisma.agentInstance.findFirst.mockResolvedValue({
      agentUuid: AGENT_UUID,
      host: "Laptop-Q3",
      cwd: "/home/u/dev/payments",
    });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    await expect(requestYolo(PARAMS)).rejects.toMatchObject({
      code: "INSTANCE_OFFLINE",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects with FIXED_CWD_HOST_OFFLINE when another Agent host is online", async () => {
    mockPrisma.projectAgentCwdPreference.findFirst.mockResolvedValue({
      host: "fixed-host",
    });
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);

    await expect(requestYolo(PARAMS)).rejects.toMatchObject({
      code: "FIXED_CWD_HOST_OFFLINE",
    });
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects a cross-company idea as IDEA_NOT_FOUND without disclosure", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      requestYolo({ ...PARAMS, companyUuid: "other-company" })
    ).rejects.toMatchObject({ code: "IDEA_NOT_FOUND" });

    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID, companyUuid: "other-company" },
      })
    );
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it("rejects an agent caller with NOT_HUMAN before any lookup", async () => {
    await expect(
      requestYolo({ ...PARAMS, actorType: "agent" })
    ).rejects.toMatchObject({ code: "NOT_HUMAN" });

    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });
});
