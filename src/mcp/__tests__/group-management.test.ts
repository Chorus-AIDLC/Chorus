import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentAuthContext } from "@/types/auth";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";

const fixture = vi.hoisted(() => ({
  explicitRole: null as string | null,
  localRole: null as string | null,
  prisma: {
    user: { findFirst: vi.fn(async () => null) },
    projectGroup: { findFirst: vi.fn() },
    projectGroupMember: { findFirst: vi.fn(), count: vi.fn() },
    projectMember: { findUnique: vi.fn() },
    project: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  groups: {
    createProjectGroup: vi.fn(), updateProjectGroup: vi.fn(), deleteProjectGroup: vi.fn(), moveProjectToGroup: vi.fn(),
    getGroupVisibilityPreview: vi.fn(), getProjectGroupMovePreview: vi.fn(),
  },
  members: { addGroupMember: vi.fn(), updateGroupMember: vi.fn(), removeGroupMember: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitPresence: vi.fn() } }));
vi.mock("@/services/project-group.service", () => fixture.groups);
vi.mock("@/services/project-group-member.service", () => fixture.members);
vi.mock("@/services/project.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
import { registerAdminTools } from "@/mcp/tools/admin";
import { enablePresence } from "@/mcp/tools/presence";

type Handler = (params: Record<string, unknown>) => Promise<CallToolResult>;
function register(permissions: AgentAuthContext["permissions"] = ["project:read", "project:write"], ownerUuid: string | null = "owner") {
  const auth: AgentAuthContext = { type: "agent", companyUuid: "company", actorUuid: "agent", ownerUuid: ownerUuid ?? undefined, roles: [], permissions, agentName: "A" };
  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, ZodType> = {};
  const server = { registerTool: (name: string, meta: { inputSchema: ZodType }, handler: Handler) => { handlers[name] = handler; schemas[name] = meta.inputSchema; } } as unknown as McpServer;
  enablePresence(server, auth);
  registerAdminTools(server, auth);
  return { handlers, auth, schemas };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.explicitRole = "admin";
  fixture.localRole = null;
  fixture.prisma.projectGroup.findFirst.mockResolvedValue({ uuid: "group", companyUuid: "company", visibility: "private" });
  fixture.prisma.projectGroupMember.findFirst.mockImplementation(async () => fixture.explicitRole ? { role: fixture.explicitRole } : null);
  fixture.prisma.projectGroupMember.count.mockResolvedValue(1);
  fixture.prisma.project.findFirst.mockImplementation(async ({ where }) => where.uuid
    ? { uuid: where.uuid, companyUuid: "company", groupUuid: "group", visibility: "private" }
    : fixture.localRole ? { uuid: "project" } : null);
  fixture.prisma.project.findMany.mockResolvedValue([{ uuid: "project" }]);
  fixture.prisma.projectMember.findUnique.mockImplementation(async () => fixture.localRole ? { role: fixture.localRole } : null);
  fixture.groups.createProjectGroup.mockResolvedValue({ uuid: "group" });
  fixture.groups.updateProjectGroup.mockResolvedValue({ uuid: "group" });
  fixture.groups.deleteProjectGroup.mockResolvedValue(true);
  fixture.groups.moveProjectToGroup.mockResolvedValue({ uuid: "project", groupUuid: null });
  fixture.groups.getGroupVisibilityPreview.mockResolvedValue({ groupUuid: "group", confirmationToken: "visibility-token" });
  fixture.groups.getProjectGroupMovePreview.mockResolvedValue({ projectUuid: "project", confirmationToken: "move-token" });
});

describe("existing MCP group administration contracts", () => {
  it("passes private group creation with the authenticated owner to the shared service", async () => {
    const { handlers, auth } = register();
    await handlers.chorus_admin_create_project_group({ name: "G", visibility: "private" });
    expect(fixture.groups.createProjectGroup).toHaveBeenCalledWith(expect.objectContaining({ auth, visibility: "private", name: "G" }));
  });

  it("previews visibility without writing, then passes the same confirmation to the shared mutation", async () => {
    const { handlers, auth } = register();
    await handlers.chorus_admin_update_project_group({ groupUuid: "group", visibility: "public", preview: true });
    expect(fixture.groups.getGroupVisibilityPreview).toHaveBeenCalledWith(auth, "group", "public");
    expect(fixture.groups.updateProjectGroup).not.toHaveBeenCalled();
    await handlers.chorus_admin_update_project_group({ groupUuid: "group", visibility: "public", confirmationToken: "visibility-token" });
    expect(fixture.groups.updateProjectGroup).toHaveBeenCalledWith(expect.objectContaining({ auth, visibility: "public", confirmationToken: "visibility-token" }));
  });

  it("rejects the retired manual initialization parameter at the tool schema", () => {
    const { schemas } = register();
    expect(schemas.chorus_admin_update_project_group.safeParse({ groupUuid: "group", initializeAccess: true }).success).toBe(false);
    expect(schemas.chorus_admin_update_project_group.safeParse({ groupUuid: "group", name: "Renamed" }).success).toBe(true);
    expect(fixture.groups.updateProjectGroup).not.toHaveBeenCalled();
  });

  it("previews a move separately and forwards the authenticated confirmation", async () => {
    const { handlers, auth } = register();
    await handlers.chorus_admin_move_project_to_group({ projectUuid: "project", groupUuid: null, preview: true });
    expect(fixture.groups.getProjectGroupMovePreview).toHaveBeenCalledWith(auth, "project", null);
    expect(fixture.groups.moveProjectToGroup).not.toHaveBeenCalled();
    await handlers.chorus_admin_move_project_to_group({ projectUuid: "project", groupUuid: null, confirmationToken: "move-token" });
    expect(fixture.groups.moveProjectToGroup).toHaveBeenCalledWith("company", "project", null, auth, "move-token");
  });

  it("passes project deletion policy and authenticated explicit group administration", async () => {
    const { handlers, auth } = register();
    await handlers.chorus_admin_delete_project_group({ groupUuid: "group", deleteProjects: true });
    expect(fixture.groups.deleteProjectGroup).toHaveBeenCalledWith("company", "group", true, auth);
  });

  it.each(["add", "update", "remove"] as const)("exposes %s membership through the existing update tool", async (memberAction) => {
    const { handlers, auth } = register();
    await handlers.chorus_admin_update_project_group({ groupUuid: "group", memberAction, userUuid: "member", ...(memberAction === "remove" ? {} : { role: "editor" }) });
    const service = memberAction === "add" ? fixture.members.addGroupMember : memberAction === "update" ? fixture.members.updateGroupMember : fixture.members.removeGroupMember;
    expect(service).toHaveBeenCalledWith(auth, "group", "member", ...(memberAction === "remove" ? [] : ["editor"]));
    expect(fixture.groups.updateProjectGroup).not.toHaveBeenCalled();
  });

  it("rejects mixed member/settings actions before either mutation", async () => {
    const { handlers } = register();
    expect((await handlers.chorus_admin_update_project_group({ groupUuid: "group", memberAction: "remove", userUuid: "member", name: "G" })).isError).toBe(true);
    expect(fixture.members.removeGroupMember).not.toHaveBeenCalled();
    expect(fixture.groups.updateProjectGroup).not.toHaveBeenCalled();
  });

  it.each(["viewer", "editor"])("explicit private-group %s cannot manage access despite project:write", async (role) => {
    fixture.explicitRole = role;
    const { handlers } = register();
    expect((await handlers.chorus_admin_update_project_group({ groupUuid: "group", visibility: "public", preview: true })).isError).toBe(true);
    expect((await handlers.chorus_admin_delete_project_group({ groupUuid: "group" })).isError).toBe(true);
    expect(fixture.groups.getGroupVisibilityPreview).not.toHaveBeenCalled();
    expect(fixture.groups.deleteProjectGroup).not.toHaveBeenCalled();
  });

  it("project-only Admin discovery grants no group management", async () => {
    fixture.explicitRole = null;
    fixture.localRole = "admin";
    const { handlers } = register();
    expect((await handlers.chorus_admin_update_project_group({ groupUuid: "group", name: "Leak" })).isError).toBe(true);
    expect((await handlers.chorus_admin_delete_project_group({ groupUuid: "group" })).isError).toBe(true);
    expect(fixture.groups.updateProjectGroup).not.toHaveBeenCalled();
  });

  it("ownerless agents cannot manage a hidden private group", async () => {
    fixture.explicitRole = null;
    const { handlers } = register(["project:write"], null);
    expect((await handlers.chorus_admin_update_project_group({ groupUuid: "group", name: "Leak" })).isError).toBe(true);
    expect(fixture.groups.updateProjectGroup).not.toHaveBeenCalled();
  });

  it("project:read alone cannot register group management even for an owner Admin", () => {
    expect(register(["project:read"]).handlers.chorus_admin_update_project_group).toBeUndefined();
  });
});
