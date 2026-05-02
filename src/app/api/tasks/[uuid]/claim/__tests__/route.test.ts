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
