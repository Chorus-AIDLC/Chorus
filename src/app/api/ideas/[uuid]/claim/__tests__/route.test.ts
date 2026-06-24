import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();

const mockPrisma = vi.hoisted(() => ({
  agent: {
    findFirst: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockGetIdeaByUuid = vi.fn();
const mockClaimIdea = vi.fn();
vi.mock("@/services/idea.service", () => ({
  getIdeaByUuid: (...args: unknown[]) => mockGetIdeaByUuid(...args),
  claimIdea: (...args: unknown[]) => mockClaimIdea(...args),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

import { POST } from "@/app/api/ideas/[uuid]/claim/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ideaUuid = "idea-0000-0000-0000-000000000001";
const instanceUuid = "instance-0000-0000-0000-000000000001";

function jsonRequest(body: unknown) {
  return new NextRequest(new URL(`/api/ideas/${ideaUuid}/claim`, "http://localhost:3000"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ uuid: ideaUuid }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    type: "user",
    companyUuid,
    actorUuid: userUuid,
  });
  mockGetIdeaByUuid.mockResolvedValue({ uuid: ideaUuid, companyUuid });
});

describe("POST /api/ideas/[uuid]/claim — agent selection gating", () => {
  it("allows user to assign to an agent with idea:write via pm_agent preset", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["pm_agent"],
      permissions: [],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: agentUuid });

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockClaimIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: agentUuid,
        assignedByUuid: userUuid,
      }),
    );
  });

  it("allows assignment when agent has idea:write via custom permissions only", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: [],
      permissions: ["idea:write"],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: agentUuid });

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    expect(res.status).toBe(200);
    expect(mockClaimIdea).toHaveBeenCalled();
  });

  it("rejects with 403 when agent lacks idea:write (developer_agent preset)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["developer_agent"],
      permissions: [],
    });

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.message).toMatch(/idea:write/);
    expect(mockClaimIdea).not.toHaveBeenCalled();
  });

  it("returns 404 when the specified agent doesn't exist in this company", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue(null);

    const res = await POST(jsonRequest({ agentUuid }), ctx());
    expect(res.status).toBe(404);
    expect(mockClaimIdea).not.toHaveBeenCalled();
  });

  it("looks up the agent scoped by companyUuid (no cross-tenant leakage)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["pm_agent"],
      permissions: [],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: agentUuid });

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

// add-agent-instance-addressing (T7): the idea claim route accepts an optional
// `instanceUuid` and forwards it into claimIdea so the service can pin the idea
// as an `agent_instance` assignment (the authoritative pin root). Absent → a
// plain agent claim, byte-identical to before.
describe("POST /api/ideas/[uuid]/claim — instance pin", () => {
  it("forwards instanceUuid into claimIdea when assigning to an agent (agent_instance pin)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["pm_agent"],
      permissions: [],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: instanceUuid });

    const res = await POST(jsonRequest({ agentUuid, instanceUuid }), ctx());
    expect(res.status).toBe(200);
    expect(mockClaimIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: agentUuid,
        assignedByUuid: userUuid,
        instanceUuid,
      }),
    );
  });

  it("omits instanceUuid from claimIdea args when none is supplied (backward-compatible)", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["pm_agent"],
      permissions: [],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: agentUuid });

    await POST(jsonRequest({ agentUuid }), ctx());
    const claimArgs = mockClaimIdea.mock.calls[0][0];
    expect(claimArgs).not.toHaveProperty("instanceUuid");
  });

  it("returns 400 when the service rejects a foreign-company / unknown instance pin", async () => {
    mockPrisma.agent.findFirst.mockResolvedValue({
      uuid: agentUuid,
      roles: ["pm_agent"],
      permissions: [],
    });
    mockClaimIdea.mockRejectedValue(new Error("Agent instance not found"));

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
      roles: ["pm_agent"],
      permissions: ["idea:read", "idea:write"],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: agentUuid });

    await POST(jsonRequest({ instanceUuid }), ctx());
    const claimArgs = mockClaimIdea.mock.calls[0][0];
    expect(claimArgs).not.toHaveProperty("instanceUuid");
    expect(claimArgs.assigneeType).toBe("agent");
    expect(claimArgs.assigneeUuid).toBe(agentUuid);
  });
});

describe("POST /api/ideas/[uuid]/claim — agent self-claim", () => {
  it("lets an agent with idea:write claim directly", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: ["pm_agent"],
      permissions: ["idea:read", "idea:write"],
    });
    mockClaimIdea.mockResolvedValue({ uuid: ideaUuid, assigneeUuid: agentUuid });

    const res = await POST(jsonRequest({}), ctx());
    expect(res.status).toBe(200);
    expect(mockClaimIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: agentUuid,
      }),
    );
  });

  it("rejects 403 when self-claiming agent lacks idea:write", async () => {
    mockGetAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid,
      actorUuid: agentUuid,
      roles: ["developer_agent"],
      permissions: ["idea:read"],
    });

    const res = await POST(jsonRequest({}), ctx());
    expect(res.status).toBe(403);
    expect(mockClaimIdea).not.toHaveBeenCalled();
  });
});
