import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====
// Verifies the V2 inline-reference read path on chorus_get_idea: the tool
// resolves the idea's linked reference artifacts and embeds them additively
// under `references`, mirroring chorus_get_task / chorus_get_proposal.

const mockIdeaService = vi.hoisted(() => ({
  getIdea: vi.fn(),
}));

const mockReferenceService = vi.hoisted(() => ({
  listReferences: vi.fn(),
}));

vi.mock("@/services/idea.service", () => mockIdeaService);
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
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
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
  permissions: [],
  agentName: "Test Agent",
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  // Default: no linked references. Individual tests override as needed.
  mockReferenceService.listReferences.mockResolvedValue([]);
  registerPublicTools(fakeMcpServer as never, AUTH);
});

describe("chorus_get_idea — inline references (V2)", () => {
  it("includes the idea's linked references inline", async () => {
    mockIdeaService.getIdea.mockResolvedValue({ uuid: "idea-1", title: "Grounded idea" });
    const refs = [
      { uuid: "ref-1", type: "paper_blog", url: "https://arxiv.org/abs/1", title: "Paper", notes: null },
    ];
    mockReferenceService.listReferences.mockResolvedValue(refs);

    const result = (await toolHandlers["chorus_get_idea"]({
      ideaUuid: "idea-1",
    })) as { content: { type: string; text: string }[] };

    // References are resolved for the idea target and embedded additively.
    expect(mockReferenceService.listReferences).toHaveBeenCalledWith({
      companyUuid: "company-1",
      targetType: "idea",
      targetUuid: "idea-1",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.references).toEqual(refs);
    // Still backward-compatible: the idea fields are untouched.
    expect(parsed.uuid).toBe("idea-1");
    expect(parsed.title).toBe("Grounded idea");
  });

  it("embeds an empty references array when the idea has none", async () => {
    mockIdeaService.getIdea.mockResolvedValue({ uuid: "idea-2", title: "No refs" });

    const result = (await toolHandlers["chorus_get_idea"]({
      ideaUuid: "idea-2",
    })) as { content: { type: string; text: string }[] };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.references).toEqual([]);
  });

  it("returns isError with 'Idea not found' and does not resolve references when the idea is absent", async () => {
    mockIdeaService.getIdea.mockResolvedValue(null);

    const result = await toolHandlers["chorus_get_idea"]({ ideaUuid: "missing" });

    expect(result).toEqual(
      expect.objectContaining({
        isError: true,
        content: [{ type: "text", text: "Idea not found" }],
      }),
    );
    expect(mockReferenceService.listReferences).not.toHaveBeenCalled();
  });
});
