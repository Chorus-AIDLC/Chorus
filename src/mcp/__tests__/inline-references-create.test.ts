// Handler-level coverage for Thread C — inline references[] at creation.
// Verifies chorus_pm_create_idea / chorus_pm_create_proposal (pm.ts) and
// chorus_create_tasks (public.ts) each materialize references against the newly
// created entity's REAL uuid via referenceArtifactService.createReferences, are
// fail-soft (a bad ref surfaces in referenceErrors, entity still created), that
// chorus_pm_add_task_draft does NOT gain a references param, and that the three
// reference write tools remain registered.
import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Shared service mocks (hoisted) =====
const mockReferenceService = vi.hoisted(() => ({
  createReferences: vi.fn(),
}));

const mockIdeaService = vi.hoisted(() => ({
  createIdea: vi.fn(),
}));

const mockProposalService = vi.hoisted(() => ({
  createProposal: vi.fn(),
  checkIdeasAssignee: vi.fn(),
  checkIdeasAvailability: vi.fn(),
  getProposalByUuid: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  projectExists: vi.fn(),
  getProjectByUuid: vi.fn(),
}));

const mockTaskService = vi.hoisted(() => ({
  createTask: vi.fn(),
  addTaskDependency: vi.fn(),
  createAcceptanceCriteria: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));

vi.mock("@/services/reference-artifact.service", () => ({
  ...mockReferenceService,
  // The tool modules import the REFERENCE_TYPES / REFERENCE_TARGET_TYPES consts
  // at module scope to build zod enums — provide them so registration works.
  REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
  REFERENCE_TARGET_TYPES: ["proposal", "task", "idea"],
}));
vi.mock("@/services/idea.service", () => mockIdeaService);
vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/project.service", () => mockProjectService);
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/session.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/checkin.service", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { registerPmTools } from "@/mcp/tools/pm";
import { registerPublicTools } from "@/mcp/tools/public";

const companyUuid = "company-1";
const actorUuid = "agent-1";

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const toolHandlers: Record<string, ToolHandler> = {};
const toolMeta: Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }> = {};

const fakeMcpServer = {
  registerTool: (name: string, meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
    toolMeta[name] = meta as never;
  },
};

function buildAuth(): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid,
    ownerUuid: "owner-1",
    roles: ["pm_agent"],
    // Hold every bit so pm + public gated tools all register.
    permissions: [
      "idea:write",
      "proposal:write",
      "document:write",
      "task:write",
    ] as Permission[],
    agentName: "PM Agent",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  for (const k of Object.keys(toolMeta)) delete toolMeta[k];
  // Default: batch helper reports no errors and returns the created refs count.
  mockReferenceService.createReferences.mockResolvedValue({ created: [], errors: [] });
  registerPmTools(
    fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0],
    buildAuth(),
  );
  registerPublicTools(
    fakeMcpServer as unknown as Parameters<typeof registerPublicTools>[0],
    buildAuth(),
  );
});

const REF = { type: "docs", url: "https://docs.example.com/a", title: "A" };

