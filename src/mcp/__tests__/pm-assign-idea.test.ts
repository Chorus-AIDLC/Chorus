// Unit tests for chorus_pm_assign_idea — the MCP surface over the human
// assign-idea action (claimIdeaToAgentAction), with actorType:"agent".
//
// Contract under test (design.md Module Contracts 1-2):
//  - Gated idea:admin (permission-map). A non-admin caller never sees the tool.
//  - Agent target must hold idea:write (reuses the effective-permission gate);
//    user target must be same-company; instanceUuid only valid for agent targets
//    and a foreign/unknown pin is rejected.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { ApiError } from "@/lib/api-handler";

const mockIdeaService = vi.hoisted(() => ({
  getIdeaByUuid: vi.fn(),
  assignIdea: vi.fn(),
  claimIdea: vi.fn(),
  releaseIdea: vi.fn(),
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

const mockProjectAgentCwdService = vi.hoisted(() => ({
  resolveProjectAgentCwdTarget: vi.fn(),
}));

const mockUuidResolver = vi.hoisted(() => ({
  isAssignmentOwnedByActor: vi.fn(),
  resolveAssigneeAgentUuid: vi.fn(),
}));

vi.mock("@/services/idea.service", () => mockIdeaService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/agent.service", () => mockAgentService);
vi.mock("@/services/user.service", () => mockUserService);
vi.mock("@/services/project-agent-cwd.service", () => mockProjectAgentCwdService);
vi.mock("@/lib/uuid-resolver", () => mockUuidResolver);

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
const toolSchemas: Record<string, ZodType> = {};

const fakeMcpServer = {
  registerTool: (name: string, meta: { inputSchema: ZodType }, handler: ToolHandler) => {
    toolHandlers[name] = handler;
    toolSchemas[name] = meta.inputSchema;
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
    assignee: null,
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
  mockUuidResolver.resolveAssigneeAgentUuid.mockResolvedValue(null);
  mockProjectAgentCwdService.resolveProjectAgentCwdTarget.mockResolvedValue({
    actorUserUuid: "owner-1",
    source: "unconfigured",
    agentUuid: targetAgentUuid,
    host: null,
    cwd: null,
    availability: "ready",
    promptPolicy: "select",
    connectionUuid: "connection-1",
    agentInstanceUuid: null,
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

  it("assigns with the authenticated executor and leaves transactional audit publication to the service", async () => {
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
        auth: buildAuth(),
      }),
    );
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).wakeRequested).toBe(false);
  });

  it("keeps an unpinned assignment unpinned without publishing a duplicate Activity", async () => {
    await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });
    const assignArgs = mockIdeaService.assignIdea.mock.calls[0][0];
    expect(assignArgs).not.toHaveProperty("instanceUuid");
    expect(assignArgs.auth).toEqual(buildAuth());
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it("resolves the target with the caller owner's project context", async () => {
    await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });

    expect(
      mockProjectAgentCwdService.resolveProjectAgentCwdTarget,
    ).toHaveBeenCalledWith({
      companyUuid,
      actorUserUuid: "owner-1",
      projectUuid,
      agentUuid: targetAgentUuid,
    });
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

  it("forwards instanceUuid and authenticated executor into the audited service", async () => {
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
    expect(mockIdeaService.assignIdea.mock.calls[0][0].auth).toEqual(buildAuth());
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
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

  it("uses a project-fixed target instead of a conflicting explicit instance and returns its provenance", async () => {
    mockProjectAgentCwdService.resolveProjectAgentCwdTarget.mockResolvedValue({
      actorUserUuid: "owner-1",
      source: "project_fixed",
      agentUuid: targetAgentUuid,
      host: "fixed-host",
      cwd: "/fixed/project",
      availability: "ready",
      promptPolicy: "suppress",
      connectionUuid: "fixed-connection",
      agentInstanceUuid: "fixed-instance",
    });
    mockIdeaService.assignIdea.mockResolvedValue({
      uuid: ideaUuid,
      status: "elaborating",
      assignee: { type: "agent_instance", uuid: "fixed-instance" },
    });

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
      instanceUuid: "conflicting-instance",
    });

    expect(mockIdeaService.assignIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceUuid: "fixed-instance",
        cwdSource: "project_fixed",
        cwdHost: "fixed-host",
        runtimeCwd: "/fixed/project",
      }),
    );
    expect(mockIdeaService.assignIdea.mock.calls[0][0].auth).toEqual(buildAuth());
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      assignee: { type: "agent_instance", uuid: "fixed-instance" },
      target: {
        instanceUuid: "fixed-instance",
        resolvedCwdSource: "project_fixed",
        resolvedCwdHost: "fixed-host",
        resolvedRuntimeCwd: "/fixed/project",
      },
    });
  });

  it("deduplicates the Activity when a plain-agent assignee is re-pinned", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue({
      uuid: ideaUuid,
      projectUuid,
      status: "elaborating",
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
    });
    mockUuidResolver.resolveAssigneeAgentUuid.mockResolvedValue(targetAgentUuid);

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
      instanceUuid,
    });

    expect(mockIdeaService.assignIdea).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUuid }),
    );
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      wakeRequested: false,
    });
  });

  it("deduplicates the Activity when an instance-pinned assignee keeps the same owning agent", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue({
      uuid: ideaUuid,
      projectUuid,
      status: "elaborating",
      assigneeType: "agent_instance",
      assigneeUuid: "old-instance",
    });
    mockUuidResolver.resolveAssigneeAgentUuid.mockResolvedValue(targetAgentUuid);

    const res = await toolHandlers["chorus_pm_assign_idea"]({
      ideaUuid,
      assigneeType: "agent",
      assigneeUuid: targetAgentUuid,
      instanceUuid,
    });

    expect(mockIdeaService.assignIdea).toHaveBeenCalled();
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      wakeRequested: false,
    });
  });
});

