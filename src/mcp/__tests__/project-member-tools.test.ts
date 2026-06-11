// Tests for the project-visibility MCP surface (Tech Design §6):
//  - the three new member-management tools are mapped to the right permission
//    in permission-map.ts (project:admin for mutations, project:read for list)
//  - the guard rejects an inaccessible projectUuid: chorus_list_project_members
//    returns an MCP error when canAccessProject is false, and the mutating tools
//    return an MCP error when canManageProject is false.

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockProjectAccess = vi.hoisted(() => ({
  canAccessProject: vi.fn(),
  canManageProject: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  listProjectMembers: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  createProject: vi.fn(),
}));

const mockProjectGroupService = vi.hoisted(() => ({
  moveProjectToGroup: vi.fn(),
}));

vi.mock("@/lib/authz/project-access", () => mockProjectAccess);
vi.mock("@/services/project.service", () => mockProjectService);
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("@/services/project-group.service", () => mockProjectGroupService);

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

import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { registerAdminTools } from "@/mcp/tools/admin";
import { TOOL_PERMISSIONS } from "@/mcp/tools/permission-map";

const companyUuid = "company-1";
const actorUuid = "agent-1";
const projectUuid = "project-1";

function buildAuth(permissions: Permission[]): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid,
    roles: [],
    permissions,
    agentName: "admin",
  };
}

function registerWith(auth: AgentAuthContext) {
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  registerAdminTools(
    fakeMcpServer as unknown as Parameters<typeof registerAdminTools>[0],
    auth,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectAccess.canAccessProject.mockResolvedValue(true);
  mockProjectAccess.canManageProject.mockResolvedValue(true);
  mockProjectService.listProjectMembers.mockResolvedValue([]);
  mockProjectService.addProjectMember.mockResolvedValue({ uuid: "m-1" });
  mockProjectService.removeProjectMember.mockResolvedValue(true);
  mockProjectGroupService.moveProjectToGroup.mockResolvedValue({ uuid: projectUuid, name: "P", groupUuid: null });
});

describe("chorus_admin_move_project_to_group — visibility guard", () => {
  it("rejects a non-manager (canManageProject=false) without moving", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectAccess.canManageProject.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_move_project_to_group({
      projectUuid,
      groupUuid: null,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/access denied/i);
    expect(mockProjectGroupService.moveProjectToGroup).not.toHaveBeenCalled();
  });

  it("moves the project when the actor can manage it", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectAccess.canManageProject.mockResolvedValue(true);

    const res = await toolHandlers.chorus_admin_move_project_to_group({
      projectUuid,
      groupUuid: null,
    });

    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.moveProjectToGroup).toHaveBeenCalledWith(
      companyUuid,
      projectUuid,
      null,
    );
  });
});

describe("project member tools — permission-map wiring", () => {
  it("maps the mutating member tools to project:admin and the list tool to project:read", () => {
    const map = TOOL_PERMISSIONS as Record<string, string>;
    expect(map.chorus_admin_add_project_member).toBe("project:admin");
    expect(map.chorus_admin_remove_project_member).toBe("project:admin");
    expect(map.chorus_list_project_members).toBe("project:read");
  });

  it("registers the member tools only when the gating permission is present", () => {
    registerWith(buildAuth(["project:admin", "project:read"]));
    expect(toolHandlers.chorus_admin_add_project_member).toBeDefined();
    expect(toolHandlers.chorus_admin_remove_project_member).toBeDefined();
    expect(toolHandlers.chorus_list_project_members).toBeDefined();

    registerWith(buildAuth(["project:write"]));
    expect(toolHandlers.chorus_admin_add_project_member).toBeUndefined();
    expect(toolHandlers.chorus_admin_remove_project_member).toBeUndefined();
    expect(toolHandlers.chorus_list_project_members).toBeUndefined();
  });
});

describe("project member tools — access guards", () => {
  it("chorus_list_project_members rejects an inaccessible project (canAccessProject=false)", async () => {
    registerWith(buildAuth(["project:read"]));
    mockProjectAccess.canAccessProject.mockResolvedValue(false);

    const res = await toolHandlers.chorus_list_project_members({ projectUuid });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/access denied/i);
    expect(mockProjectService.listProjectMembers).not.toHaveBeenCalled();
  });

  it("chorus_list_project_members returns members when access is granted", async () => {
    registerWith(buildAuth(["project:read"]));
    mockProjectService.listProjectMembers.mockResolvedValue([
      { uuid: "m-1", memberType: "agent", memberUuid: actorUuid, role: "member", createdAt: "now" },
    ]);

    const res = await toolHandlers.chorus_list_project_members({ projectUuid });

    expect(res.isError).toBeFalsy();
    expect(mockProjectService.listProjectMembers).toHaveBeenCalledWith(companyUuid, projectUuid);
    expect(res.content[0].text).toContain("m-1");
  });

  it("chorus_admin_add_project_member rejects when canManageProject=false", async () => {
    registerWith(buildAuth(["project:admin"]));
    mockProjectAccess.canManageProject.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_add_project_member({
      projectUuid,
      memberType: "user",
      memberUuid: "user-9",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/access denied/i);
    expect(mockProjectService.addProjectMember).not.toHaveBeenCalled();
  });

  it("chorus_admin_add_project_member adds the member when the actor can manage", async () => {
    registerWith(buildAuth(["project:admin"]));

    const res = await toolHandlers.chorus_admin_add_project_member({
      projectUuid,
      memberType: "user",
      memberUuid: "user-9",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProjectService.addProjectMember).toHaveBeenCalledWith(
      companyUuid,
      projectUuid,
      "user",
      "user-9",
    );
  });

  it("chorus_admin_remove_project_member rejects when canManageProject=false", async () => {
    registerWith(buildAuth(["project:admin"]));
    mockProjectAccess.canManageProject.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_remove_project_member({
      projectUuid,
      memberType: "agent",
      memberUuid: "agent-9",
    });

    expect(res.isError).toBe(true);
    expect(mockProjectService.removeProjectMember).not.toHaveBeenCalled();
  });
});

describe("chorus_admin_create_project — visibility + ownership", () => {
  it("passes visibility, owner (calling actor), and memberUuids to the service", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectService.createProject.mockResolvedValue({
      uuid: "p-new",
      name: "P",
      groupUuid: null,
      visibility: "private",
    });

    const res = await toolHandlers.chorus_admin_create_project({
      name: "P",
      visibility: "private",
      memberUuids: [{ memberType: "agent", memberUuid: "agent-2" }],
    });

    expect(res.isError).toBeFalsy();
    expect(mockProjectService.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        name: "P",
        visibility: "private",
        ownerType: "agent",
        ownerUuid: actorUuid,
        memberUuids: [{ memberType: "agent", memberUuid: "agent-2" }],
      }),
    );
  });
});