describe("chorus_pm_create_idea — inline references[]", () => {
  beforeEach(() => {
    mockProjectService.projectExists.mockResolvedValue(true);
    mockIdeaService.createIdea.mockResolvedValue({ uuid: "idea-real-1", title: "Grounded", parentUuid: null });
  });

  it("materializes references against the newly created idea's REAL uuid", async () => {
    const res = await toolHandlers["chorus_pm_create_idea"]({
      projectUuid: "project-1",
      title: "Grounded",
      references: [REF],
    });

    expect(res.isError).toBeFalsy();
    // Created AFTER createIdea, using the real DB uuid returned by the service.
    expect(mockReferenceService.createReferences).toHaveBeenCalledWith(
      companyUuid,
      "idea",
      "idea-real-1",
      [REF],
      { type: "agent", uuid: actorUuid },
    );
  });

  it("is fail-soft: surfaces referenceErrors but still returns the created idea", async () => {
    mockReferenceService.createReferences.mockResolvedValue({
      created: [],
      errors: [{ index: 0, url: "file:///x", title: "Bad", error: "Invalid reference url: file:///x" }],
    });

    const res = await toolHandlers["chorus_pm_create_idea"]({
      projectUuid: "project-1",
      title: "Grounded",
      references: [{ type: "docs", url: "file:///x", title: "Bad" }],
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.uuid).toBe("idea-real-1");
    expect(parsed.referenceErrors).toHaveLength(1);
    expect(parsed.referenceErrors[0].error).toMatch(/Invalid reference url/);
  });

  it("omits referenceErrors when there are none", async () => {
    const res = await toolHandlers["chorus_pm_create_idea"]({
      projectUuid: "project-1",
      title: "Grounded",
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).not.toHaveProperty("referenceErrors");
    // Batch helper still called (with undefined references → no-op).
    expect(mockReferenceService.createReferences).toHaveBeenCalledWith(
      companyUuid,
      "idea",
      "idea-real-1",
      undefined,
      { type: "agent", uuid: actorUuid },
    );
  });
});

describe("chorus_pm_create_proposal — inline references[]", () => {
  beforeEach(() => {
    mockProjectService.projectExists.mockResolvedValue(true);
    mockProposalService.createProposal.mockResolvedValue({ uuid: "prop-real-1", title: "P", status: "draft" });
  });

  it("materializes references against the newly created proposal's REAL uuid", async () => {
    const res = await toolHandlers["chorus_pm_create_proposal"]({
      projectUuid: "project-1",
      title: "P",
      inputType: "document",
      inputUuids: ["doc-1"],
      references: [REF],
    });

    expect(res.isError).toBeFalsy();
    expect(mockReferenceService.createReferences).toHaveBeenCalledWith(
      companyUuid,
      "proposal",
      "prop-real-1",
      [REF],
      { type: "agent", uuid: actorUuid },
    );
  });

  it("is fail-soft: surfaces referenceErrors but still returns the created proposal", async () => {
    mockReferenceService.createReferences.mockResolvedValue({
      created: [],
      errors: [{ index: 0, url: "ftp://x", title: "Bad", error: "Invalid reference url: ftp://x" }],
    });

    const res = await toolHandlers["chorus_pm_create_proposal"]({
      projectUuid: "project-1",
      title: "P",
      inputType: "document",
      inputUuids: ["doc-1"],
      references: [{ type: "docs", url: "ftp://x", title: "Bad" }],
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.uuid).toBe("prop-real-1");
    expect(parsed.referenceErrors).toHaveLength(1);
  });
});

describe("chorus_create_tasks — per-task inline references[]", () => {
  const AC = [{ description: "It works", required: true }];

  beforeEach(() => {
    mockProjectService.projectExists.mockResolvedValue(true);
  });

  it("materializes each task's references against that task's REAL uuid", async () => {
    mockTaskService.createTask
      .mockResolvedValueOnce({ uuid: "task-real-1", title: "T1" })
      .mockResolvedValueOnce({ uuid: "task-real-2", title: "T2" });

    const res = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      tasks: [
        { title: "T1", acceptanceCriteriaItems: AC, references: [REF] },
        { title: "T2", acceptanceCriteriaItems: AC },
      ],
    });

    expect(res.isError).toBeFalsy();
    // Only the first task carries references → exactly one batch call, bound to
    // task-real-1 (the real uuid from createTask), not a draft/index.
    expect(mockReferenceService.createReferences).toHaveBeenCalledTimes(1);
    expect(mockReferenceService.createReferences).toHaveBeenCalledWith(
      companyUuid,
      "task",
      "task-real-1",
      [REF],
      { type: "agent", uuid: actorUuid },
    );
  });

  it("is fail-soft: surfaces referenceErrors (tagged with the task) but still creates the task", async () => {
    mockTaskService.createTask.mockResolvedValue({ uuid: "task-real-1", title: "T1" });
    mockReferenceService.createReferences.mockResolvedValue({
      created: [],
      errors: [{ index: 0, url: "file:///x", title: "Bad", error: "Invalid reference url: file:///x" }],
    });

    const res = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      tasks: [{ title: "T1", acceptanceCriteriaItems: AC, references: [{ type: "docs", url: "file:///x", title: "Bad" }] }],
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.tasks[0].uuid).toBe("task-real-1");
    expect(parsed.referenceErrors).toHaveLength(1);
    expect(parsed.referenceErrors[0].task).toBe("T1");
    expect(parsed.referenceErrors[0].error).toMatch(/Invalid reference url/);
  });

  it("does not call the batch helper when no task carries references", async () => {
    mockTaskService.createTask.mockResolvedValue({ uuid: "task-real-1", title: "T1" });

    const res = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      tasks: [{ title: "T1", acceptanceCriteriaItems: AC }],
    });

    expect(res.isError).toBeFalsy();
    expect(mockReferenceService.createReferences).not.toHaveBeenCalled();
  });
});

describe("Thread C guardrails", () => {
  it("chorus_pm_add_task_draft does NOT accept a references param", () => {
    const schema = toolMeta["chorus_pm_add_task_draft"].inputSchema;
    // A references[] payload must be stripped/rejected — the draft tool is out of
    // scope for inline refs (draft uuid ≠ real Task row).
    const parsed = schema.safeParse({
      proposalUuid: "p1",
      title: "T",
      acceptanceCriteriaItems: [{ description: "x" }],
      references: [REF],
    }) as unknown as { success: boolean; data?: Record<string, unknown> };
    // Zod objects strip unknown keys by default → parse succeeds but `references`
    // is not part of the parsed data (the tool never sees it).
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("references");
  });

  it("keeps all three reference write tools registered (post-hoc attach path intact)", () => {
    expect(typeof toolHandlers["chorus_add_reference"]).toBe("function");
    expect(typeof toolHandlers["chorus_update_reference"]).toBe("function");
    expect(typeof toolHandlers["chorus_remove_reference"]).toBe("function");
  });
});
