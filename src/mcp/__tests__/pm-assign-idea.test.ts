// Unit tests for chorus_pm_assign_idea — the MCP surface over the human
// assign-idea action (claimIdeaToAgentAction), with actorType:"agent".
//
// Contract under test (design.md Module Contracts 1-2):
//  - Gated idea:admin (permission-map). A non-admin caller never sees the tool.
//  - Agent target must hold idea:write (reuses the effective-permission gate);
//    user target must be same-company; instanceUuid only valid for agent targets
//    and a foreign/unknown pin is rejected.
//  - Reuses ideaService.assignIdea (silent takeover; open→elaborating else
//    status preserved) and — CRITICALLY — emits the actor-bearing `assigned`
//    Activity that drives the existing idea_claimed wake.
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockIdeaService = vi.hoisted(() => ({
  getIdeaByUuid: vi.fn(),
  assignIdea: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getAgentByUuid: vi.fn(),
}));

const mockUserService = vi.hoisted(() => ({
  getUserByUuid: vi.fn(),
}));

vi.mock("@/services/idea.service", () => mockIdeaService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/agent.service", () => mockAgentService);
vi.mock("@/services/user.service", () => mockUserService);

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));

import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { registerPmTools } from "@/mcp/tools/pm";
import { TOOL_PERMISSIONS } from "@/mcp/tools/permission-map";

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const toolHandlers: Record<string, ToolHandler> = {};

const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

const companyUuid = "company-1";
const callerUuid = "agent-caller";
const targetAgentUuid = "agent-target";
const targetUserUuid = "user-target";
const ideaUuid = "idea-1";
const projectUuid = "project-1";
const instanceUuid = "instance-1";

function buildAuth(permissions: Permission[] = ["idea:admin"]): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid: callerUuid,
    ownerUuid: "owner-1",
    roles: ["admin_agent"],
    permissions,
    agentName: "caller",
  };
}

function registerWith(auth: AgentAuthContext) {
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  registerPmTools(
    fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0],
    auth,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdeaService.getIdeaByUuid.mockResolvedValue({
    uuid: ideaUuid,
    projectUuid,
    status: "open",
    assigneeType: null,
    assigneeUuid: null,
  });
  mockIdeaService.assignIdea.mockResolvedValue({
    uuid: ideaUuid,
    status: "elaborating",
    assignee: { type: "agent", uuid: targetAgentUuid },
  });
  mockActivityService.createActivity.mockResolvedValue(undefined);
  mockAgentService.getAgentByUuid.mockResolvedValue({
    uuid: targetAgentUuid,
    name: "PM Bot",
    roles: [],
    permissions: ["idea:read", "idea:write"],
  });
  mockUserService.getUserByUuid.mockResolvedValue({
    uuid: targetUserUuid,
    companyUuid,
  });
});

describe("chorus_pm_assign_idea — permission gating (AC1)", () => {
  it("is mapped to idea:admin in the permission map", () => {
    expect(
      (TOOL_PERMISSIONS as Record<string, string>).chorus_pm_assign_idea,
    ).toBe("idea:admin");
  });

  it("is registered for an idea:admin agent", () => {
    registerWith(buildAuth(["idea:admin"]));
    expect(typeof toolHandlers["chorus_pm_assign_idea"]).toBe("function");
  });

  it("is NOT registered for an idea:write-only (non-admin) agent", () => {
    registerWith(buildAuth(["idea:write"]));
    expect(toolHandlers["chorus_pm_assign_idea"]).toBeUndefined();
  });
});

