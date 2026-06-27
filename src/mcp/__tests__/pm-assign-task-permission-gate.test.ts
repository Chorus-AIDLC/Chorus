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

// add-agent-instance-addressing (T7): chorus_pm_assign_task accepts an optional
// `instanceUuid` (replacing the removed targetHost/targetCwd) and forwards it
// into claimTask so the task is persisted as an `agent_instance` assignment.
// Absent → a plain agent assignment, byte-identical to before.
describe("chorus_pm_assign_task — optional instance pin", () => {
  const instanceUuid = "instance-1";

  beforeEach(() => {
    mockAgentService.getAgentByUuid.mockResolvedValue({
      uuid: targetUuid,
      name: "Dev",
      roles: ["developer_agent"],
      permissions: [],
    });
  });

  it("forwards instanceUuid into claimTask when provided", async () => {
    registerWith(buildAuth());

    const res = await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
      instanceUuid,
    });

    expect(res.isError).toBeFalsy();
    expect(mockTaskService.claimTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskUuid,
        assigneeType: "agent",
        assigneeUuid: targetUuid,
        instanceUuid,
      }),
    );
  });

  it("logs an agent_instance assignment activity carrying the instance uuid", async () => {
    registerWith(buildAuth());

    await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
      instanceUuid,
    });

    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assigned",
        value: expect.objectContaining({
          assigneeType: "agent_instance",
          assigneeUuid: instanceUuid,
          agentUuid: targetUuid,
          instanceUuid,
        }),
      }),
    );
  });

  it("omits instanceUuid from claimTask args when not provided (backward-compatible)", async () => {
    registerWith(buildAuth());

    await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
    });

    const claimArgs = mockTaskService.claimTask.mock.calls[0][0];
    expect(claimArgs).not.toHaveProperty("instanceUuid");
    // No more legacy pin columns either.
    expect(claimArgs).not.toHaveProperty("targetHost");
    expect(claimArgs).not.toHaveProperty("targetCwd");
    // Plain agent assignment activity (no instance fields).
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          assigneeType: "agent",
          assigneeUuid: targetUuid,
        }),
      }),
    );
    const activityValue = mockActivityService.createActivity.mock.calls[0][0].value;
    expect(activityValue).not.toHaveProperty("instanceUuid");
  });

  it("rejects with a tool error when the service rejects an unknown / foreign-company instance", async () => {
    registerWith(buildAuth());
    mockTaskService.claimTask.mockRejectedValueOnce(new Error("Agent instance not found"));

    const res = await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
      instanceUuid: "instance-does-not-exist",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Agent instance not found/);
  });

  it("no longer accepts targetHost/targetCwd (legacy pin shape removed)", async () => {
    registerWith(buildAuth());

    // Passing the legacy keys must not surface them anywhere downstream.
    await toolHandlers["chorus_pm_assign_task"]({
      taskUuid,
      agentUuid: targetUuid,
      targetHost: "ci-runner-02",
      targetCwd: "/home/u/dev/chorus",
    });

    const claimArgs = mockTaskService.claimTask.mock.calls[0][0];
    expect(claimArgs).not.toHaveProperty("targetHost");
    expect(claimArgs).not.toHaveProperty("targetCwd");
    expect(claimArgs).not.toHaveProperty("instanceUuid");
    const activityValue = mockActivityService.createActivity.mock.calls[0][0].value;
    expect(activityValue).not.toHaveProperty("targetHost");
    expect(activityValue).not.toHaveProperty("targetCwd");
  });
});
