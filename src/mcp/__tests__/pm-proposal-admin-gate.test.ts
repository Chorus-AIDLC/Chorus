// Regression guard: chorus_pm_{reject,revoke}_proposal use hasPermission(auth,
// "proposal:admin") as the any-author override, not role-string matching.
//
// Covers both branches: own-proposal (author UUID matches) and any-proposal
// (proposal:admin present), plus the unauthorized case for each tool.
import { vi, describe, it, expect, beforeEach } from "vitest";

const mockProposalService = vi.hoisted(() => ({
  getProposalByUuid: vi.fn(),
  rejectProposal: vi.fn(),
  revokeProposal: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  prisma: { agent: { update: vi.fn() } },
}));

vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/lib/prisma", () => mockPrisma);

vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));

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
const agentUuid = "agent-self";
const otherAgentUuid = "agent-other";
const proposalUuid = "proposal-1";
const projectUuid = "project-1";

function buildAuth(permissions: string[]): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid: agentUuid,
    ownerUuid: "owner-1",
    roles: ["pm_agent"],
    permissions: permissions as AgentAuthContext["permissions"],
    agentName: "test-agent",
  };
}

function registerWith(auth: AgentAuthContext) {
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  // The fake server's registerTool type differs from McpServer's; the handler
  // captures what we need, so we cast at the call site.
  registerPmTools(fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0], auth);
}

function pendingProposalBy(creatorUuid: string) {
  return {
    uuid: proposalUuid,
    projectUuid,
    createdByUuid: creatorUuid,
    status: "pending",
  };
}

function approvedProposalBy(creatorUuid: string) {
  return {
    uuid: proposalUuid,
    projectUuid,
    createdByUuid: creatorUuid,
    status: "approved",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chorus_pm_reject_proposal — author gate uses proposal:admin, not roles", () => {
  it("allows the author to reject their own pending proposal (proposal:write only)", async () => {
    registerWith(buildAuth(["proposal:write"]));
    mockProposalService.getProposalByUuid.mockResolvedValue(pendingProposalBy(agentUuid));
    mockProposalService.rejectProposal.mockResolvedValue({
      uuid: proposalUuid,
      status: "draft",
    });

    const res = await toolHandlers["chorus_pm_reject_proposal"]({
      proposalUuid,
      reviewNote: "not ready",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProposalService.rejectProposal).toHaveBeenCalledWith(
      proposalUuid,
      agentUuid,
      "not ready",
    );
  });

  it("rejects a non-author without proposal:admin", async () => {
    registerWith(buildAuth(["proposal:write"]));
    mockProposalService.getProposalByUuid.mockResolvedValue(pendingProposalBy(otherAgentUuid));

    const res = await toolHandlers["chorus_pm_reject_proposal"]({
      proposalUuid,
      reviewNote: "not mine",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/only reject your own/i);
    expect(mockProposalService.rejectProposal).not.toHaveBeenCalled();
  });

  it("allows a non-author to reject when proposal:admin is granted", async () => {
    registerWith(buildAuth(["proposal:write", "proposal:admin"]));
    mockProposalService.getProposalByUuid.mockResolvedValue(pendingProposalBy(otherAgentUuid));
    mockProposalService.rejectProposal.mockResolvedValue({
      uuid: proposalUuid,
      status: "draft",
    });

    const res = await toolHandlers["chorus_pm_reject_proposal"]({
      proposalUuid,
      reviewNote: "admin override",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProposalService.rejectProposal).toHaveBeenCalled();
  });
});

describe("chorus_pm_revoke_proposal — same admin gate", () => {
  it("allows the author to revoke their own approved proposal", async () => {
    registerWith(buildAuth(["proposal:write"]));
    mockProposalService.getProposalByUuid.mockResolvedValue(approvedProposalBy(agentUuid));
    mockProposalService.revokeProposal.mockResolvedValue({
      uuid: proposalUuid,
      status: "draft",
      closedTasks: [],
      deletedDocuments: [],
    });

    const res = await toolHandlers["chorus_pm_revoke_proposal"]({
      proposalUuid,
      reviewNote: "scope changed",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProposalService.revokeProposal).toHaveBeenCalled();
  });

  it("rejects a non-author without proposal:admin", async () => {
    registerWith(buildAuth(["proposal:write"]));
    mockProposalService.getProposalByUuid.mockResolvedValue(approvedProposalBy(otherAgentUuid));

    const res = await toolHandlers["chorus_pm_revoke_proposal"]({
      proposalUuid,
      reviewNote: "not mine",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/only revoke your own/i);
    expect(mockProposalService.revokeProposal).not.toHaveBeenCalled();
  });

  it("allows a non-author to revoke when proposal:admin is granted", async () => {
    registerWith(buildAuth(["proposal:write", "proposal:admin"]));
    mockProposalService.getProposalByUuid.mockResolvedValue(approvedProposalBy(otherAgentUuid));
    mockProposalService.revokeProposal.mockResolvedValue({
      uuid: proposalUuid,
      status: "draft",
      closedTasks: [],
      deletedDocuments: [],
    });

    const res = await toolHandlers["chorus_pm_revoke_proposal"]({
      proposalUuid,
      reviewNote: "admin override",
    });

    expect(res.isError).toBeFalsy();
    expect(mockProposalService.revokeProposal).toHaveBeenCalled();
  });
});
