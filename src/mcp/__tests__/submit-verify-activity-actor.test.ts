// src/mcp/__tests__/submit-verify-activity-actor.test.ts
// Regression: transitions performed by an MCP tool used to call
// taskService.updateTask() without an actor context, so the `execution_started`
// activity written inside updateTask fell back to actorType "system" with an
// empty actorUuid. listActivitiesWithActorNames resolves no name for that and the
// dashboard showed the actor as "Unknown" next to a correctly attributed
// "submitted" row from the same call.
//
// These tests pin the actor context at the call sites we fixed: submit for
// verification, report-work status change, and admin verification.

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockTaskService = vi.hoisted(() => ({
  getTaskByUuid: vi.fn(),
  releaseTask: vi.fn(),
  updateTask: vi.fn(),
  isValidTaskStatusTransition: vi.fn(),
  reportCriteriaSelfCheck: vi.fn(),
  checkAcceptanceCriteriaGate: vi.fn(),
}));

const mockIdeaService = vi.hoisted(() => ({ getIdeaByUuid: vi.fn(), releaseIdea: vi.fn() }));
const mockProposalService = vi.hoisted(() => ({ getProposalByUuid: vi.fn(), approveProposal: vi.fn(), submitProposal: vi.fn() }));
const mockActivityService = vi.hoisted(() => ({ createActivity: vi.fn() }));
const mockCommentService = vi.hoisted(() => ({ createComment: vi.fn() }));
const mockSessionService = vi.hoisted(() => ({ getSession: vi.fn(), heartbeatSession: vi.fn() }));
const mockPrisma = vi.hoisted(() => ({ prisma: { agentInstance: { findFirst: vi.fn() } } }));

vi.mock("@/lib/prisma", () => mockPrisma);
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/idea.service", () => mockIdeaService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/comment.service", () => mockCommentService);
vi.mock("@/services/session.service", () => mockSessionService);
vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
const toolHandlers: Record<string, ToolHandler> = {};
const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

import type { AgentAuthContext } from "@/types/auth";
import { registerDeveloperTools } from "@/mcp/tools/developer";
import { registerAdminTools } from "@/mcp/tools/admin";
import { registerPmTools } from "@/mcp/tools/pm";

const COMPANY = "company-1";
const AGENT = "agent-acting";
const TASK = "task-1";

const AUTH: AgentAuthContext = {
  type: "agent",
  companyUuid: COMPANY,
  actorUuid: AGENT,
  ownerUuid: "owner-1",
  roles: ["developer"],
  permissions: ["task:write", "task:admin", "idea:write", "proposal:admin", "proposal:write"],
  agentName: "Test Agent",
};

const ASSIGNEE_ME = { type: "agent", uuid: AGENT };

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerDeveloperTools(fakeMcpServer as never, AUTH);
  registerAdminTools(fakeMcpServer as never, AUTH);
  registerPmTools(fakeMcpServer as never, AUTH);
  mockTaskService.updateTask.mockResolvedValue({ uuid: TASK, status: "to_verify" });
  mockActivityService.createActivity.mockResolvedValue({ uuid: "activity-1" });
  mockCommentService.createComment.mockResolvedValue({ uuid: "comment-1" });
  mockPrisma.prisma.agentInstance.findFirst.mockResolvedValue(null);
});

describe("chorus_submit_for_verify — actor attribution", () => {
  it("passes the agent actor context to updateTask", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: TASK,
      status: "in_progress",
      projectUuid: "project-1",
      assigneeType: ASSIGNEE_ME.type,
      assigneeUuid: ASSIGNEE_ME.uuid,
    });

    const result = await toolHandlers["chorus_submit_for_verify"]({ taskUuid: TASK, summary: "done" });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(mockTaskService.updateTask).toHaveBeenCalledWith(
      TASK,
      { status: "to_verify" },
      { actorType: "agent", actorUuid: AGENT },
    );
  });
});

describe("chorus_report_work — actor attribution on a status change", () => {
  it("passes the agent actor context to updateTask", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: TASK,
      status: "in_progress",
      projectUuid: "project-1",
      assigneeType: ASSIGNEE_ME.type,
      assigneeUuid: ASSIGNEE_ME.uuid,
    });
    mockTaskService.isValidTaskStatusTransition.mockReturnValue(true);

    await toolHandlers["chorus_report_work"]({ taskUuid: TASK, report: "progress", status: "in_progress" });

    expect(mockTaskService.updateTask).toHaveBeenCalledWith(
      TASK,
      { status: "in_progress" },
      { actorType: "agent", actorUuid: AGENT },
    );
  });
});

describe("chorus_admin_verify_task — actor attribution", () => {
  it("passes the agent actor context to updateTask", async () => {
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: TASK,
      status: "to_verify",
      projectUuid: "project-1",
    });
    mockTaskService.checkAcceptanceCriteriaGate.mockResolvedValue({ allowed: true });
    mockTaskService.updateTask.mockResolvedValue({ uuid: TASK, status: "done" });

    const result = await toolHandlers["chorus_admin_verify_task"]({ taskUuid: TASK });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(mockTaskService.updateTask).toHaveBeenCalledWith(
      TASK,
      { status: "done" },
      { actorType: "agent", actorUuid: AGENT },
    );
  });
});

describe("chorus_admin_approve_proposal — authoritative actor", () => {
  it("passes actor context to the shared approval gate", async () => {
    mockProposalService.getProposalByUuid.mockResolvedValue({ uuid: "proposal", status: "pending", projectUuid: "project" });
    mockProposalService.approveProposal.mockResolvedValue({ uuid: "proposal", status: "approved" });
    await toolHandlers.chorus_admin_approve_proposal({ proposalUuid: "proposal", reviewNote: "Reviewed" });
    expect(mockProposalService.approveProposal).toHaveBeenCalledWith("proposal", COMPANY, AGENT, "Reviewed", { actorType: "agent", actorUuid: AGENT });
  });
  it("propagates gate rejection and records no approval activity", async () => {
    mockProposalService.getProposalByUuid.mockResolvedValue({ uuid: "proposal", status: "pending", projectUuid: "project" });
    mockProposalService.approveProposal.mockRejectedValue(new Error("Human approval required"));
    await expect(toolHandlers.chorus_admin_approve_proposal({ proposalUuid: "proposal" })).rejects.toThrow("Human approval required");
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });
});

describe("chorus_pm_submit_proposal — delegated actor", () => {
  it("passes authenticated product identity to the shared submission gate", async () => {
    mockProposalService.submitProposal.mockResolvedValue({ uuid: "proposal", status: "pending" });
    await toolHandlers.chorus_pm_submit_proposal({ proposalUuid: "proposal" });
    expect(mockProposalService.submitProposal).toHaveBeenCalledWith("proposal", COMPANY, { actorType: "agent", actorUuid: AGENT });
  });
});