describe("chorus_pm_assign_idea — user target (AC2/AC4)", () => {
  beforeEach(() => registerWith(buildAuth()));

  it("assigns to a same-company user through the audited service without a pin", async () => {
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
    expect(mockIdeaService.assignIdea.mock.calls[0][0].auth).toEqual(buildAuth());
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
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

describe("MCP assignment authority and operation identity", () => {
  beforeEach(() => registerWith(buildAuth()));

  it.each([true, false])("forwards proof with explicit operation key=%s and cannot forge the authenticated human origin", async (explicit) => {
    const humanAuthorizationUuid = randomUUID();
    const operationUuid = explicit ? randomUUID() : undefined;
    const input = toolSchemas.chorus_pm_assign_idea.parse({
      ideaUuid, assigneeType: "agent", assigneeUuid: targetAgentUuid, humanAuthorizationUuid, operationUuid,
      auth: { type: "user", actorUuid: "forged-human" }, assignedByType: "user", assignedByUuid: "forged-human",
    }) as Record<string, unknown>;
    await toolHandlers.chorus_pm_assign_idea(input);
    expect(mockIdeaService.assignIdea).toHaveBeenCalledWith(expect.objectContaining({
      auth: buildAuth(), humanAuthorizationUuid, operationUuid: operationUuid ?? humanAuthorizationUuid,
      assignedByType: "agent", assignedByUuid: callerUuid,
    }));
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it.each(["humanAuthorizationUuid", "operationUuid"])("rejects malformed %s through the registered schema", (field) => {
    expect(toolSchemas.chorus_pm_assign_idea.safeParse({
      ideaUuid, assigneeType: "agent", assigneeUuid: targetAgentUuid, [field]: "not-a-uuid",
    }).success).toBe(false);
    expect(mockIdeaService.assignIdea).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined, "true"])("derives wakeRequested only from the service's exact boolean kickoff: %s", async (assignmentKickoff) => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue({ uuid: ideaUuid, projectUuid, assigneeType: "agent", assigneeUuid: targetAgentUuid });
    mockUuidResolver.resolveAssigneeAgentUuid.mockResolvedValue(targetAgentUuid);
    mockIdeaService.assignIdea.mockResolvedValue({ uuid: ideaUuid, status: "elaborating", assignmentKickoff });
    const response = await toolHandlers.chorus_pm_assign_idea({
      ideaUuid, assigneeType: "agent", assigneeUuid: targetAgentUuid, humanAuthorizationUuid: randomUUID(),
    });
    expect(JSON.parse(response.content[0].text).wakeRequested).toBe(assignmentKickoff === true);
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it("propagates invalid proof denial without an adapter-side audit or wake", async () => {
    const error = new ApiError("FORBIDDEN", "Assignment authorization is invalid", 403);
    mockIdeaService.assignIdea.mockRejectedValueOnce(error);
    await expect(toolHandlers.chorus_pm_assign_idea({
      ideaUuid, assigneeType: "agent", assigneeUuid: targetAgentUuid, humanAuthorizationUuid: randomUUID(),
    })).rejects.toBe(error);
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });
});

describe("MCP self-claim and release authenticated origin", () => {
  beforeEach(() => registerWith(buildAuth(["idea:write"])));

  it("self-claims as the authenticated agent without inheriting client-supplied human authority or a second audit", async () => {
    mockIdeaService.claimIdea.mockResolvedValue({ uuid: ideaUuid, status: "elaborating" });
    const input = toolSchemas.chorus_claim_idea.parse({
      ideaUuid, auth: { type: "user", actorUuid: "forged-human" }, humanAuthorizationUuid: randomUUID(), assigneeUuid: targetAgentUuid,
    }) as Record<string, unknown>;
    await toolHandlers.chorus_claim_idea(input);
    expect(mockIdeaService.claimIdea).toHaveBeenCalledWith({
      auth: buildAuth(["idea:write"]), ideaUuid, companyUuid, assigneeType: "agent", assigneeUuid: callerUuid,
    });
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it("passes current actor identity to release after checking assignment ownership", async () => {
    mockUuidResolver.isAssignmentOwnedByActor.mockResolvedValue(true);
    mockIdeaService.releaseIdea.mockResolvedValue({ uuid: ideaUuid, status: "open" });
    await toolHandlers.chorus_release_idea({ ideaUuid });
    expect(mockIdeaService.releaseIdea).toHaveBeenCalledWith(ideaUuid, buildAuth(["idea:write"]));
    expect(mockUuidResolver.isAssignmentOwnedByActor).toHaveBeenCalledWith(buildAuth(["idea:write"]), null, null);
  });

  it("never releases another agent's assignment", async () => {
    mockUuidResolver.isAssignmentOwnedByActor.mockResolvedValue(false);
    const result = await toolHandlers.chorus_release_idea({ ideaUuid });
    expect(result.isError).toBe(true);
    expect(mockIdeaService.releaseIdea).not.toHaveBeenCalled();
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });
});
