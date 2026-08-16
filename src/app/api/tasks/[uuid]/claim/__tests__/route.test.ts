import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();

const mockPrisma = vi.hoisted(() => ({
  agent: {
    findFirst: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockGetTaskByUuid = vi.fn();
const mockClaimTask = vi.fn();
vi.mock("@/services/task.service", () => ({
  getTaskByUuid: (...args: unknown[]) => mockGetTaskByUuid(...args),
  claimTask: (...args: unknown[]) => mockClaimTask(...args),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

import { POST } from "@/app/api/tasks/[uuid]/claim/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const taskUuid = "task-0000-0000-0000-000000000001";
const instanceUuid = "instance-0000-0000-0000-000000000001";

function jsonRequest(body: unknown) {
  return new NextRequest(new URL(`/api/tasks/${taskUuid}/claim`, "http://localhost:3000"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ uuid: taskUuid }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    type: "user",
    companyUuid,
    actorUuid: userUuid,
  });
  mockGetTaskByUuid.mockResolvedValue({ uuid: taskUuid, companyUuid });
});

describe("POST /api/tasks/[uuid]/claim — agent selection gating", () => {
  it("allows user to assign to an agent with task:write via developer_agent preset", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["developer_agent"],
      permissions: [],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: agentUuid });

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockClaimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: agentUuid,
        assignedByType: "user",
        assignedByUuid: userUuid,
      }),
    );
  });

  it("allows assignment to a custom-preset agent with task:write", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: [],
      permissions: ["task:read", "task:write"],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: agentUuid });

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    expect(res.status).toBe(200);
    expect(mockClaimTask).toHaveBeenCalled();
  });

  it("rejects with 403 when agent lacks task:write", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: [],
      permissions: ["task:read"],
    });

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.message).toMatch(/task:write/);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  it("returns 404 when the specified agent doesn't exist", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    expect(res.status).toBe(404);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  // add-agent-instance-addressing (T7): the route accepts an optional
  // `instanceUuid` and forwards it into claimTask so the service can persist the
  // task as an `agent_instance` assignment. The legacy targetHost/targetCwd body
  // shape is gone — it is replaced by the durable instance reference.
  it("forwards instanceUuid into claimTask when assigning to an agent (agent_instance pin)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["developer_agent"],
      permissions: [],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: instanceUuid });

    const res = await POST(
      jsonRequest({ agentUuid, instanceUuid }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(mockClaimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: agentUuid,
        assignedByType: "user",
        assignedByUuid: userUuid,
        instanceUuid,
      }),
    );
  });

  it("omits instanceUuid from claimTask args when none is supplied (backward-compatible agent assignment)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["developer_agent"],
      permissions: [],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: agentUuid });

    await POST(jsonRequest({ agentUuid }), ctx());
    const claimArgs = mockClaimTask.mock.calls[0][0];
    expect(claimArgs).not.toHaveProperty("instanceUuid");
    expect(claimArgs).not.toHaveProperty("targetHost");
    expect(claimArgs).not.toHaveProperty("targetCwd");
  });

  it("returns 400 when the service rejects a foreign-company / unknown instance pin", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["developer_agent"],
      permissions: [],
    });
    mockClaimTask.mockRejectedValue(new Error("Agent instance not found"));

    const res = await POST(
      jsonRequest({ agentUuid, instanceUuid: "instance-does-not-exist" }),
      ctx(),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/Agent instance not found/);
  });

  it("does not thread an instanceUuid on an agent self-claim", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: ["developer_agent"],
      permissions: ["task:read", "task:write"],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: agentUuid });

    // Even if a body carries instanceUuid, the agent branch never reads the body.
    await POST(jsonRequest({ instanceUuid }), ctx());
    const claimArgs = mockClaimTask.mock.calls[0][0];
    expect(claimArgs).not.toHaveProperty("instanceUuid");
    expect(claimArgs.assigneeType).toBe("agent");
    expect(claimArgs.assigneeUuid).toBe(agentUuid);
    expect(claimArgs.assignedByType).toBeNull();
    expect(claimArgs.assignedByUuid).toBeNull();
  });

  it("looks up the agent scoped by companyUuid (no cross-tenant leakage)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["developer_agent"],
      permissions: [],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: agentUuid });

    await POST(jsonRequest({ agentUuid }), ctx());

    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          uuid: agentUuid,
          companyUuid,
        }),
      }),
    );
  });
});

describe("POST /api/tasks/[uuid]/claim — agent self-claim", () => {
  it("lets an agent with task:write claim directly", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: ["developer_agent"],
      permissions: ["task:read", "task:write"],
    });
    mockClaimTask.mockResolvedValue({ uuid: taskUuid, assigneeUuid: agentUuid });

    const res = await POST(jsonRequest({}), ctx());
    expect(res.status).toBe(200);
    expect(mockClaimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: agentUuid,
      }),
    );
  });

  it("rejects 403 when self-claiming agent lacks task:write", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: [],
      permissions: ["task:read"],
    });

    const res = await POST(jsonRequest({}), ctx());
    expect(res.status).toBe(403);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });
});
