import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockProposalService = vi.hoisted(() => ({
  getProposalSection: vi.fn(),
  // getProposal must NOT be called by the tool anymore — keep it as a spy to assert that.
  getProposal: vi.fn(),
}));

vi.mock("@/services/proposal.service", () => mockProposalService);

// Mock remaining imports used by public.ts to avoid import errors
vi.mock("@/services/project.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/session.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// Capture tool handlers + schemas via a fake McpServer
type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
const toolHandlers: Record<string, ToolHandler> = {};
const toolMeta: Record<string, { description: string; inputSchema: { safeParse: (v: unknown) => { success: boolean } } }> = {};
let registeredToolNames: string[] = [];

const fakeMcpServer = {
  registerTool: (name: string, meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
    toolMeta[name] = meta as never;
    registeredToolNames.push(name);
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
  permissions: [],
  agentName: "Test Agent",
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  Object.keys(toolMeta).forEach((k) => delete toolMeta[k]);
  registeredToolNames = [];
  registerPublicTools(fakeMcpServer as never, AUTH);
});

describe("chorus_get_proposal — section parameter", () => {
  it("defaults to the basic view when section is omitted", async () => {
    mockProposalService.getProposalSection.mockResolvedValue({ section: "basic", uuid: "p1" });

    await toolHandlers["chorus_get_proposal"]({ proposalUuid: "p1" });

    expect(mockProposalService.getProposalSection).toHaveBeenCalledWith("company-1", "p1", "basic");
    // The legacy full getProposal path must no longer be used by the tool
    expect(mockProposalService.getProposal).not.toHaveBeenCalled();
  });

  it.each(["basic", "documents", "tasks", "full"] as const)(
    "routes section=%s to getProposalSection with that view",
    async (section) => {
      mockProposalService.getProposalSection.mockResolvedValue({ section, uuid: "p1" });

      await toolHandlers["chorus_get_proposal"]({ proposalUuid: "p1", section });

      expect(mockProposalService.getProposalSection).toHaveBeenCalledWith("company-1", "p1", section);
    },
  );

  it("returns isError with 'Proposal not found' when the service returns null", async () => {
    mockProposalService.getProposalSection.mockResolvedValue(null);

    const result = await toolHandlers["chorus_get_proposal"]({ proposalUuid: "missing", section: "documents" });

    expect(result).toEqual(
      expect.objectContaining({
        isError: true,
        content: [{ type: "text", text: "Proposal not found" }],
      }),
    );
  });

  it("serializes the section response as pretty JSON", async () => {
    mockProposalService.getProposalSection.mockResolvedValue({ section: "tasks", uuid: "p1", taskDrafts: [] });

    const result = (await toolHandlers["chorus_get_proposal"]({
      proposalUuid: "p1",
      section: "tasks",
    })) as { content: { type: string; text: string }[] };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.section).toBe("tasks");
  });

  it("input schema accepts the four valid sections and rejects unknown values", () => {
    const schema = toolMeta["chorus_get_proposal"].inputSchema;
    for (const section of ["basic", "documents", "tasks", "full"]) {
      expect(schema.safeParse({ proposalUuid: "p1", section }).success).toBe(true);
    }
    // Omitted section is valid (optional)
    expect(schema.safeParse({ proposalUuid: "p1" }).success).toBe(true);
    // Unknown section value is rejected
    expect(schema.safeParse({ proposalUuid: "p1", section: "everything" }).success).toBe(false);
  });

  it("registers exactly one proposal-retrieval tool (no new MCP tool added)", () => {
    const proposalGetTools = registeredToolNames.filter(
      (n) => n === "chorus_get_proposal" || n === "chorus_get_proposal_document_draft",
    );
    expect(proposalGetTools).toEqual(["chorus_get_proposal"]);
  });

  it("documents all four sections and the basic default in its description", () => {
    const desc = toolMeta["chorus_get_proposal"].description;
    expect(desc).toContain("basic");
    expect(desc).toContain("documents");
    expect(desc).toContain("tasks");
    expect(desc).toContain("full");
    expect(desc).toMatch(/default/i);
  });
});
