import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockProjectService = vi.hoisted(() => ({
  getProjectByUuid: vi.fn(),
  projectExists: vi.fn(),
}));

const mockTaskService = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getUnblockedTasks: vi.fn(),
  createTask: vi.fn(),
  getTaskByUuid: vi.fn(),
  updateTask: vi.fn(),
  isValidTaskStatusTransition: vi.fn(),
  checkDependenciesResolved: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  TaskUpdateParams: {},
}));

const mockProposalService = vi.hoisted(() => ({
  getProposalByUuid: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));

const mockSessionService = vi.hoisted(() => ({
  getSession: vi.fn(),
  heartbeatSession: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  prisma: {
    agent: { update: vi.fn() },
    acceptanceCriterion: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/services/project.service", () => mockProjectService);
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/session.service", () => mockSessionService);
vi.mock("@/lib/prisma", () => mockPrisma);

vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));

// Capture tool handlers via a fake McpServer
type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
const toolHandlers: Record<string, ToolHandler> = {};

const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

import type { AgentAuthContext } from "@/types/auth";
import { registerPublicTools } from "@/mcp/tools/public";

const AUTH: AgentAuthContext = {
  type: "agent",
  companyUuid: "company-1",
  actorUuid: "agent-1",
  ownerUuid: "owner-1",
  roles: ["developer"],
  agentName: "Test Agent",
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerPublicTools(fakeMcpServer as never, AUTH);
});

// ===== chorus_create_tasks =====

describe("chorus_create_tasks", () => {
  it("creates a Quick Task (no proposalUuid) and logs activity", async () => {
    mockProjectService.projectExists.mockResolvedValue(true);
    mockTaskService.createTask.mockResolvedValue({ uuid: "task-1", title: "Fix bug" });

    const result = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      tasks: [{ title: "Fix bug", priority: "high" }],
    });

    expect(mockTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: "company-1",
        projectUuid: "project-1",
        title: "Fix bug",
        proposalUuid: null,
      }),
    );

    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        value: expect.objectContaining({ quickTask: true }),
      }),
    );

    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].uuid).toBe("task-1");
  });

  it("creates a proposal-linked task and logs activity with proposalUuid", async () => {
    mockProjectService.projectExists.mockResolvedValue(true);
    mockProposalService.getProposalByUuid.mockResolvedValue({ uuid: "prop-1" });
    mockTaskService.createTask.mockResolvedValue({ uuid: "task-2", title: "Feature" });

    await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      proposalUuid: "prop-1",
      tasks: [{ title: "Feature" }],
    });

    expect(mockTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ proposalUuid: "prop-1" }),
    );

    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        value: expect.objectContaining({ proposalUuid: "prop-1" }),
      }),
    );
  });

  it("returns error for nonexistent project", async () => {
    mockProjectService.projectExists.mockResolvedValue(false);

    const result = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "nonexistent",
      tasks: [{ title: "Test" }],
    });

    expect(result).toEqual(expect.objectContaining({ isError: true }));
    expect(mockTaskService.createTask).not.toHaveBeenCalled();
  });
});

// ===== chorus_update_task =====

describe("chorus_update_task", () => {
  const TASK = {
    uuid: "task-1",
    status: "assigned",
    projectUuid: "project-1",
    assigneeType: "agent",
    assigneeUuid: "agent-1",
  };

  it("updates fields without assignee check", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(TASK);
    mockTaskService.updateTask.mockResolvedValue({ ...TASK, title: "New title", status: "assigned" });

    const result = await toolHandlers["chorus_update_task"]({
      taskUuid: "task-1",
      title: "New title",
      priority: "high",
    });

    expect(mockTaskService.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ title: "New title", priority: "high" }),
      expect.objectContaining({ actorType: "agent" }),
    );

    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "updated",
        value: expect.objectContaining({ title: "New title", priority: "high" }),
      }),
    );

    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(parsed.uuid).toBe("task-1");
  });

  it("checks assignee for status update", async () => {
    const nonAssigneeTask = { ...TASK, assigneeUuid: "other-agent" };
    mockTaskService.getTaskByUuid.mockResolvedValue(nonAssigneeTask);

    const result = await toolHandlers["chorus_update_task"]({
      taskUuid: "task-1",
      status: "in_progress",
    });

    expect(result).toEqual(expect.objectContaining({ isError: true }));
    expect(mockTaskService.updateTask).not.toHaveBeenCalled();
  });

  it("merges status + field changes into one activity", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(TASK);
    mockTaskService.isValidTaskStatusTransition.mockReturnValue(true);
    mockTaskService.checkDependenciesResolved.mockResolvedValue({ resolved: true, blockers: [] });
    mockTaskService.updateTask.mockResolvedValue({ ...TASK, status: "in_progress" });

    await toolHandlers["chorus_update_task"]({
      taskUuid: "task-1",
      status: "in_progress",
      title: "Updated title",
      priority: "low",
    });

    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "status_changed",
        value: expect.objectContaining({
          status: "in_progress",
          title: "Updated title",
          priority: "low",
        }),
      }),
    );
  });

  it("manages dependencies via addDependsOn/removeDependsOn", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(TASK);

    await toolHandlers["chorus_update_task"]({
      taskUuid: "task-1",
      addDependsOn: ["dep-1", "dep-2"],
      removeDependsOn: ["dep-3"],
    });

    expect(mockTaskService.addTaskDependency).toHaveBeenCalledTimes(2);
    expect(mockTaskService.addTaskDependency).toHaveBeenCalledWith("company-1", "task-1", "dep-1");
    expect(mockTaskService.addTaskDependency).toHaveBeenCalledWith("company-1", "task-1", "dep-2");
    expect(mockTaskService.removeTaskDependency).toHaveBeenCalledTimes(1);
    expect(mockTaskService.removeTaskDependency).toHaveBeenCalledWith("company-1", "task-1", "dep-3");
  });

  it("returns error for nonexistent task", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue(null);

    const result = await toolHandlers["chorus_update_task"]({
      taskUuid: "nonexistent",
      title: "Nope",
    });

    expect(result).toEqual(expect.objectContaining({ isError: true }));
  });
});
