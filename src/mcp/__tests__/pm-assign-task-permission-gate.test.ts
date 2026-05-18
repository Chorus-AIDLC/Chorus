// Regression guard: chorus_pm_assign_task gates the assignee by *effective*
// permission (`task:write`), computed from preset + custom permissions —
// not by legacy `roles[]` preset name. So a custom agent that holds
// `task:write` directly is eligible, and an agent that holds neither the
// dev preset nor that bit is rejected.
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockTaskService = vi.hoisted(() => ({
  getTaskByUuid: vi.fn(),
  getTask: vi.fn(),
  claimTask: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getAgentByUuid: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  prisma: { agent: { update: vi.fn() } },
}));

vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/agent.service", () => mockAgentService);
vi.mock("@/lib/prisma", () => mockPrisma);

vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));

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
import { registerPmTools } from "@/mcp/tools/pm";

const companyUuid = "company-1";
const callerUuid = "agent-caller";
const targetUuid = "agent-target";
const taskUuid = "task-1";
const projectUuid = "project-1";

function buildAuth(): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid: callerUuid,
    ownerUuid: "owner-1",
    roles: ["pm_agent"],
    permissions: ["proposal:write", "task:read"] as AgentAuthContext["permissions"],
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
  mockTaskService.getTaskByUuid.mockResolvedValue({
    uuid: taskUuid,
    projectUuid,
    status: "open",
  });
  mockTaskService.getTask.mockResolvedValue({
    uuid: taskUuid,
    title: "T",
    description: null,
    status: "assigned",
  });
  mockTaskService.claimTask.mockResolvedValue({});
  mockActivityService.createActivity.mockResolvedValue(undefined);
});

describe("chorus_pm_assign_task — assignee gate uses effective task:write", () => {
  it("accepts an assignee whose preset grants task:write (developer_agent)", async () => {
    registerWith(buildAuth());
    mockAgentService.getAgentByUuid.mockResolvedValue({
      uuid: targetUuid,
      name: "Dev",
      roles: ["developer_agent"],
      permissions: [],
    });

    const res = await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockTaskService.claimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskUuid,
        assigneeType: "agent",
        assigneeUuid: targetUuid,
      }),
    );
  });

  it("accepts an assignee that holds task:write as a custom permission (no role)", async () => {
    registerWith(buildAuth());
    mockAgentService.getAgentByUuid.mockResolvedValue({
      uuid: targetUuid,
      name: "Custom",
      roles: [],
      permissions: ["task:read", "task:write"],
    });

    const res = await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockTaskService.claimTask).toHaveBeenCalled();
  });

  it("rejects an assignee that lacks task:write (read-only custom agent)", async () => {
    registerWith(buildAuth());
    mockAgentService.getAgentByUuid.mockResolvedValue({
      uuid: targetUuid,
      name: "ReadOnly",
      roles: [],
      permissions: ["task:read"],
    });

    const res = await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/task:write/);
    expect(mockTaskService.claimTask).not.toHaveBeenCalled();
  });

  it("returns 'not found' when the target agent doesn't exist", async () => {
    registerWith(buildAuth());
    mockAgentService.getAgentByUuid.mockResolvedValue(null);

    const res = await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(mockTaskService.claimTask).not.toHaveBeenCalled();
  });
});
