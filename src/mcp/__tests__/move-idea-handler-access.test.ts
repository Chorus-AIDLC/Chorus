// Handler-level checks for chorus_move_idea (fix-idea-move-dangling-assignee
// D4). The central MCP gate also authorizes ideaUuid / targetProjectUuid (see
// project-access.integration.test.ts); these tests register the PM tools on a
// bare fake server, so they prove the handler enforces caller access itself
// and names every blocked assignee in its error text.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEntityAccess: vi.fn(),
  requireProjectAccess: vi.fn(),
  moveIdea: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn(), emitPresence: vi.fn() } }));
vi.mock("@/services/project-access.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/project-access.service")>()),
  requireEntityAccess: mocks.requireEntityAccess,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/services/idea.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/idea.service")>()),
  moveIdea: mocks.moveIdea,
}));

import type { AgentAuthContext } from "@/types/auth";
import { registerPmTools } from "@/mcp/tools/pm";
import { ProjectAccessDeniedError, ProjectNotFoundError } from "@/services/project-access.service";
import { AssigneeAccessError } from "@/services/task.service";
import { formatBlockedAssigneesMessage, type BlockedAssignee } from "@/services/idea.service";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResult>;

const auth: AgentAuthContext = {
  type: "agent",
  companyUuid: "company",
  actorUuid: "agent",
  ownerUuid: "owner",
  roles: [],
  permissions: ["idea:read", "idea:write"] as AgentAuthContext["permissions"],
  agentName: "mover",
};

function moveHandler(): ToolHandler {
  const handlers: Record<string, ToolHandler> = {};
  const server = { registerTool: (name: string, _c: unknown, h: ToolHandler) => { handlers[name] = h; } };
  registerPmTools(server as unknown as Parameters<typeof registerPmTools>[0], auth);
  return handlers.chorus_move_idea;
}

const params = { ideaUuid: "idea-1", targetProjectUuid: "target" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEntityAccess.mockResolvedValue({ projectUuid: "source", accessLevel: "editor" });
  mocks.requireProjectAccess.mockResolvedValue({ uuid: "target", accessLevel: "editor" });
  mocks.moveIdea.mockResolvedValue({
    uuid: "idea-1",
    project: { uuid: "target", name: "Target" },
    moved: { ideas: 1, proposals: 0, documents: 0, tasks: 0, activities: 1 },
  });
});

describe("chorus_move_idea handler caller access", () => {
  it("is registered for idea:write alone and checks Editor on source idea and target", async () => {
    const result = await moveHandler()(params);
    expect(result.isError).toBeFalsy();
    expect(mocks.requireEntityAccess).toHaveBeenCalledWith(auth, "idea", "idea-1", "editor");
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(auth, "target", "editor");
    expect(mocks.moveIdea).toHaveBeenCalledWith("company", "idea-1", "target", "agent", "agent");
  });

  it("maps a hidden or missing target to 'Target project not found' without moving", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new ProjectNotFoundError("project"));
    const result = await moveHandler()(params);
    expect(result).toEqual({ content: [{ type: "text", text: "Target project not found" }], isError: true });
    expect(mocks.moveIdea).not.toHaveBeenCalled();
  });

  it("rejects a target the caller can only view without moving", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new ProjectAccessDeniedError());
    const result = await moveHandler()(params);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Failed to move Idea: Insufficient project access");
    expect(mocks.moveIdea).not.toHaveBeenCalled();
  });

  it("rejects an idea the caller can only view without moving", async () => {
    mocks.requireEntityAccess.mockRejectedValue(new ProjectAccessDeniedError());
    const result = await moveHandler()(params);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Failed to move Idea: Insufficient project access");
    expect(mocks.requireProjectAccess).not.toHaveBeenCalled();
    expect(mocks.moveIdea).not.toHaveBeenCalled();
  });

  it("rejects a hidden idea as not found without moving", async () => {
    mocks.requireEntityAccess.mockRejectedValue(new ProjectNotFoundError("idea"));
    const result = await moveHandler()(params);
    expect(result.content[0].text).toBe("Failed to move Idea: Idea not found");
    expect(mocks.moveIdea).not.toHaveBeenCalled();
  });
});

describe("chorus_move_idea blocked-assignee error", () => {
  const blockedAssignees: BlockedAssignee[] = [
    { assigneeType: "agent", assigneeUuid: "a-1", name: "Builder Bot",
      entities: [{ type: "task", uuid: "t-1", title: "T1" }, { type: "task", uuid: "t-2", title: "T2" }] },
    { assigneeType: "user", assigneeUuid: "u-1", name: "Ada Lovelace",
      entities: [{ type: "idea", uuid: "i-1", title: "I1" }] },
    { assigneeType: "agent_instance", assigneeUuid: "inst-9", name: null,
      entities: [{ type: "idea", uuid: "i-2", title: "I2" }, { type: "task", uuid: "t-3", title: "T3" }] },
  ];

  it("names every blocked assignee from the error details", async () => {
    // A generic message proves the text is built from details, not the message.
    mocks.moveIdea.mockRejectedValue(new AssigneeAccessError(undefined, { blockedAssignees }));
    const result = await moveHandler()(params);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toBe(`Failed to move Idea: ${formatBlockedAssigneesMessage(blockedAssignees)}`);
    expect(text).toContain("Builder Bot (2 tasks)");
    expect(text).toContain("Ada Lovelace (1 idea)");
    // Unnamed assignees fall back to their uuid.
    expect(text).toContain("inst-9 (1 idea + 1 task)");
  });

  it("falls back to the error message when no details are attached", async () => {
    mocks.moveIdea.mockRejectedValue(new AssigneeAccessError());
    const result = await moveHandler()(params);
    expect(result.content[0].text).toBe("Failed to move Idea: Assignee does not have access to this project");
  });
});
