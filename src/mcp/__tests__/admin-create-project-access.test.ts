// chorus_admin_create_project: the agent's owner becomes the creator/admin,
// and private creation is refused for ownerless agents.
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockProjectService = vi.hoisted(() => ({ createProject: vi.fn() }));
vi.mock("@/services/project.service", () => mockProjectService);
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

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
import { registerAdminTools } from "@/mcp/tools/admin";

function register(ownerUuid?: string) {
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  const auth: AgentAuthContext = {
    type: "agent",
    companyUuid: "company-1",
    actorUuid: "agent-1",
    ownerUuid,
    roles: ["admin_agent"],
    permissions: ["project:write"] as AgentAuthContext["permissions"],
    agentName: "admin",
  };
  registerAdminTools(fakeMcpServer as unknown as Parameters<typeof registerAdminTools>[0], auth);
}

describe("chorus_admin_create_project — access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.createProject.mockResolvedValue({ uuid: "p-1", name: "N", groupUuid: null });
  });

  it("records the agent's owner as creator and defaults to public", async () => {
    register("owner-1");
    const res = await toolHandlers.chorus_admin_create_project({ name: "N" });
    expect(res.isError).toBeUndefined();
    expect(mockProjectService.createProject).toHaveBeenCalledWith(expect.objectContaining({
      visibility: "public",
      createdByUuid: "owner-1",
      actor: { type: "agent", uuid: "agent-1" },
    }));
  });

  it("passes private visibility through", async () => {
    register("owner-1");
    await toolHandlers.chorus_admin_create_project({ name: "N", visibility: "private" });
    expect(mockProjectService.createProject).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private" }));
  });

  it("refuses private creation for an ownerless agent", async () => {
    register(undefined);
    const res = await toolHandlers.chorus_admin_create_project({ name: "N", visibility: "private" });
    expect(res.isError).toBe(true);
    expect(mockProjectService.createProject).not.toHaveBeenCalled();
  });
});
