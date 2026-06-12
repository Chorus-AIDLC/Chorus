// Tests for the project-group-visibility MCP surface (Tech Design §6):
//  - the three new group member-management tools are mapped to the right
//    permission in permission-map.ts (project:admin for mutations, project:read
//    for list)
//  - the guard rejects an inaccessible groupUuid: chorus_list_project_group_members
//    returns an MCP error when canAccessGroup is false, and the mutating tools
//    return an MCP error when canManageGroup is false.
//  - chorus_admin_create_project_group passes visibility, owner (calling actor),
//    and memberUuids through to the service.

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockProjectAccess = vi.hoisted(() => ({
  canAccessProject: vi.fn(),
  canManageProject: vi.fn(),
  claimOrCanManageProject: vi.fn(),
  canAccessGroup: vi.fn(),
  canManageGroup: vi.fn(),
  claimOrCanManageGroup: vi.fn(),
}));

const mockProjectGroupService = vi.hoisted(() => ({
  createProjectGroup: vi.fn(),
  listGroupMembers: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
  moveProjectToGroup: vi.fn(),
  updateProjectGroup: vi.fn(),
  deleteProjectGroup: vi.fn(),
}));

vi.mock("@/lib/authz/project-access", () => mockProjectAccess);
vi.mock("@/services/project.service", () => ({}));
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
const groupUuid = "group-1";

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
  mockProjectAccess.canAccessGroup.mockResolvedValue(true);
  mockProjectAccess.canManageGroup.mockResolvedValue(true);
  mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(true);
  mockProjectGroupService.listGroupMembers.mockResolvedValue([]);
  mockProjectGroupService.addGroupMember.mockResolvedValue({ uuid: "m-1" });
  mockProjectGroupService.removeGroupMember.mockResolvedValue(true);
  mockProjectGroupService.updateProjectGroup.mockResolvedValue({ uuid: "group-1", name: "G" });
  mockProjectGroupService.deleteProjectGroup.mockResolvedValue(true);
  mockProjectGroupService.createProjectGroup.mockResolvedValue({
    uuid: "g-new",
    name: "G",
    description: "",
    visibility: "private",
    projectCount: 0,
    createdAt: "now",
    updatedAt: "now",
  });
});

describe("project group member tools — permission-map wiring", () => {
  it("maps the mutating member tools to project:admin and the list tool to project:read", () => {
    const map = TOOL_PERMISSIONS as Record<string, string>;
    expect(map.chorus_admin_add_project_group_member).toBe("project:admin");
    expect(map.chorus_admin_remove_project_group_member).toBe("project:admin");
    expect(map.chorus_list_project_group_members).toBe("project:read");
  });

  it("registers the group member tools only when the gating permission is present", () => {
    registerWith(buildAuth(["project:admin", "project:read"]));
    expect(toolHandlers.chorus_admin_add_project_group_member).toBeDefined();
    expect(toolHandlers.chorus_admin_remove_project_group_member).toBeDefined();
    expect(toolHandlers.chorus_list_project_group_members).toBeDefined();

    registerWith(buildAuth(["project:write"]));
    expect(toolHandlers.chorus_admin_add_project_group_member).toBeUndefined();
    expect(toolHandlers.chorus_admin_remove_project_group_member).toBeUndefined();
    expect(toolHandlers.chorus_list_project_group_members).toBeUndefined();
  });
});