describe("chorus_pm_assign_idea — agent target (AC2/AC4)", () => {
  beforeEach(() => registerWith(buildAuth()));

  it("assigns to an eligible agent and emits the actor-bearing assigned Activity", async () => {
    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.assignIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaUuid,
        companyUuid,
        assigneeType: "agent",
        assigneeUuid: targetAgentUuid,
        assignedByType: "agent",
        assignedByUuid: callerUuid,
      }),
    );
    // The critical wake trigger: assigned Activity, actorType agent, caller as actor.
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
        targetType: "idea",
        targetUuid: ideaUuid,
        action: "assigned",
        actorType: "agent",
        actorUuid: callerUuid,
        value: expect.objectContaining({
          assigneeType: "agent",
          assigneeUuid: targetAgentUuid,
        }),
      }),
    );
  });

  it("does not forward instanceUuid to assignIdea nor the Activity when unpinned", async () => {
    await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });
    const assignArgs = mockIdeaService.assignIdea.mock.calls[0][0];
    expect(assignArgs).not.toHaveProperty("instanceUuid");
    const activityValue = mockActivityService.createActivity.mock.calls[0][0].value;
    expect(activityValue).not.toHaveProperty("instanceUuid");
  });

  it("rejects an ineligible agent (no idea:write) without changing the assignee", async () => {
    mockAgentService.getAgentByUuid.mockResolvedValue({
      uuid: targetAgentUuid,
      name: "ReadOnly",
      roles: [],
      permissions: ["idea:read"],
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/idea:write/);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it("accepts an agent whose idea:write comes from a preset (roles)", async () => {
    mockAgentService.getAgentByUuid.mockResolvedValue({
      uuid: targetAgentUuid,
      name: "PM Preset",
      roles: ["pm_agent"],
      permissions: [],
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.assignIdea).toHaveBeenCalled();
  });

  it("returns 'not found' when the target agent does not exist", async () => {
    mockAgentService.getAgentByUuid.mockResolvedValue(null);

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
  });
});

describe("chorus_pm_assign_idea — instance pin (AC2)", () => {
  beforeEach(() => registerWith(buildAuth()));

  it("forwards instanceUuid into assignIdea and the Activity value when provided", async () => {
    await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
      instanceUuid,
    });

    expect(mockIdeaService.assignIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "agent",
        assigneeUuid: targetAgentUuid,
        instanceUuid,
      }),
    );
    // Value mirrors the human path: raw agent identity + the pinned instance uuid.
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          assigneeType: "agent",
          assigneeUuid: targetAgentUuid,
          instanceUuid,
        }),
      }),
    );
  });

  it("rejects a foreign/unknown instance pin surfaced by the service", async () => {
    mockIdeaService.assignIdea.mockRejectedValueOnce(
      new Error("Agent instance not found"),
    );

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
      instanceUuid: "instance-does-not-exist",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Agent instance not found/);
  });
});

describe("chorus_pm_assign_idea — user target (AC2/AC4)", () => {
  beforeEach(() => registerWith(buildAuth()));

  it("assigns to a same-company user and emits the assigned Activity (no instance)", async () => {
    mockIdeaService.assignIdea.mockResolvedValue({
      uuid: ideaUuid,
      status: "elaborating",
      assignee: { type: "user", uuid: targetUserUuid },
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "user",
      assigneeUuid: targetUserUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.assignIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeType: "user",
        assigneeUuid: targetUserUuid,
        assignedByType: "agent",
        assignedByUuid: callerUuid,
      }),
    );
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assigned",
        actorType: "agent",
        value: expect.objectContaining({
          assigneeType: "user",
          assigneeUuid: targetUserUuid,
        }),
      }),
    );
    // Agent-eligibility lookup must NOT be consulted for a user target.
    expect(mockAgentService.getAgentByUuid).not.toHaveBeenCalled();
  });

  it("rejects a user from another company", async () => {
    mockUserService.getUserByUuid.mockResolvedValue({
      uuid: targetUserUuid,
      companyUuid: "other-company",
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "user",
      assigneeUuid: targetUserUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
  });

  it("rejects a non-existent user", async () => {
    mockUserService.getUserByUuid.mockResolvedValue(null);

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "user",
      assigneeUuid: targetUserUuid,
    });

    expect(res.isError).toBe(true);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
  });

  it("rejects instanceUuid supplied with a user target (pin only valid for agents)", async () => {
    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "user",
      assigneeUuid: targetUserUuid,
      instanceUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/instanceUuid/);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
  });
});

describe("chorus_pm_assign_idea — takeover & status (AC3)", () => {
  beforeEach(() => registerWith(buildAuth()));

  it("silently takes over an already-assigned idea (delegates to assignIdea, no pre-check)", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue({
      uuid: ideaUuid,
      projectUuid,
      status: "elaborating",
      assigneeType: "agent",
      assigneeUuid: "someone-else",
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.assignIdea).toHaveBeenCalled();
  });

  it("surfaces open→elaborating status produced by assignIdea", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue({
      uuid: ideaUuid,
      projectUuid,
      status: "open",
    });
    mockIdeaService.assignIdea.mockResolvedValue({
      uuid: ideaUuid,
      status: "elaborating",
      assignee: { type: "agent", uuid: targetAgentUuid },
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.status).toBe("elaborating");
  });

  it("preserves a non-open status (elaborated) produced by assignIdea (backfill-safe)", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue({
      uuid: ideaUuid,
      projectUuid,
      status: "elaborated",
    });
    mockIdeaService.assignIdea.mockResolvedValue({
      uuid: ideaUuid,
      status: "elaborated",
      assignee: { type: "agent", uuid: targetAgentUuid },
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.status).toBe("elaborated");
  });
});

describe("chorus_pm_assign_idea — idea lookup", () => {
  beforeEach(() => registerWith(buildAuth()));

  it("returns 'not found' when the idea is absent in this company", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue(null);

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
  });
});
