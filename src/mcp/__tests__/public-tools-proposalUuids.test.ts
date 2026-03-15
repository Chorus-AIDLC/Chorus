import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockProjectService = vi.hoisted(() => ({
  getProjectByUuid: vi.fn(),
}));

const mockTaskService = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getUnblockedTasks: vi.fn(),
}));

const mockAssignmentService = vi.hoisted(() => ({
  getAvailableItems: vi.fn(),
}));

vi.mock("@/services/project.service", () => mockProjectService);
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/assignment.service", () => mockAssignmentService);

// Mock remaining imports used by public.ts to avoid import errors
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

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

const PROJECT = { uuid: "project-1", name: "Test Project" };

// ===== Setup =====

beforeEach(() => {
  vi.clearAllMocks();
  // Re-register tools so handlers are fresh
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerPublicTools(fakeMcpServer as never, AUTH);
});

// ===== chorus_list_tasks =====

describe("chorus_list_tasks — proposalUuids", () => {
  it("passes proposalUuids to taskService.listTasks when provided", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(PROJECT);
    mockTaskService.listTasks.mockResolvedValue({ tasks: [], total: 0 });

    await toolHandlers["chorus_list_tasks"]({
      projectUuid: "project-1",
      proposalUuids: ["prop-a", "prop-b"],
      page: 1,
      pageSize: 20,
    });

    expect(mockTaskService.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalUuids: ["prop-a", "prop-b"],
      }),
    );
  });

  it("works without proposalUuids (backward compat)", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(PROJECT);
    mockTaskService.listTasks.mockResolvedValue({ tasks: [], total: 0 });

    await toolHandlers["chorus_list_tasks"]({
      projectUuid: "project-1",
      page: 1,
      pageSize: 20,
    });

    expect(mockTaskService.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: "company-1",
        projectUuid: "project-1",
      }),
    );
    // proposalUuids should be undefined (not present or undefined)
    const callArg = mockTaskService.listTasks.mock.calls[0][0];
    expect(callArg.proposalUuids).toBeUndefined();
  });

  it("still checks project existence", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(null);

    const result = await toolHandlers["chorus_list_tasks"]({
      projectUuid: "nonexistent",
      proposalUuids: ["prop-a"],
      page: 1,
      pageSize: 20,
    });

    expect(result).toEqual(
      expect.objectContaining({ isError: true }),
    );
    expect(mockTaskService.listTasks).not.toHaveBeenCalled();
  });
});

// ===== chorus_get_available_tasks =====

describe("chorus_get_available_tasks — proposalUuids", () => {
  it("passes proposalUuids to assignmentService.getAvailableItems when provided", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(PROJECT);
    mockAssignmentService.getAvailableItems.mockResolvedValue({ ideas: [], tasks: [] });

    await toolHandlers["chorus_get_available_tasks"]({
      projectUuid: "project-1",
      proposalUuids: ["prop-x"],
    });

    expect(mockAssignmentService.getAvailableItems).toHaveBeenCalledWith(
      "company-1",
      "project-1",
      false,
      true,
      ["prop-x"],
    );
  });

  it("works without proposalUuids (backward compat)", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(PROJECT);
    mockAssignmentService.getAvailableItems.mockResolvedValue({ ideas: [], tasks: [] });

    await toolHandlers["chorus_get_available_tasks"]({
      projectUuid: "project-1",
    });

    expect(mockAssignmentService.getAvailableItems).toHaveBeenCalledWith(
      "company-1",
      "project-1",
      false,
      true,
      undefined,
    );
  });

  it("still checks project existence", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(null);

    const result = await toolHandlers["chorus_get_available_tasks"]({
      projectUuid: "nonexistent",
      proposalUuids: ["prop-x"],
    });

    expect(result).toEqual(
      expect.objectContaining({ isError: true }),
    );
    expect(mockAssignmentService.getAvailableItems).not.toHaveBeenCalled();
  });
});

// ===== chorus_get_unblocked_tasks =====

describe("chorus_get_unblocked_tasks — proposalUuids", () => {
  it("passes proposalUuids to taskService.getUnblockedTasks when provided", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(PROJECT);
    mockTaskService.getUnblockedTasks.mockResolvedValue({ tasks: [], total: 0 });

    await toolHandlers["chorus_get_unblocked_tasks"]({
      projectUuid: "project-1",
      proposalUuids: ["prop-1", "prop-2"],
    });

    expect(mockTaskService.getUnblockedTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalUuids: ["prop-1", "prop-2"],
      }),
    );
  });

  it("works without proposalUuids (backward compat)", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(PROJECT);
    mockTaskService.getUnblockedTasks.mockResolvedValue({ tasks: [], total: 0 });

    await toolHandlers["chorus_get_unblocked_tasks"]({
      projectUuid: "project-1",
    });

    expect(mockTaskService.getUnblockedTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: "company-1",
        projectUuid: "project-1",
      }),
    );
    const callArg = mockTaskService.getUnblockedTasks.mock.calls[0][0];
    expect(callArg.proposalUuids).toBeUndefined();
  });

  it("still checks project existence", async () => {
    mockProjectService.getProjectByUuid.mockResolvedValue(null);

    const result = await toolHandlers["chorus_get_unblocked_tasks"]({
      projectUuid: "nonexistent",
      proposalUuids: ["prop-1"],
    });

    expect(result).toEqual(
      expect.objectContaining({ isError: true }),
    );
    expect(mockTaskService.getUnblockedTasks).not.toHaveBeenCalled();
  });
});
