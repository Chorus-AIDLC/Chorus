// Handler-level coverage for chorus_edit_idea: empty-edit rejection, the
// title/content -> updateIdea path (with actor context for the "edited"
// activity), and the parentUuid -> setIdeaParent routing (so the cycle +
// same-project guard always applies, never a bare update). Mirrors the
// fake-MCP-server harness used by pm-assign-task-permission-gate.test.ts.
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockIdeaService = vi.hoisted(() => ({
  getIdeaByUuid: vi.fn(),
  updateIdea: vi.fn(),
  setIdeaParent: vi.fn(),
}));

vi.mock("@/services/idea.service", () => mockIdeaService);
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("@/services/agent.service", () => ({}));
vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import type { AgentAuthContext } from "@/types/auth";
import { registerPmTools } from "@/mcp/tools/pm";

const companyUuid = "company-1";
const callerUuid = "agent-caller";
const ideaUuid = "idea-1";

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

function buildAuth(): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid: callerUuid,
    ownerUuid: "owner-1",
    roles: ["pm_agent"],
    permissions: ["idea:write"] as AgentAuthContext["permissions"],
    agentName: "caller",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  registerPmTools(
    fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0],
    buildAuth(),
  );
  mockIdeaService.getIdeaByUuid.mockResolvedValue({ uuid: ideaUuid, title: "Old", parentUuid: null });
  mockIdeaService.updateIdea.mockResolvedValue({ uuid: ideaUuid, title: "New" });
  mockIdeaService.setIdeaParent.mockResolvedValue({ uuid: ideaUuid, parentUuid: "parent-1" });
});

describe("chorus_edit_idea handler", () => {
  it("is registered for an idea:write agent", () => {
    expect(typeof toolHandlers["chorus_edit_idea"]).toBe("function");
    // The old dedicated tool is gone.
    expect(toolHandlers["chorus_pm_set_idea_parent"]).toBeUndefined();
  });

  it("rejects an empty edit (no title/content/parentUuid)", async () => {
    const res = await toolHandlers["chorus_edit_idea"]({ ideaUuid });
    expect(res.isError).toBe(true);
    expect(mockIdeaService.updateIdea).not.toHaveBeenCalled();
    expect(mockIdeaService.setIdeaParent).not.toHaveBeenCalled();
  });

  it("rejects when the idea does not exist", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValueOnce(null);
    const res = await toolHandlers["chorus_edit_idea"]({ ideaUuid, title: "X" });
    expect(res.isError).toBe(true);
    expect(mockIdeaService.updateIdea).not.toHaveBeenCalled();
  });

  it("edits title/content via updateIdea WITH actor context (drives the 'edited' activity)", async () => {
    const res = await toolHandlers["chorus_edit_idea"]({ ideaUuid, title: "New", content: "Body" });
    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.updateIdea).toHaveBeenCalledWith(
      ideaUuid,
      companyUuid,
      { title: "New", content: "Body" },
      { actorType: "agent", actorUuid: callerUuid },
    );
    // Pure title/content edit must not touch the lineage parent.
    expect(mockIdeaService.setIdeaParent).not.toHaveBeenCalled();
  });

  it("routes parentUuid through setIdeaParent (the cycle/same-project guard), not a bare update", async () => {
    const res = await toolHandlers["chorus_edit_idea"]({ ideaUuid, parentUuid: "parent-1" });
    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.setIdeaParent).toHaveBeenCalledWith(ideaUuid, "parent-1", companyUuid, { actorType: "agent", actorUuid: callerUuid });
    // Parent-only edit must not call updateIdea (no title/content change).
    expect(mockIdeaService.updateIdea).not.toHaveBeenCalled();
  });

  it("detaches when parentUuid is null", async () => {
    mockIdeaService.setIdeaParent.mockResolvedValueOnce({ uuid: ideaUuid, parentUuid: null });
    const res = await toolHandlers["chorus_edit_idea"]({ ideaUuid, parentUuid: null });
    expect(res.isError).toBeFalsy();
    expect(mockIdeaService.setIdeaParent).toHaveBeenCalledWith(ideaUuid, null, companyUuid, { actorType: "agent", actorUuid: callerUuid });
  });

  it("surfaces a cycle error from setIdeaParent as a tool error", async () => {
    mockIdeaService.setIdeaParent.mockRejectedValueOnce(new Error("Cannot set parent: would create a cycle"));
    const res = await toolHandlers["chorus_edit_idea"]({ ideaUuid, parentUuid: "descendant-1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/cycle/i);
  });
});
