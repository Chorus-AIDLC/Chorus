// Pure tests for the public-namespaced, document:write-gated tool
// `chorus_create_report` (add-idea-completion-report Tech Design §"MCP tool
// contract"). Mocks every transitive service so registerPublicTools never
// touches a real DB; the suite captures the registered handler/config and
// drives it directly.

import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockProposalService = vi.hoisted(() => ({
  getProposalByUuid: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  createDocument: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  prisma: {
    acceptanceCriterion: { createMany: vi.fn() },
  },
}));

vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/document.service", () => mockDocumentService);
vi.mock("@/lib/prisma", () => mockPrisma);

// Empty stubs for every other service registerPublicTools imports — none of
// their methods get called in these tests.
vi.mock("@/services/project.service", () => ({}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/session.service", () => ({}));
vi.mock("@/services/checkin.service", () => ({}));

// Capture tool registrations: name -> { config, handler }
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
type ToolConfig = {
  description?: string;
  inputSchema?: { parse?: (input: unknown) => unknown };
};

const tools: Record<string, { config: ToolConfig; handler: ToolHandler }> = {};

function makeServer() {
  return {
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      tools[name] = { config, handler };
    },
  };
}

import type { AgentAuthContext } from "@/types/auth";
import { registerPublicTools } from "@/mcp/tools/public";
import { TOOL_PERMISSIONS } from "@/mcp/tools/permission-map";

const COMPANY_UUID = "company-0000-0000-0000-000000000001";
const ACTOR_UUID = "agent-0000-0000-0000-000000000001";
const PROPOSAL_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "22222222-2222-4222-8222-222222222222";
const DOC_UUID = "33333333-3333-4333-8333-333333333333";

function makeAuth(permissions: string[]): AgentAuthContext {
  return {
    type: "agent",
    companyUuid: COMPANY_UUID,
    actorUuid: ACTOR_UUID,
    agentName: "Test Agent",
    roles: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permissions: permissions as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(tools).forEach((k) => delete tools[k]);
});

// ============================================================
// Permission map entry
// ============================================================

describe("permission-map entry", () => {
  it("maps chorus_create_report to document:write (AC: permission gate)", () => {
    expect(TOOL_PERMISSIONS.chorus_create_report).toBe("document:write");
  });
});

// ============================================================
// Tool registration: visibility under different permission sets
// ============================================================

describe("chorus_create_report registration gating", () => {
  it("registers the tool when auth carries document:write", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));
    expect(tools["chorus_create_report"]).toBeDefined();
  });

  it("does NOT register the tool when auth lacks document:write (only document:read)", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:read"]));
    expect(tools["chorus_create_report"]).toBeUndefined();
  });

  it("does NOT register the tool when auth has zero permissions", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth([]));
    expect(tools["chorus_create_report"]).toBeUndefined();
  });

  it("does NOT register the tool for an agent with only task:write (developer-style custom set)", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["task:read", "task:write"]));
    expect(tools["chorus_create_report"]).toBeUndefined();
  });
});

// ============================================================
// Tool description: 3 section headers required by the report template
// ============================================================

describe("chorus_create_report description (template constraint)", () => {
  it("description carries the three report section headers", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));
    const desc = tools["chorus_create_report"].config.description ?? "";

    // Each header must appear verbatim in the LLM-visible description so the
    // calling agent has a single source of truth for the report shape.
    expect(desc).toContain("Summary");
    expect(desc).toContain("Decisions");
    expect(desc).toContain("Follow-ups");
  });
});

// ============================================================
// Input schema: required fields, no `type` parameter
// ============================================================

describe("chorus_create_report input schema (spec delta mcp-tool-surface)", () => {
  it("requires proposalUuid (UUID), title, and content", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));
    const schema = tools["chorus_create_report"].config.inputSchema as {
      parse: (input: unknown) => unknown;
    };

    // Empty input fails validation.
    expect(() => schema.parse({})).toThrow();

    // Non-UUID proposalUuid fails.
    expect(() =>
      schema.parse({ proposalUuid: "not-a-uuid", title: "t", content: "c" })
    ).toThrow();

    // Empty title fails (min length 1).
    expect(() =>
      schema.parse({ proposalUuid: PROPOSAL_UUID, title: "", content: "c" })
    ).toThrow();

    // Empty content fails (min length 1).
    expect(() =>
      schema.parse({ proposalUuid: PROPOSAL_UUID, title: "t", content: "" })
    ).toThrow();

    // Title over 200 chars fails.
    expect(() =>
      schema.parse({
        proposalUuid: PROPOSAL_UUID,
        title: "x".repeat(201),
        content: "c",
      })
    ).toThrow();

    // Valid input passes.
    expect(() =>
      schema.parse({
        proposalUuid: PROPOSAL_UUID,
        title: "Idea X — completion report",
        content: "## Summary\nbody",
      })
    ).not.toThrow();
  });

  it("does NOT accept a type parameter (the tool name encodes type=report)", () => {
    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));
    const schema = tools["chorus_create_report"].config.inputSchema as {
      parse: (input: unknown) => { type?: unknown };
    };

    const parsed = schema.parse({
      proposalUuid: PROPOSAL_UUID,
      title: "t",
      content: "c",
      // Extra "type" field — Zod object schemas strip unknown keys by default,
      // so we assert the parsed result has no `type` key surfaced to the handler.
    });
    expect((parsed as Record<string, unknown>).type).toBeUndefined();
  });
});