describe("project group member tools — access guards", () => {
  it("chorus_list_project_group_members rejects an inaccessible group (canAccessGroup=false)", async () => {
    registerWith(buildAuth(["project:read"]));
    mockProjectAccess.canAccessGroup.mockResolvedValue(false);

    const res = await toolHandlers.chorus_list_project_group_members({ groupUuid });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/access denied/i);
    expect(mockProjectGroupService.listGroupMembers).not.toHaveBeenCalled();
  });

  it("chorus_list_project_group_members returns members when access is granted", async () => {
    registerWith(buildAuth(["project:read"]));
    mockProjectGroupService.listGroupMembers.mockResolvedValue([
      { uuid: "m-1", memberType: "agent", memberUuid: actorUuid, role: "member", createdAt: "now" },
    ]);

    const res = await toolHandlers.chorus_list_project_group_members({ groupUuid });

    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.listGroupMembers).toHaveBeenCalledWith(companyUuid, groupUuid);
    expect(res.content[0].text).toContain("m-1");
  });

  it("chorus_admin_add_project_group_member rejects when canManageGroup=false", async () => {
    registerWith(buildAuth(["project:admin"]));
    mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_add_project_group_member({
      groupUuid,
      memberType: "user",
      memberUuid: "user-9",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/access denied/i);
    expect(mockProjectGroupService.addGroupMember).not.toHaveBeenCalled();
  });

  it("chorus_admin_add_project_group_member adds the member when the actor can manage", async () => {
    registerWith(buildAuth(["project:admin"]));

    const res = await toolHandlers.chorus_admin_add_project_group_member({
      groupUuid,
      memberType: "user",
      memberUuid: "user-9",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.addGroupMember).toHaveBeenCalledWith(
      companyUuid,
      groupUuid,
      "user",
      "user-9",
    );
  });

  it("chorus_admin_remove_project_group_member rejects when canManageGroup=false", async () => {
    registerWith(buildAuth(["project:admin"]));
    mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_remove_project_group_member({
      groupUuid,
      memberType: "agent",
      memberUuid: "agent-9",
    });

    expect(res.isError).toBe(true);
    expect(mockProjectGroupService.removeGroupMember).not.toHaveBeenCalled();
  });

  it("chorus_admin_remove_project_group_member removes the member when the actor can manage", async () => {
    registerWith(buildAuth(["project:admin"]));

    const res = await toolHandlers.chorus_admin_remove_project_group_member({
      groupUuid,
      memberType: "agent",
      memberUuid: "agent-9",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.removeGroupMember).toHaveBeenCalledWith(
      companyUuid,
      groupUuid,
      "agent",
      "agent-9",
    );
  });
});

describe("chorus_admin_create_project_group — visibility + ownership", () => {
  it("passes visibility, owner (calling actor), and memberUuids to the service", async () => {
    registerWith(buildAuth(["project:write"]));

    const res = await toolHandlers.chorus_admin_create_project_group({
      name: "G",
      visibility: "private",
      memberUuids: [{ memberType: "agent", memberUuid: "agent-2" }],
    });

    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.createProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        name: "G",
        visibility: "private",
        ownerType: "agent",
        ownerUuid: actorUuid,
        memberUuids: [{ memberType: "agent", memberUuid: "agent-2" }],
      }),
    );
  });
});

describe("chorus_admin_update_project_group / delete_project_group — manage gate", () => {
  it("update rejects a non-owner (canManageGroup=false) without updating", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_update_project_group({ groupUuid, name: "X" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found or access denied/i);
    expect(mockProjectGroupService.updateProjectGroup).not.toHaveBeenCalled();
  });

  it("update succeeds for the owner (canManageGroup=true)", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(true);

    const res = await toolHandlers.chorus_admin_update_project_group({ groupUuid, name: "X" });
    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.updateProjectGroup).toHaveBeenCalled();
  });

  it("delete rejects a non-owner without deleting", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(false);

    const res = await toolHandlers.chorus_admin_delete_project_group({ groupUuid });
    expect(res.isError).toBe(true);
    expect(mockProjectGroupService.deleteProjectGroup).not.toHaveBeenCalled();
  });

  it("delete succeeds for the owner", async () => {
    registerWith(buildAuth(["project:write"]));
    mockProjectAccess.claimOrCanManageGroup.mockResolvedValue(true);

    const res = await toolHandlers.chorus_admin_delete_project_group({ groupUuid });
    expect(res.isError).toBeFalsy();
    expect(mockProjectGroupService.deleteProjectGroup).toHaveBeenCalledWith(companyUuid, groupUuid);
  });
});
