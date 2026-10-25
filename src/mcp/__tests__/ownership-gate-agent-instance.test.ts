// src/mcp/__tests__/ownership-gate-agent-instance.test.ts
// Verifies the MCP ownership gates (release-idea, release-task, report-work)
// permit the OWNING agent of an `agent_instance` assignment and reject a
// non-owning agent. The gates route through isAssignmentOwnedByActor, which
// resolves an instance uuid → owning agent uuid before the comparison
// (add-agent-instance-addressing).

import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockTaskService = vi.hoisted(() => ({
  getTaskByUuid: vi.fn(),
  releaseTask: vi.fn(),
  updateTask: vi.fn(),
  isValidTaskStatusTransition: vi.fn(),
  reportCriteriaSelfCheck: vi.fn(),
}));

const mockIdeaService = vi.hoisted(() => ({
  getIdeaByUuid: vi.fn(),
  releaseIdea: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));

const mockCommentService = vi.hoisted(() => ({
  createComment: vi.fn(),
}));

const mockSessionService = vi.hoisted(() => ({
  getSession: vi.fn(),
  heartbeatSession: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  prisma: {
    // resolveAssigneeAgentUuid (via isAssignmentOwnedByActor) reads this for the
    // agent_instance path.
    agentInstance: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => mockPrisma);
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/idea.service", () => mockIdeaService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/comment.service", () => mockCommentService);
vi.mock("@/services/session.service", () => mockSessionService);

// pm.ts pulls in extra services; stub the ones it imports beyond the above.
vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));

// Capture tool handlers via a fake McpServer
type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
const toolHandlers: Record<string, ToolHandler> = {};

const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

import type { AgentAuthContext } from "@/types/auth";
import { registerDeveloperTools } from "@/mcp/tools/developer";
import { registerPmTools } from "@/mcp/tools/pm";

const COMPANY = "company-1";
const ACTING_AGENT = "agent-acting";
const INSTANCE_UUID = "inst-1";

const AUTH: AgentAuthContext = {
  type: "agent",
  companyUuid: COMPANY,
  actorUuid: ACTING_AGENT,
  ownerUuid: "owner-1",
  roles: ["developer", "pm"],
  // Both write permissions so the dev + pm tools register.
  permissions: ["task:write", "idea:write"],
  agentName: "Test Agent",
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerDeveloperTools(fakeMcpServer as never, AUTH);
  registerPmTools(fakeMcpServer as never, AUTH);
});

function isError(result: unknown): boolean {
  return !!(result as { isError?: boolean })?.isError;
}

describe("chorus_release_task — agent_instance ownership", () => {
  const baseTask = {
    uuid: "task-1",
    projectUuid: "project-1",
    assigneeType: "agent_instance",
    assigneeUuid: INSTANCE_UUID,
  };

  it("permits the owning agent of the pinned instance", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(baseTask);
    mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: ACTING_AGENT });
    mockTaskService.releaseTask.mockResolvedValue({ uuid: "task-1", status: "open" });

    const result = await toolHandlers["chorus_release_task"]({ taskUuid: "task-1" });

    expect(isError(result)).toBe(false);
    expect(mockTaskService.releaseTask).toHaveBeenCalledWith("task-1");
  });

  it("rejects an agent that does not own the pinned instance", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(baseTask);
    mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: "other-agent" });

    const result = await toolHandlers["chorus_release_task"]({ taskUuid: "task-1" });

    expect(isError(result)).toBe(true);
    expect(mockTaskService.releaseTask).not.toHaveBeenCalled();
  });
});

describe("chorus_report_work — agent_instance ownership", () => {
  const baseTask = {
    uuid: "task-1",
    status: "in_progress",
    projectUuid: "project-1",
    assigneeType: "agent_instance",
    assigneeUuid: INSTANCE_UUID,
  };

  it("permits the owning agent of the pinned instance", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(baseTask);
    mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: ACTING_AGENT });
    mockCommentService.createComment.mockResolvedValue({});

    const result = await toolHandlers["chorus_report_work"]({
      taskUuid: "task-1",
      report: "progress update",
    });

    expect(isError(result)).toBe(false);
    expect(mockCommentService.createComment).toHaveBeenCalled();
  });

  it("rejects an agent that does not own the pinned instance", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(baseTask);
    mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: "other-agent" });

    const result = await toolHandlers["chorus_report_work"]({
      taskUuid: "task-1",
      report: "progress update",
    });

    expect(isError(result)).toBe(true);
    expect(mockCommentService.createComment).not.toHaveBeenCalled();
  });
});

describe("chorus_release_idea — agent_instance ownership", () => {
  const baseIdea = {
    uuid: "idea-1",
    projectUuid: "project-1",
    assigneeType: "agent_instance",
    assigneeUuid: INSTANCE_UUID,
  };

  it("permits the owning agent of the pinned instance", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue(baseIdea);
    mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: ACTING_AGENT });
    mockIdeaService.releaseIdea.mockResolvedValue({ uuid: "idea-1", status: "open" });

    const result = await toolHandlers["chorus_release_idea"]({ ideaUuid: "idea-1" });

    expect(isError(result)).toBe(false);
    expect(mockIdeaService.releaseIdea).toHaveBeenCalledWith("idea-1");
  });

  it("rejects an agent that does not own the pinned instance", async () => {
    mockIdeaService.getIdeaByUuid.mockResolvedValue(baseIdea);
    mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue({ agentUuid: "other-agent" });

    const result = await toolHandlers["chorus_release_idea"]({ ideaUuid: "idea-1" });

    expect(isError(result)).toBe(true);
    expect(mockIdeaService.releaseIdea).not.toHaveBeenCalled();
  });
});
