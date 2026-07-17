import { vi, describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

// ===== Module mocks (hoisted) =====

const mockProposalService = vi.hoisted(() => ({
  getProposalSection: vi.fn(),
  // getProposal must NOT be called by the tool anymore — keep it as a spy to assert that.
  getProposal: vi.fn(),
}));

const mockReferenceService = vi.hoisted(() => ({
  listReferences: vi.fn(),
}));

vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/reference-artifact.service", () => ({
  ...mockReferenceService,
  // public.ts imports these constants at module scope to build the inline
  // references[] enum (chorus_create_tasks) — provide them so registration works.
  REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
  REFERENCE_TARGET_TYPES: ["proposal", "task", "idea"],
}));

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
  // Default: no linked references. Individual tests override as needed.
  mockReferenceService.listReferences.mockResolvedValue([]);
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

  it("includes the proposal's linked references inline (q6=a read path)", async () => {
    mockProposalService.getProposalSection.mockResolvedValue({ section: "basic", uuid: "p1" });
    const refs = [
      { uuid: "ref-1", type: "repo", url: "https://example.com", title: "Ref 1", notes: null },
    ];
    mockReferenceService.listReferences.mockResolvedValue(refs);

    const result = (await toolHandlers["chorus_get_proposal"]({
      proposalUuid: "p1",
    })) as { content: { type: string; text: string }[] };

    // References are resolved for the proposal target and embedded additively.
    expect(mockReferenceService.listReferences).toHaveBeenCalledWith({
      companyUuid: "company-1",
      targetType: "proposal",
      targetUuid: "p1",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.references).toEqual(refs);
    // Still backward-compatible: the section view is untouched.
    expect(parsed.section).toBe("basic");
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

  it("documents all four sections and the basic default in the section param describe", () => {
    // After description slimming (slim-mcp-tool-descriptions-enums), the per-section
    // detail lives in the `section` param's .describe(), not the top-level description.
    // The description is trimmed to what/when; the section values remain enumerated on the param.
    const schema = toolMeta["chorus_get_proposal"].inputSchema as unknown as z.ZodType;
    const sectionDesc =
      (z.toJSONSchema(schema, { io: "input" }) as { properties?: Record<string, { description?: string }> })
        .properties?.section?.description ?? "";
    expect(sectionDesc).toContain("basic");
    expect(sectionDesc).toContain("documents");
    expect(sectionDesc).toContain("tasks");
    expect(sectionDesc).toContain("full");
    expect(sectionDesc).toMatch(/default/i);
  });
});