// ============================================================
// Handler behavior: load Proposal, write Document with type=report
// ============================================================

describe("chorus_create_report handler", () => {
  it("creates a Document with type=report and the supplied title/content (AC: byte-faithful create)", async () => {
    mockProposalService.getProposalByUuid.mockResolvedValue({
      uuid: PROPOSAL_UUID,
      projectUuid: PROJECT_UUID,
      companyUuid: COMPANY_UUID,
      status: "approved",
    });
    mockDocumentService.createDocument.mockResolvedValue({
      uuid: DOC_UUID,
      type: "report",
      title: "Idea X — completion report",
      content: "## Summary\nbody\n",
      version: 1,
      proposalUuid: PROPOSAL_UUID,
      createdBy: { type: "agent", uuid: ACTOR_UUID, name: "Test Agent" },
      createdAt: new Date("2026-05-25T00:00:00Z").toISOString(),
      updatedAt: new Date("2026-05-25T00:00:00Z").toISOString(),
    });

    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));

    const reportContent =
      "## Summary\nShipped feature X.\n\n" +
      "## Decisions\n- Chose A over B.\n\n" +
      "## Follow-ups\nNone.\n";

    const result = await tools["chorus_create_report"].handler({
      proposalUuid: PROPOSAL_UUID,
      title: "Idea X — completion report",
      content: reportContent,
    });

    // Proposal lookup is scoped to the agent's company.
    expect(mockProposalService.getProposalByUuid).toHaveBeenCalledWith(
      COMPANY_UUID,
      PROPOSAL_UUID
    );

    // Document is created with the right primitives. The service receives
    // type="report" unconditionally (the tool name pins it) and the
    // projectUuid is read from the loaded Proposal.
    expect(mockDocumentService.createDocument).toHaveBeenCalledTimes(1);
    const createCall = mockDocumentService.createDocument.mock.calls[0][0];
    expect(createCall).toMatchObject({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      proposalUuid: PROPOSAL_UUID,
      type: "report",
      title: "Idea X — completion report",
      createdByUuid: ACTOR_UUID,
    });
    // content passes through byte-faithfully to the service layer.
    expect(createCall.content).toBe(reportContent);

    // Response shape: { documentUuid, projectUuid, version }.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({
      documentUuid: DOC_UUID,
      projectUuid: PROJECT_UUID,
      version: 1,
    });
  });

  it("returns 'Proposal not found' and creates no Document when the Proposal is missing (AC4)", async () => {
    mockProposalService.getProposalByUuid.mockResolvedValue(null);

    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));

    const result = await tools["chorus_create_report"].handler({
      proposalUuid: PROPOSAL_UUID,
      title: "Will fail",
      content: "## Summary\nshould not persist",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Proposal not found");
    expect(mockDocumentService.createDocument).not.toHaveBeenCalled();
  });

  it("scopes Proposal lookup to the agent's companyUuid (multi-tenancy)", async () => {
    // Even with a valid-looking UUID, a Proposal in another company yields null
    // from getProposalByUuid (scoped query). The handler must surface the
    // not-found path, not silently leak a cross-tenant row.
    mockProposalService.getProposalByUuid.mockResolvedValue(null);

    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));

    const result = await tools["chorus_create_report"].handler({
      proposalUuid: PROPOSAL_UUID,
      title: "Cross-tenant probe",
      content: "## Summary",
    });

    expect(result.isError).toBe(true);
    expect(mockProposalService.getProposalByUuid).toHaveBeenCalledWith(
      COMPANY_UUID,
      PROPOSAL_UUID
    );
    expect(mockDocumentService.createDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["draft"],
    ["pending"],
    ["rejected"],
    ["closed"],
  ])("rejects the call when proposal.status='%s' (only 'approved' may bear a completion report)", async (status) => {
    mockProposalService.getProposalByUuid.mockResolvedValue({
      uuid: PROPOSAL_UUID,
      projectUuid: PROJECT_UUID,
      companyUuid: COMPANY_UUID,
      status,
    });

    const server = makeServer();
    registerPublicTools(server as never, makeAuth(["document:write"]));

    const result = await tools["chorus_create_report"].handler({
      proposalUuid: PROPOSAL_UUID,
      title: "Should fail",
      content: "## Summary\nbody\n",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`'${status}'`);
    expect(mockDocumentService.createDocument).not.toHaveBeenCalled();
  });
});
