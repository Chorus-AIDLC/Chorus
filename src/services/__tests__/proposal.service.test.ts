/**
 * proposal.service.test.ts — Unit tests for proposal.service with Prisma mocking.
 *
 * Tests cover: createProposal, addTaskDraft, addDocumentDraft, updateTaskDraft,
 * updateDocumentDraft, removeTaskDraft, removeDocumentDraft, submitProposal,
 * validateProposal (10+ business rules), approveProposal, rejectProposal, closeProposal,
 * revokeProposal.
 *
 * Pure function tests (ensureDocumentDraftUuid, ensureTaskDraftUuid) live in
 * proposal.service.pure.test.ts — not duplicated here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Hoisted mocks (vi.mock factories are hoisted above all imports) =====

const { mockPrisma, mockEventBus, mockFormatCreatedBy, mockFormatReview, mockCreateDoc, mockCreateTasks } = vi.hoisted(() => {
  const mockPrisma = {
    proposal: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    idea: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    taskDependency: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    acceptanceCriterion: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      groupBy: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    sessionTaskCheckin: {
      deleteMany: vi.fn(),
    },
    comment: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const mockEventBus = { emitChange: vi.fn() };
  const mockFormatCreatedBy = vi.fn().mockResolvedValue({ type: "agent", uuid: "actor-uuid", name: "Agent" });
  const mockFormatReview = vi.fn().mockResolvedValue(null);
  const mockCreateDoc = vi.fn().mockResolvedValue({});
  const mockCreateTasks = vi.fn().mockResolvedValue({ draftToTaskUuidMap: new Map() });
  return { mockPrisma, mockEventBus, mockFormatCreatedBy, mockFormatReview, mockCreateDoc, mockCreateTasks };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/generated/prisma/client", () => ({
  Prisma: {
    JsonNull: "DbNull",
    InputJsonValue: {},
  },
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatCreatedBy: mockFormatCreatedBy,
  formatReview: mockFormatReview,
}));
vi.mock("@/services/document.service", () => ({
  createDocumentFromProposal: mockCreateDoc,
}));
vi.mock("@/services/task.service", () => ({
  createTasksFromProposal: mockCreateTasks,
}));

import {
  createProposal,
  listProposals,
  getProposal,
  getProposalByUuid,
  addDocumentDraft,
  addTaskDraft,
  updateDocumentDraft,
  updateTaskDraft,
  removeDocumentDraft,
  removeTaskDraft,
  updateProposalContent,
  submitProposal,
  validateProposal,
  approveProposal,
  rejectProposal,
  closeProposal,
  revokeProposal,
  deleteProposal,
  getProjectProposals,
} from "@/services/proposal.service";
import { makeProposal } from "@/__test-utils__/fixtures";

// ===== Helpers =====

const COMPANY_UUID = "00000000-0000-0000-0000-000000000001";
const PROJECT_UUID = "00000000-0000-0000-0000-000000000010";
const ACTOR_UUID = "00000000-0000-0000-0000-000000000002";

/** A minimal valid proposal DB row for mocking findFirst/create returns */
function dbProposal(overrides: Record<string, unknown> = {}) {
  return makeProposal({
    companyUuid: COMPANY_UUID,
    projectUuid: PROJECT_UUID,
    createdByUuid: ACTOR_UUID,
    ...overrides,
  });
}

/** A long string (>= 100 chars) for document content */
const LONG_CONTENT = "x".repeat(120);

/** A valid document draft */
function validDocDraft(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "doc-draft-1",
    type: "prd",
    title: "PRD",
    content: LONG_CONTENT,
    ...overrides,
  };
}

/** A valid task draft with acceptance criteria */
function validTaskDraft(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "task-draft-1",
    title: "Task 1",
    description: "Implement feature",
    priority: "medium",
    storyPoints: 3,
    acceptanceCriteriaItems: [{ description: "Done", required: true }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock implementations that vi.clearAllMocks removes
  mockFormatCreatedBy.mockResolvedValue({ type: "agent", uuid: "actor-uuid", name: "Agent" });
  mockFormatReview.mockResolvedValue(null);
  mockCreateDoc.mockResolvedValue({});
  mockCreateTasks.mockResolvedValue({ draftToTaskUuidMap: new Map() });
  // Default: idea.findMany returns empty array (needed when validateProposal
  // checks E5 for idea-type proposals)
  mockPrisma.idea.findMany.mockResolvedValue([]);
});

// ====================================================================
// createProposal
// ====================================================================

describe("createProposal", () => {
  it("should create a proposal and emit an event", async () => {
    const created = dbProposal({ status: "draft" });
    mockPrisma.proposal.create.mockResolvedValue(created);

    const result = await createProposal({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "Test Proposal",
      inputType: "idea",
      inputUuids: ["idea-1"],
      createdByUuid: ACTOR_UUID,
    });

    expect(mockPrisma.proposal.create).toHaveBeenCalledOnce();
    expect(result.uuid).toBe(created.uuid);
    expect(result.status).toBe("draft");
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "proposal", action: "created" })
    );
  });

  it("should auto-generate UUIDs for drafts when not provided", async () => {
    const created = dbProposal();
    mockPrisma.proposal.create.mockResolvedValue(created);

    await createProposal({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "Proposal",
      inputType: "idea",
      inputUuids: ["idea-1"],
      createdByUuid: ACTOR_UUID,
      documentDrafts: [{ type: "prd", title: "PRD", content: "Content" }],
      taskDrafts: [{ title: "Task 1" }],
    });

    const callData = mockPrisma.proposal.create.mock.calls[0][0].data;
    expect(callData.documentDrafts[0].uuid).toBeDefined();
    expect(callData.taskDrafts[0].uuid).toBeDefined();
  });

  it("should default createdByType to 'agent' when not specified", async () => {
    mockPrisma.proposal.create.mockResolvedValue(dbProposal());

    await createProposal({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "Test",
      inputType: "idea",
      inputUuids: [],
      createdByUuid: ACTOR_UUID,
    });

    const callData = mockPrisma.proposal.create.mock.calls[0][0].data;
    expect(callData.createdByType).toBe("agent");
  });
});

// ====================================================================
// addDocumentDraft
// ====================================================================

describe("addDocumentDraft", () => {
  it("should append a new document draft to an existing proposal", async () => {
    const proposal = dbProposal({ documentDrafts: [validDocDraft()] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await addDocumentDraft("proposal-uuid", COMPANY_UUID, {
      type: "tech_design",
      title: "Tech Design",
      content: "Design content",
    });

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.documentDrafts).toHaveLength(2);
    expect(updateCall.data.documentDrafts[1].type).toBe("tech_design");
    expect(updateCall.data.documentDrafts[1].uuid).toBeDefined();
  });

  it("should throw if proposal is not in draft status", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      addDocumentDraft("proposal-uuid", COMPANY_UUID, {
        type: "prd",
        title: "PRD",
        content: "Content",
      })
    ).rejects.toThrow("Proposal not found or not in draft status");
  });

  it("should handle proposal with null documentDrafts", async () => {
    const proposal = dbProposal({ documentDrafts: null });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await addDocumentDraft("proposal-uuid", COMPANY_UUID, {
      type: "prd",
      title: "PRD",
      content: "Content",
    });

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.documentDrafts).toHaveLength(1);
  });
});

// ====================================================================
// addTaskDraft
// ====================================================================

describe("addTaskDraft", () => {
  it("should append a new task draft to an existing proposal", async () => {
    const proposal = dbProposal({ taskDrafts: [validTaskDraft()] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await addTaskDraft("proposal-uuid", COMPANY_UUID, {
      title: "Task 2",
      description: "Second task",
    });

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.taskDrafts).toHaveLength(2);
    expect(updateCall.data.taskDrafts[1].title).toBe("Task 2");
    expect(updateCall.data.taskDrafts[1].uuid).toBeDefined();
  });

  it("should throw if proposal is not found or not in draft status", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      addTaskDraft("proposal-uuid", COMPANY_UUID, { title: "Task" })
    ).rejects.toThrow("Proposal not found or not in draft status");
  });

  it("should handle proposal with null taskDrafts", async () => {
    const proposal = dbProposal({ taskDrafts: null });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await addTaskDraft("proposal-uuid", COMPANY_UUID, { title: "Task 1" });

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.taskDrafts).toHaveLength(1);
  });
});

// ====================================================================
// updateDocumentDraft
// ====================================================================

describe("updateDocumentDraft", () => {
  it("should update fields on an existing document draft", async () => {
    const draft = validDocDraft({ uuid: "dd-1" });
    const proposal = dbProposal({ documentDrafts: [draft] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await updateDocumentDraft("proposal-uuid", COMPANY_UUID, "dd-1", {
      title: "Updated PRD",
      content: "New content",
    });

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.documentDrafts[0].title).toBe("Updated PRD");
    expect(updateCall.data.documentDrafts[0].content).toBe("New content");
  });

  it("should throw if document draft UUID is not found", async () => {
    const proposal = dbProposal({ documentDrafts: [validDocDraft({ uuid: "dd-1" })] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    await expect(
      updateDocumentDraft("proposal-uuid", COMPANY_UUID, "nonexistent", { title: "X" })
    ).rejects.toThrow("Document draft not found");
  });

  it("should throw if proposal is not in draft status", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      updateDocumentDraft("proposal-uuid", COMPANY_UUID, "dd-1", { title: "X" })
    ).rejects.toThrow("Proposal not found or not in draft status");
  });
});

// ====================================================================
// updateTaskDraft
// ====================================================================

describe("updateTaskDraft", () => {
  it("should update fields on an existing task draft", async () => {
    const draft = validTaskDraft({ uuid: "td-1" });
    const proposal = dbProposal({ taskDrafts: [draft] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await updateTaskDraft("proposal-uuid", COMPANY_UUID, "td-1", {
      title: "Updated Task",
      priority: "high",
    });

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.taskDrafts[0].title).toBe("Updated Task");
    expect(updateCall.data.taskDrafts[0].priority).toBe("high");
  });

  it("should throw if task draft UUID is not found", async () => {
    const proposal = dbProposal({ taskDrafts: [validTaskDraft({ uuid: "td-1" })] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    await expect(
      updateTaskDraft("proposal-uuid", COMPANY_UUID, "nonexistent", { title: "X" })
    ).rejects.toThrow("Task draft not found");
  });

  it("should throw if proposal is not in draft status", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      updateTaskDraft("proposal-uuid", COMPANY_UUID, "td-1", { title: "X" })
    ).rejects.toThrow("Proposal not found or not in draft status");
  });
});

// ====================================================================
// removeDocumentDraft
// ====================================================================

describe("removeDocumentDraft", () => {
  it("should remove a document draft by UUID", async () => {
    const drafts = [
      validDocDraft({ uuid: "dd-1" }),
      validDocDraft({ uuid: "dd-2", title: "Second" }),
    ];
    const proposal = dbProposal({ documentDrafts: drafts });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await removeDocumentDraft("proposal-uuid", COMPANY_UUID, "dd-1");

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.documentDrafts).toHaveLength(1);
    expect(updateCall.data.documentDrafts[0].uuid).toBe("dd-2");
  });

  it("should set documentDrafts to JsonNull when last draft is removed", async () => {
    const proposal = dbProposal({ documentDrafts: [validDocDraft({ uuid: "dd-1" })] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await removeDocumentDraft("proposal-uuid", COMPANY_UUID, "dd-1");

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.documentDrafts).toBe("DbNull"); // Prisma.JsonNull
  });

  it("should throw if proposal is not in draft status", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      removeDocumentDraft("proposal-uuid", COMPANY_UUID, "dd-1")
    ).rejects.toThrow("Proposal not found or not in draft status");
  });
});

// ====================================================================
// removeTaskDraft
// ====================================================================

describe("removeTaskDraft", () => {
  it("should remove a task draft by UUID", async () => {
    const drafts = [
      validTaskDraft({ uuid: "td-1" }),
      validTaskDraft({ uuid: "td-2", title: "Second" }),
    ];
    const proposal = dbProposal({ taskDrafts: drafts });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await removeTaskDraft("proposal-uuid", COMPANY_UUID, "td-1");

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.taskDrafts).toHaveLength(1);
    expect(updateCall.data.taskDrafts[0].uuid).toBe("td-2");
  });

  it("should set taskDrafts to JsonNull when last draft is removed", async () => {
    const proposal = dbProposal({ taskDrafts: [validTaskDraft({ uuid: "td-1" })] });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await removeTaskDraft("proposal-uuid", COMPANY_UUID, "td-1");

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    expect(updateCall.data.taskDrafts).toBe("DbNull");
  });

  it("should clean up dependsOnDraftUuids references to the removed draft", async () => {
    const drafts = [
      validTaskDraft({ uuid: "td-1" }),
      validTaskDraft({ uuid: "td-2", dependsOnDraftUuids: ["td-1", "td-3"] }),
      validTaskDraft({ uuid: "td-3", dependsOnDraftUuids: ["td-1"] }),
    ];
    const proposal = dbProposal({ taskDrafts: drafts });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue(proposal);

    await removeTaskDraft("proposal-uuid", COMPANY_UUID, "td-1");

    const updateCall = mockPrisma.proposal.update.mock.calls[0][0];
    const remaining = updateCall.data.taskDrafts;
    expect(remaining).toHaveLength(2);
    // td-2 should have td-1 removed from deps, keeping td-3
    expect(remaining[0].dependsOnDraftUuids).toEqual(["td-3"]);
    // td-3 should have td-1 removed, leaving empty
    expect(remaining[1].dependsOnDraftUuids).toEqual([]);
  });

  it("should throw if proposal is not in draft status", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      removeTaskDraft("proposal-uuid", COMPANY_UUID, "td-1")
    ).rejects.toThrow("Proposal not found or not in draft status");
  });
});

// ====================================================================
// validateProposal — 10+ distinct business rules
// ====================================================================

describe("validateProposal", () => {
  it("should throw if proposal not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      validateProposal(COMPANY_UUID, "nonexistent")
    ).rejects.toThrow("Proposal not found");
  });

  it("E1: should error when no document drafts at all", async () => {
    const proposal = dbProposal({
      documentDrafts: [],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e1 = result.issues.find((i) => i.id === "E1");
    expect(e1).toBeDefined();
    expect(e1!.level).toBe("error");
    expect(result.valid).toBe(false);
  });

  it("E1: should pass when non-PRD document draft exists", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft({ type: "tech_design" })],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e1 = result.issues.find((i) => i.id === "E1");
    expect(e1).toBeUndefined();
  });

  it("E2: should error when document draft content < 100 chars", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft({ content: "short" })],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e2 = result.issues.find((i) => i.id === "E2");
    expect(e2).toBeDefined();
    expect(e2!.level).toBe("error");
    expect(e2!.field).toBe("PRD");
  });

  it("E2: should error when document draft has empty content", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft({ content: "" })],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    expect(result.issues.some((i) => i.id === "E2")).toBe(true);
  });

  it("E3: should error when no task drafts", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e3 = result.issues.find((i) => i.id === "E3");
    expect(e3).toBeDefined();
    expect(e3!.level).toBe("error");
  });

  it("E4: should error when inputUuids is empty", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      inputUuids: [],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e4 = result.issues.find((i) => i.id === "E4");
    expect(e4).toBeDefined();
    expect(e4!.level).toBe("error");
  });

  it("E5: should error when input idea has unresolved elaboration", async () => {
    const proposal = dbProposal({
      inputType: "idea",
      inputUuids: ["idea-1"],
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "idea-1", title: "My Idea", elaborationStatus: "pending" },
    ]);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e5 = result.issues.find((i) => i.id === "E5");
    expect(e5).toBeDefined();
    expect(e5!.level).toBe("error");
    expect(e5!.message).toContain("unresolved elaboration");
  });

  it("E5: should not error when input idea has resolved elaboration", async () => {
    const proposal = dbProposal({
      inputType: "idea",
      inputUuids: ["idea-1"],
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "idea-1", title: "My Idea", elaborationStatus: "resolved" },
    ]);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e5 = result.issues.find((i) => i.id === "E5");
    expect(e5).toBeUndefined();
  });

  it("E5: should skip idea elaboration check for non-idea input types", async () => {
    const proposal = dbProposal({
      inputType: "manual",
      inputUuids: ["source-1"],
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    expect(mockPrisma.idea.findMany).not.toHaveBeenCalled();
    const e5 = result.issues.find((i) => i.id === "E5");
    expect(e5).toBeUndefined();
  });

  it("E-AC: should error when task draft has no acceptance criteria", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [
        validTaskDraft({
          uuid: "td-no-ac",
          title: "No AC Task",
          acceptanceCriteria: null,
          acceptanceCriteriaItems: undefined,
        }),
      ],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const eac = result.issues.find((i) => i.id === "E-AC");
    expect(eac).toBeDefined();
    expect(eac!.level).toBe("error");
    expect(eac!.field).toBe("No AC Task");
  });

  it("E-AC: should pass when task draft has structured acceptanceCriteriaItems", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [
        validTaskDraft({
          acceptanceCriteria: null,
          acceptanceCriteriaItems: [{ description: "It works", required: true }],
        }),
      ],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const eac = result.issues.find((i) => i.id === "E-AC");
    expect(eac).toBeUndefined();
  });

  it("E-AC: should error when task draft has only legacy acceptanceCriteria (no structured items)", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [
        validTaskDraft({
          acceptanceCriteria: "- [ ] Something done",
          acceptanceCriteriaItems: undefined,
        }),
      ],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const eac = result.issues.find((i) => i.id === "E-AC");
    expect(eac).toBeDefined();
    expect(eac!.level).toBe("error");
  });

  it("W1: should warn when no tech_design document draft", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft({ type: "prd" })],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w1 = result.issues.find((i) => i.id === "W1");
    expect(w1).toBeDefined();
    expect(w1!.level).toBe("warning");
  });

  it("W1: should not warn when tech_design is present", async () => {
    const proposal = dbProposal({
      documentDrafts: [
        validDocDraft({ type: "prd" }),
        validDocDraft({ uuid: "dd-2", type: "tech_design", title: "Design" }),
      ],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w1 = result.issues.find((i) => i.id === "W1");
    expect(w1).toBeUndefined();
  });

  it("W2: should warn when task draft has empty description", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft({ description: "" })],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w2 = result.issues.find((i) => i.id === "W2");
    expect(w2).toBeDefined();
    expect(w2!.level).toBe("warning");
  });

  it("W2: should warn when task draft description is missing", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft({ description: undefined })],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w2 = result.issues.find((i) => i.id === "W2");
    expect(w2).toBeDefined();
  });

  it("W4: should warn when >= 2 tasks but none have dependencies", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [
        validTaskDraft({ uuid: "td-1" }),
        validTaskDraft({ uuid: "td-2", title: "Task 2" }),
      ],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w4 = result.issues.find((i) => i.id === "W4");
    expect(w4).toBeDefined();
    expect(w4!.level).toBe("warning");
  });

  it("W4: should not warn when at least one task has dependencies", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [
        validTaskDraft({ uuid: "td-1" }),
        validTaskDraft({ uuid: "td-2", title: "Task 2", dependsOnDraftUuids: ["td-1"] }),
      ],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w4 = result.issues.find((i) => i.id === "W4");
    expect(w4).toBeUndefined();
  });

  it("W4: should not warn when only 1 task (no need for deps)", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w4 = result.issues.find((i) => i.id === "W4");
    expect(w4).toBeUndefined();
  });

  it("W5: should warn when proposal description is empty", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w5 = result.issues.find((i) => i.id === "W5");
    expect(w5).toBeDefined();
    expect(w5!.level).toBe("warning");
  });

  it("W5: should warn when proposal description is null", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: null,
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const w5 = result.issues.find((i) => i.id === "W5");
    expect(w5).toBeDefined();
  });

  it("I1: should info when task draft has no priority", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft({ priority: undefined })],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const i1 = result.issues.find((i) => i.id === "I1");
    expect(i1).toBeDefined();
    expect(i1!.level).toBe("info");
  });

  it("I2: should info when task draft has no storyPoints", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft({ storyPoints: undefined })],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const i2 = result.issues.find((i) => i.id === "I2");
    expect(i2).toBeDefined();
    expect(i2!.level).toBe("info");
  });

  it("should return valid=true when only warnings and info (no errors)", async () => {
    const proposal = dbProposal({
      documentDrafts: [validDocDraft({ type: "prd" })],
      taskDrafts: [
        validTaskDraft({ description: "", priority: undefined, storyPoints: undefined }),
      ],
      inputUuids: ["idea-1"],
      description: "",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    // Has W1, W2, W5, I1, I2 but no errors
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((i) => i.level !== "error")).toBe(true);
  });

  it("should return valid=false when there are error-level issues", async () => {
    const proposal = dbProposal({
      documentDrafts: [],
      taskDrafts: [],
      inputUuids: [],
      description: "",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.level === "error")).toBe(true);
  });

  it("should report multiple errors for multiple invalid document drafts", async () => {
    const proposal = dbProposal({
      documentDrafts: [
        validDocDraft({ uuid: "dd-1", title: "Short Doc 1", content: "a" }),
        validDocDraft({ uuid: "dd-2", title: "Short Doc 2", content: "b" }),
      ],
      taskDrafts: [validTaskDraft()],
      inputUuids: ["idea-1"],
      description: "Has description",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await validateProposal(COMPANY_UUID, proposal.uuid);
    const e2Issues = result.issues.filter((i) => i.id === "E2");
    expect(e2Issues).toHaveLength(2);
  });
});

// ====================================================================
// submitProposal
// ====================================================================

describe("submitProposal", () => {
  it("should throw if proposal not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      submitProposal("nonexistent", COMPANY_UUID)
    ).rejects.toThrow("Proposal not found");
  });

  it("should throw if proposal is not in draft status", async () => {
    const proposal = dbProposal({ status: "pending" });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    await expect(
      submitProposal(proposal.uuid, COMPANY_UUID)
    ).rejects.toThrow("Only draft proposals can be submitted for review");
  });

  it("should throw with validation errors if proposal fails validation", async () => {
    // findFirst is called by submitProposal, then again by validateProposal
    const proposal = dbProposal({
      status: "draft",
      documentDrafts: [],
      taskDrafts: [],
      inputUuids: [],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    await expect(
      submitProposal(proposal.uuid, COMPANY_UUID)
    ).rejects.toThrow("Proposal validation failed");
  });

  it("should transition to pending status on valid proposal", async () => {
    const proposal = dbProposal({
      status: "draft",
      inputType: "idea",
      inputUuids: ["idea-1"],
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      description: "Good proposal",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "idea-1", title: "Idea", elaborationStatus: "resolved" },
    ]);
    const updatedProposal = dbProposal({ ...proposal, status: "pending" });
    mockPrisma.proposal.update.mockResolvedValue(updatedProposal);
    mockPrisma.idea.updateMany.mockResolvedValue({ count: 1 });

    const result = await submitProposal(proposal.uuid, COMPANY_UUID);

    expect(mockPrisma.proposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "pending" },
      })
    );
    expect(result.status).toBe("pending");
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should NOT auto-transition input ideas on submit (status derived from proposal/tasks)", async () => {
    const proposal = dbProposal({
      status: "draft",
      inputType: "idea",
      inputUuids: ["idea-1", "idea-2"],
      documentDrafts: [validDocDraft()],
      taskDrafts: [validTaskDraft()],
      description: "Good proposal",
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "idea-1", title: "Idea 1", elaborationStatus: "resolved" },
      { uuid: "idea-2", title: "Idea 2", elaborationStatus: "resolved" },
    ]);
    mockPrisma.proposal.update.mockResolvedValue(dbProposal({ ...proposal, status: "pending" }));

    await submitProposal(proposal.uuid, COMPANY_UUID);

    // Should NOT call idea.updateMany — idea status is no longer changed on proposal submit
    expect(mockPrisma.idea.updateMany).not.toHaveBeenCalled();
  });
});

// ====================================================================
// approveProposal
// ====================================================================

describe("approveProposal", () => {
  it("should throw if proposal not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      approveProposal("nonexistent", COMPANY_UUID, "reviewer-uuid")
    ).rejects.toThrow("Proposal not found");
  });

  it("should update status to approved and materialize documents", async () => {
    const docDraft = validDocDraft();
    const proposal = dbProposal({
      status: "pending",
      documentDrafts: [docDraft],
      taskDrafts: null,
      inputType: "manual",
      inputUuids: ["source-1"],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const updatedRow = dbProposal({ ...proposal, status: "approved" });
    const txMock = {
      proposal: { update: vi.fn().mockResolvedValue(updatedRow) },
      document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid-1", title: docDraft.title }]) },
      task: { createManyAndReturn: vi.fn() },
      taskDependency: { createMany: vi.fn() },
      acceptanceCriterion: { createMany: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));

    const result = await approveProposal(proposal.uuid, COMPANY_UUID, "reviewer-uuid", "Looks good");

    expect(txMock.document.createManyAndReturn).toHaveBeenCalledOnce();
    expect(result.status).toBe("approved");
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "proposal", action: "updated" })
    );
  });

  it("should materialize tasks and dependencies", async () => {
    const taskDrafts = [
      validTaskDraft({ uuid: "td-1", title: "Task 1" }),
      validTaskDraft({ uuid: "td-2", title: "Task 2", dependsOnDraftUuids: ["td-1"] }),
    ];
    const proposal = dbProposal({
      status: "pending",
      documentDrafts: [validDocDraft()],
      taskDrafts,
      inputType: "manual",
      inputUuids: ["source-1"],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const txMock = {
      proposal: { update: vi.fn().mockResolvedValue(dbProposal({ ...proposal, status: "approved" })) },
      document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid", title: "Doc" }]) },
      task: { createManyAndReturn: vi.fn().mockResolvedValue([
        { uuid: "real-task-1", title: "Task 1" },
        { uuid: "real-task-2", title: "Task 2" },
      ]) },
      taskDependency: { createMany: vi.fn() },
      acceptanceCriterion: { createMany: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));

    await approveProposal(proposal.uuid, COMPANY_UUID, "reviewer-uuid");

    expect(txMock.task.createManyAndReturn).toHaveBeenCalledOnce();
    expect(txMock.taskDependency.createMany).toHaveBeenCalledWith({
      data: [{ taskUuid: "real-task-2", dependsOnUuid: "real-task-1" }],
    });
  });

  it("should materialize acceptance criteria items", async () => {
    const taskDrafts = [
      validTaskDraft({
        uuid: "td-1",
        acceptanceCriteriaItems: [
          { description: "Criterion 1", required: true },
          { description: "Criterion 2", required: false },
        ],
      }),
    ];
    const proposal = dbProposal({
      status: "pending",
      documentDrafts: [validDocDraft()],
      taskDrafts,
      inputType: "manual",
      inputUuids: ["source-1"],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const txMock = {
      proposal: { update: vi.fn().mockResolvedValue(dbProposal({ ...proposal, status: "approved" })) },
      document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid", title: "Doc" }]) },
      task: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "real-task-1", title: "Task 1" }]) },
      taskDependency: { createMany: vi.fn() },
      acceptanceCriterion: { createMany: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));

    await approveProposal(proposal.uuid, COMPANY_UUID, "reviewer-uuid");

    expect(txMock.acceptanceCriterion.createMany).toHaveBeenCalledWith({
      data: [
        { taskUuid: "real-task-1", description: "Criterion 1", required: true, sortOrder: 0 },
        { taskUuid: "real-task-1", description: "Criterion 2", required: false, sortOrder: 1 },
      ],
    });
  });

  it("should throw when acceptanceCriteriaItems has empty description", async () => {
    const taskDrafts = [
      validTaskDraft({
        uuid: "td-1",
        acceptanceCriteriaItems: [{ description: "", required: true }],
      }),
    ];
    const proposal = dbProposal({
      status: "pending",
      documentDrafts: [validDocDraft()],
      taskDrafts,
      inputType: "manual",
      inputUuids: ["source-1"],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        proposal: { update: vi.fn().mockResolvedValue(dbProposal({ ...proposal, status: "approved" })) },
        document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid", title: "Doc" }]) },
        task: { createManyAndReturn: vi.fn() },
        taskDependency: { createMany: vi.fn() },
        acceptanceCriterion: { createMany: vi.fn() },
      };
      return cb(tx);
    });

    await expect(
      approveProposal(proposal.uuid, COMPANY_UUID, "reviewer-uuid")
    ).rejects.toThrow("empty or invalid description");
  });

  it("should NOT auto-complete input ideas when approved (derived status handles lifecycle)", async () => {
    const proposal = dbProposal({
      status: "pending",
      documentDrafts: null,
      taskDrafts: null,
      inputType: "idea",
      inputUuids: ["idea-1"],
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const updatedRow = dbProposal({ ...proposal, status: "approved" });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        proposal: { update: vi.fn().mockResolvedValue(updatedRow) },
        document: { createManyAndReturn: vi.fn() },
        task: { createManyAndReturn: vi.fn() },
        taskDependency: { createMany: vi.fn() },
        acceptanceCriterion: { createMany: vi.fn() },
      };
      return cb(tx);
    });

    await approveProposal(proposal.uuid, COMPANY_UUID, "reviewer-uuid");

    // Ideas should NOT be auto-completed — derived status is computed from task progress
    expect(mockPrisma.idea.updateMany).not.toHaveBeenCalled();
  });
});

// ====================================================================
// rejectProposal
// ====================================================================

describe("rejectProposal", () => {
  it("should transition proposal to draft status with review note", async () => {
    const updated = dbProposal({
      status: "draft",
      reviewedByUuid: "reviewer-uuid",
      reviewNote: "Needs work",
      reviewedAt: new Date(),
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    const result = await rejectProposal("proposal-uuid", "reviewer-uuid", "Needs work");

    expect(mockPrisma.proposal.update).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid" },
      data: expect.objectContaining({
        status: "draft",
        reviewedByUuid: "reviewer-uuid",
        reviewNote: "Needs work",
      }),
      include: { project: { select: { uuid: true, name: true } } },
    });
    expect(result.status).toBe("draft");
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "proposal", action: "updated" })
    );
  });
});

// ====================================================================
// closeProposal
// ====================================================================

describe("closeProposal", () => {
  it("should transition proposal to closed status", async () => {
    const updated = dbProposal({
      status: "closed",
      reviewedByUuid: "admin-uuid",
      reviewNote: "No longer needed",
      reviewedAt: new Date(),
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    const result = await closeProposal("proposal-uuid", "admin-uuid", "No longer needed");

    expect(mockPrisma.proposal.update).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid" },
      data: expect.objectContaining({
        status: "closed",
        reviewedByUuid: "admin-uuid",
        reviewNote: "No longer needed",
      }),
      include: { project: { select: { uuid: true, name: true } } },
    });
    expect(result.status).toBe("closed");
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "proposal", action: "updated" })
    );
  });
});

// ====================================================================
// revokeProposal
// ====================================================================

describe("revokeProposal", () => {
  it("should revoke an approved proposal and return closed tasks and deleted documents", async () => {
    const proposal = dbProposal({ status: "approved" });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "task-uuid-1", title: "Task 1" },
      { uuid: "task-uuid-2", title: "Task 2" },
    ]);
    mockPrisma.document.findMany.mockResolvedValue([
      { uuid: "doc-uuid-1", title: "PRD" },
    ]);

    const txMock = {
      sessionTaskCheckin: { deleteMany: vi.fn() },
      acceptanceCriterion: { deleteMany: vi.fn() },
      taskDependency: { deleteMany: vi.fn() },
      comment: { deleteMany: vi.fn() },
      task: { updateMany: vi.fn() },
      document: { deleteMany: vi.fn() },
      proposal: { update: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));

    const result = await revokeProposal(proposal.uuid, COMPANY_UUID, ACTOR_UUID, "Revoking due to scope change");

    expect(result.proposalUuid).toBe(proposal.uuid);
    expect(result.closedTasks).toEqual([
      { uuid: "task-uuid-1", title: "Task 1" },
      { uuid: "task-uuid-2", title: "Task 2" },
    ]);
    expect(result.deletedDocuments).toEqual([
      { uuid: "doc-uuid-1", title: "PRD" },
    ]);

    // Verify transaction operations
    expect(txMock.sessionTaskCheckin.deleteMany).toHaveBeenCalled();
    expect(txMock.task.updateMany).toHaveBeenCalledWith({
      where: { proposalUuid: proposal.uuid },
      data: { status: "closed" },
    });
    expect(txMock.document.deleteMany).toHaveBeenCalledWith({
      where: { proposalUuid: proposal.uuid },
    });
    expect(txMock.proposal.update).toHaveBeenCalledWith({
      where: { uuid: proposal.uuid },
      data: {
        status: "draft",
        reviewedByUuid: ACTOR_UUID,
        reviewedAt: expect.any(Date),
        reviewNote: "Revoking due to scope change",
      },
    });
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "proposal", action: "updated" })
    );
  });

  it("should throw if proposal is not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      revokeProposal("nonexistent", COMPANY_UUID, ACTOR_UUID, "Revoke")
    ).rejects.toThrow("Proposal not found");
  });

  it("should throw if proposal is not in approved status", async () => {
    const draftProposal = dbProposal({ status: "draft" });
    mockPrisma.proposal.findFirst.mockResolvedValue(draftProposal);

    await expect(
      revokeProposal(draftProposal.uuid, COMPANY_UUID, ACTOR_UUID, "Revoke")
    ).rejects.toThrow("Only approved proposals can be revoked");

    const pendingProposal = dbProposal({ status: "pending" });
    mockPrisma.proposal.findFirst.mockResolvedValue(pendingProposal);

    await expect(
      revokeProposal(pendingProposal.uuid, COMPANY_UUID, ACTOR_UUID, "Revoke")
    ).rejects.toThrow("Only approved proposals can be revoked");
  });

  it("should return closedTasks and deletedDocuments with uuid and title", async () => {
    const proposal = dbProposal({ status: "approved" });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "task-a", title: "Alpha Task" },
    ]);
    mockPrisma.document.findMany.mockResolvedValue([
      { uuid: "doc-a", title: "Alpha Doc" },
      { uuid: "doc-b", title: "Beta Doc" },
    ]);

    const txMock = {
      sessionTaskCheckin: { deleteMany: vi.fn() },
      acceptanceCriterion: { deleteMany: vi.fn() },
      taskDependency: { deleteMany: vi.fn() },
      comment: { deleteMany: vi.fn() },
      task: { updateMany: vi.fn() },
      document: { deleteMany: vi.fn() },
      proposal: { update: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));

    const result = await revokeProposal(proposal.uuid, COMPANY_UUID, ACTOR_UUID, "Revoke note");

    // Verify return value shape
    expect(result.closedTasks).toHaveLength(1);
    expect(result.closedTasks[0]).toEqual({ uuid: "task-a", title: "Alpha Task" });
    expect(result.deletedDocuments).toHaveLength(2);
    expect(result.deletedDocuments[0]).toEqual({ uuid: "doc-a", title: "Alpha Doc" });
    expect(result.deletedDocuments[1]).toEqual({ uuid: "doc-b", title: "Beta Doc" });
  });

  it("should handle empty tasks and documents gracefully", async () => {
    const proposal = dbProposal({ status: "approved" });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.document.findMany.mockResolvedValue([]);

    const txMock = {
      sessionTaskCheckin: { deleteMany: vi.fn() },
      acceptanceCriterion: { deleteMany: vi.fn() },
      taskDependency: { deleteMany: vi.fn() },
      comment: { deleteMany: vi.fn() },
      task: { updateMany: vi.fn() },
      document: { deleteMany: vi.fn() },
      proposal: { update: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));

    const result = await revokeProposal(proposal.uuid, COMPANY_UUID, ACTOR_UUID, "Revoke empty");

    expect(result.proposalUuid).toBe(proposal.uuid);
    expect(result.closedTasks).toEqual([]);
    expect(result.deletedDocuments).toEqual([]);

    // When no tasks, task cleanup operations should NOT be called
    expect(txMock.sessionTaskCheckin.deleteMany).not.toHaveBeenCalled();
    expect(txMock.task.updateMany).not.toHaveBeenCalled();

    // When no documents, document cleanup should NOT be called
    expect(txMock.document.deleteMany).not.toHaveBeenCalled();

    // Proposal update should always happen
    expect(txMock.proposal.update).toHaveBeenCalledWith({
      where: { uuid: proposal.uuid },
      data: {
        status: "draft",
        reviewedByUuid: ACTOR_UUID,
        reviewedAt: expect.any(Date),
        reviewNote: "Revoke empty",
      },
    });
  });
});

// ====================================================================
// deleteProposal
// ====================================================================

describe("deleteProposal", () => {
  it("should delete a draft proposal", async () => {
    const proposal = dbProposal({ status: "draft" });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.delete.mockResolvedValue(proposal);

    await deleteProposal("proposal-uuid", COMPANY_UUID);

    expect(mockPrisma.proposal.findFirst).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid", companyUuid: COMPANY_UUID },
    });
    expect(mockPrisma.proposal.delete).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid" },
    });
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "proposal", action: "deleted" })
    );
  });

  it("should delete a proposal in any status", async () => {
    for (const status of ["closed", "pending", "approved"]) {
      const proposal = dbProposal({ status });
      mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
      mockPrisma.proposal.delete.mockResolvedValue(proposal);

      await deleteProposal("proposal-uuid", COMPANY_UUID);

      expect(mockPrisma.proposal.delete).toHaveBeenCalledWith({
        where: { uuid: "proposal-uuid" },
      });
    }
  });

  it("should throw when proposal not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(deleteProposal("nonexistent", COMPANY_UUID)).rejects.toThrow("Proposal not found");
  });
});

// ====================================================================
// listProposals
// ====================================================================

describe("listProposals", () => {
  it("should return paginated list of proposals", async () => {
    const proposal1 = dbProposal({ uuid: "proposal-1", title: "Proposal 1" });
    const proposal2 = dbProposal({ uuid: "proposal-2", title: "Proposal 2" });

    mockPrisma.proposal.findMany.mockResolvedValue([proposal1, proposal2]);
    mockPrisma.proposal.count.mockResolvedValue(2);

    const result = await listProposals({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 20,
    });

    expect(result.proposals).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.proposals[0].uuid).toBe("proposal-1");
    expect(result.proposals[1].uuid).toBe("proposal-2");
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectUuid: PROJECT_UUID, companyUuid: COMPANY_UUID },
        skip: 0,
        take: 20,
      })
    );
  });

  it("should filter by status when provided", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.proposal.count.mockResolvedValue(0);

    await listProposals({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 20,
      status: "pending",
    });

    expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectUuid: PROJECT_UUID, companyUuid: COMPANY_UUID, status: "pending" },
      })
    );
  });
});

// ====================================================================
// getProposal
// ====================================================================

describe("getProposal", () => {
  it("should return proposal with project info", async () => {
    const proposal = dbProposal({
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    });
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await getProposal(COMPANY_UUID, "proposal-uuid");

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(proposal.uuid);
    expect(result!.project).toEqual({ uuid: PROJECT_UUID, name: "Test Project" });
    expect(mockPrisma.proposal.findFirst).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid", companyUuid: COMPANY_UUID },
      include: { project: { select: { uuid: true, name: true } } },
    });
  });

  it("should return null when proposal not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    const result = await getProposal(COMPANY_UUID, "nonexistent");
    expect(result).toBeNull();
  });
});

// ====================================================================
// getProposalByUuid
// ====================================================================

describe("getProposalByUuid", () => {
  it("should return raw proposal data", async () => {
    const proposal = dbProposal();
    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    const result = await getProposalByUuid(COMPANY_UUID, "proposal-uuid");

    expect(result).toEqual(proposal);
    expect(mockPrisma.proposal.findFirst).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid", companyUuid: COMPANY_UUID },
    });
  });

  it("should return null when not found", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    const result = await getProposalByUuid(COMPANY_UUID, "nonexistent");
    expect(result).toBeNull();
  });
});

// ====================================================================
// updateProposalContent
// ====================================================================

describe("updateProposalContent", () => {
  it("should update title and description", async () => {
    const updated = dbProposal({
      title: "Updated Title",
      description: "Updated Description",
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    const result = await updateProposalContent("proposal-uuid", COMPANY_UUID, {
      title: "Updated Title",
      description: "Updated Description",
    });

    expect(result.title).toBe("Updated Title");
    expect(result.description).toBe("Updated Description");
    expect(mockPrisma.proposal.update).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid", companyUuid: COMPANY_UUID },
      data: expect.objectContaining({
        title: "Updated Title",
        description: "Updated Description",
      }),
      include: { project: { select: { uuid: true, name: true } } },
    });
  });

  it("should update documentDrafts", async () => {
    const newDrafts = [validDocDraft({ uuid: "draft-1", title: "New Doc" })];
    const updated = dbProposal({
      documentDrafts: newDrafts,
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    const result = await updateProposalContent("proposal-uuid", COMPANY_UUID, {
      documentDrafts: newDrafts,
    });

    expect(result.documentDrafts).toEqual(newDrafts);
    expect(mockPrisma.proposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentDrafts: expect.anything(),
        }),
      })
    );
  });

  it("should update taskDrafts", async () => {
    const newTasks = [validTaskDraft({ uuid: "task-1", title: "New Task" })];
    const updated = dbProposal({
      taskDrafts: newTasks,
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    const result = await updateProposalContent("proposal-uuid", COMPANY_UUID, {
      taskDrafts: newTasks,
    });

    expect(result.taskDrafts).toEqual(newTasks);
  });

  it("should handle null values for documentDrafts and taskDrafts", async () => {
    const updated = dbProposal({
      documentDrafts: null,
      taskDrafts: null,
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    const result = await updateProposalContent("proposal-uuid", COMPANY_UUID, {
      documentDrafts: null,
      taskDrafts: null,
    });

    expect(result.documentDrafts).toBeNull();
    expect(result.taskDrafts).toBeNull();
    expect(mockPrisma.proposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentDrafts: "DbNull",
          taskDrafts: "DbNull",
        }),
      })
    );
  });

  it("should allow partial updates", async () => {
    const updated = dbProposal({
      title: "New Title",
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    });
    mockPrisma.proposal.update.mockResolvedValue(updated);

    await updateProposalContent("proposal-uuid", COMPANY_UUID, {
      title: "New Title",
    });

    expect(mockPrisma.proposal.update).toHaveBeenCalledWith({
      where: { uuid: "proposal-uuid", companyUuid: COMPANY_UUID },
      data: { title: "New Title" },
      include: { project: { select: { uuid: true, name: true } } },
    });
  });
});

// ===== checkIdeasAvailability =====
describe("checkIdeasAvailability", () => {
  it("should return available=true when no ideas are used", async () => {
    const { checkIdeasAvailability } = await import("@/services/proposal.service");

    mockPrisma.proposal.findMany.mockResolvedValue([]);

    const result = await checkIdeasAvailability(COMPANY_UUID, ["idea-1", "idea-2"]);

    expect(result.available).toBe(true);
    expect(result.usedIdeas).toHaveLength(0);
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY_UUID, inputType: "idea" },
      select: { uuid: true, title: true, inputUuids: true },
    });
  });

  it("should return available=false when ideas are already used", async () => {
    const { checkIdeasAvailability } = await import("@/services/proposal.service");

    mockPrisma.proposal.findMany.mockResolvedValue([
      {
        uuid: "proposal-1",
        title: "Existing Proposal 1",
        inputUuids: ["idea-1", "idea-3"],
      },
      {
        uuid: "proposal-2",
        title: "Existing Proposal 2",
        inputUuids: ["idea-2"],
      },
    ]);

    const result = await checkIdeasAvailability(COMPANY_UUID, ["idea-1", "idea-2"]);

    expect(result.available).toBe(false);
    expect(result.usedIdeas).toHaveLength(2);
    expect(result.usedIdeas).toEqual([
      { uuid: "idea-1", proposalUuid: "proposal-1", proposalTitle: "Existing Proposal 1" },
      { uuid: "idea-2", proposalUuid: "proposal-2", proposalTitle: "Existing Proposal 2" },
    ]);
  });

  it("should return only overlapping ideas", async () => {
    const { checkIdeasAvailability } = await import("@/services/proposal.service");

    mockPrisma.proposal.findMany.mockResolvedValue([
      {
        uuid: "proposal-1",
        title: "Existing Proposal",
        inputUuids: ["idea-1", "idea-5"],
      },
    ]);

    const result = await checkIdeasAvailability(COMPANY_UUID, ["idea-1", "idea-2", "idea-3"]);

    expect(result.available).toBe(false);
    expect(result.usedIdeas).toHaveLength(1);
    expect(result.usedIdeas[0].uuid).toBe("idea-1");
  });
});

// ===== checkIdeasAssignee =====
describe("checkIdeasAssignee", () => {
  it("should return valid=true when actor is assignee of all ideas", async () => {
    const { checkIdeasAssignee } = await import("@/services/proposal.service");

    mockPrisma.idea.findMany.mockResolvedValue([
      {
        uuid: "idea-1",
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      },
      {
        uuid: "idea-2",
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      },
    ]);

    const result = await checkIdeasAssignee(COMPANY_UUID, ["idea-1", "idea-2"], ACTOR_UUID, "agent");

    expect(result.valid).toBe(true);
    expect(result.unassignedIdeas).toHaveLength(0);
  });

  it("should return valid=false when actor is not assignee of some ideas", async () => {
    const { checkIdeasAssignee } = await import("@/services/proposal.service");

    mockPrisma.idea.findMany.mockResolvedValue([
      {
        uuid: "idea-1",
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      },
      {
        uuid: "idea-2",
        assigneeType: "agent",
        assigneeUuid: "other-agent-uuid",
      },
      {
        uuid: "idea-3",
        assigneeType: "user",
        assigneeUuid: "user-uuid",
      },
    ]);

    const result = await checkIdeasAssignee(COMPANY_UUID, ["idea-1", "idea-2", "idea-3"], ACTOR_UUID, "agent");

    expect(result.valid).toBe(false);
    expect(result.unassignedIdeas).toEqual(["idea-2", "idea-3"]);
  });

  it("should handle actor type mismatch", async () => {
    const { checkIdeasAssignee } = await import("@/services/proposal.service");

    mockPrisma.idea.findMany.mockResolvedValue([
      {
        uuid: "idea-1",
        assigneeType: "user",
        assigneeUuid: ACTOR_UUID,
      },
    ]);

    const result = await checkIdeasAssignee(COMPANY_UUID, ["idea-1"], ACTOR_UUID, "agent");

    expect(result.valid).toBe(false);
    expect(result.unassignedIdeas).toEqual(["idea-1"]);
  });
});

// ===== approveProposal edge cases =====
describe("approveProposal - edge cases", () => {
  it("should handle tasks with no dependencies gracefully", async () => {
    const proposalWithDeps = dbProposal({
      status: "pending",
      documentDrafts: [{ uuid: "doc-1", type: "prd", title: "PRD", content: LONG_CONTENT }],
      taskDrafts: [
        { uuid: "task-1", title: "Task 1", description: "Task 1", acceptanceCriteriaItems: [{ description: "Criteria", required: true }] },
        { uuid: "task-2", title: "Task 2", description: "Task 2", acceptanceCriteriaItems: [{ description: "Criteria", required: true }] },
      ],
    });

    mockPrisma.proposal.findFirst.mockResolvedValue(proposalWithDeps);

    const txMock = {
      proposal: { update: vi.fn().mockResolvedValue({ ...proposalWithDeps, status: "approved", project: { uuid: PROJECT_UUID, name: "Test" } }) },
      document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid", title: "PRD" }]) },
      task: { createManyAndReturn: vi.fn().mockResolvedValue([
        { uuid: "real-task-1", title: "Task 1" },
        { uuid: "real-task-2", title: "Task 2" },
      ]) },
      taskDependency: { createMany: vi.fn() },
      acceptanceCriterion: { createMany: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(txMock));

    await approveProposal("proposal-uuid", COMPANY_UUID, "reviewer-uuid", "Approved");

    // No dependencies, so taskDependency.createMany should not be called
    expect(txMock.taskDependency.createMany).not.toHaveBeenCalled();
    expect(txMock.task.createManyAndReturn).toHaveBeenCalled();
  });

  it("should handle tasks with no acceptance criteria gracefully", async () => {
    const proposalWithAC = dbProposal({
      status: "pending",
      documentDrafts: [{ uuid: "doc-1", type: "prd", title: "PRD", content: LONG_CONTENT }],
      taskDrafts: [
        { uuid: "task-1", title: "Task 1", description: "Task 1" },
      ],
    });

    mockPrisma.proposal.findFirst.mockResolvedValue(proposalWithAC);

    const txMock = {
      proposal: { update: vi.fn().mockResolvedValue({ ...proposalWithAC, status: "approved", project: { uuid: PROJECT_UUID, name: "Test" } }) },
      document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid", title: "PRD" }]) },
      task: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "real-task-1", title: "Task 1" }]) },
      taskDependency: { createMany: vi.fn() },
      acceptanceCriterion: { createMany: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(txMock));

    await approveProposal("proposal-uuid", COMPANY_UUID, "reviewer-uuid", "Approved");

    // No AC items, so acceptanceCriterion.createMany should not be called
    expect(txMock.acceptanceCriterion.createMany).not.toHaveBeenCalled();
    expect(txMock.task.createManyAndReturn).toHaveBeenCalled();
  });
});

// ---------- getProjectProposals ----------

describe("getProjectProposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns approved proposals with task counts and sequence numbers", async () => {
    const now = new Date();
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "Proposal 1", createdAt: now },
      { uuid: "p2", title: "Proposal 2", createdAt: new Date(now.getTime() + 1000) },
    ]);
    mockPrisma.task.groupBy.mockResolvedValue([
      { proposalUuid: "p1", _count: 3 },
      { proposalUuid: "p2", _count: 1 },
    ]);

    const result = await getProjectProposals(COMPANY_UUID, PROJECT_UUID);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ uuid: "p1", title: "Proposal 1", sequenceNumber: 1, taskCount: 3 });
    expect(result[1]).toEqual({ uuid: "p2", title: "Proposal 2", sequenceNumber: 2, taskCount: 1 });

    // Verify query filters
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid: COMPANY_UUID, projectUuid: PROJECT_UUID, status: "approved" },
      }),
    );
  });

  it("returns 0 task count for proposals with no tasks", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "Proposal 1", createdAt: new Date() },
    ]);
    mockPrisma.task.groupBy.mockResolvedValue([]);

    const result = await getProjectProposals(COMPANY_UUID, PROJECT_UUID);

    expect(result).toHaveLength(1);
    expect(result[0].taskCount).toBe(0);
  });

  it("returns empty array when no approved proposals exist", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.groupBy.mockResolvedValue([]);

    const result = await getProjectProposals(COMPANY_UUID, PROJECT_UUID);

    expect(result).toHaveLength(0);
  });
});


// ===== Idea Reuse across Proposals =====
describe("Idea reuse - submitProposal with proposal_created Idea", () => {
  it("should not error when Idea is already in proposal_created status", async () => {
    const { submitProposal } = await import("@/services/proposal.service");

    const now = new Date();
    const proposal = {
      uuid: "proposal-reuse",
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      status: "draft",
      inputType: "idea",
      inputUuids: ["idea-already-used"],
      documentDrafts: [
        { uuid: "doc-1", type: "prd", title: "PRD", content: "This is a comprehensive PRD document that describes the feature requirements in detail for the Idea reuse feature across multiple proposals." },
        { uuid: "doc-2", type: "tech_design", title: "Tech Design", content: "This is a comprehensive tech design document that describes the implementation approach for the Idea reuse feature across multiple proposals." },
      ],
      taskDrafts: [{
        uuid: "task-1", title: "Task", description: "desc", storyPoints: 1, priority: "medium",
        acceptanceCriteria: null, acceptanceCriteriaItems: [{ description: "AC1" }], dependsOnDraftUuids: [],
      }],
      project: { uuid: PROJECT_UUID, name: "Test" },
      description: "Test proposal for Idea reuse scenario",
      createdByUuid: ACTOR_UUID,
      createdByType: "agent",
      reviewedByUuid: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    // E5 check: ideas must have resolved elaboration
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "idea-already-used", title: "Test Idea", elaborationStatus: "resolved" },
    ]);

    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);
    mockPrisma.proposal.update.mockResolvedValue({ ...proposal, status: "pending" });

    const result = await submitProposal("proposal-reuse", COMPANY_UUID);

    expect(result.status).toBe("pending");
    // Idea status is no longer changed on proposal submit — derived status handles lifecycle
    expect(mockPrisma.idea.updateMany).not.toHaveBeenCalled();
  });
});

describe("Idea reuse - approveProposal with completed Idea", () => {
  it("should not auto-complete ideas on approval (derived status handles lifecycle)", async () => {
    const { approveProposal } = await import("@/services/proposal.service");

    const now = new Date();
    const proposal = {
      uuid: "proposal-reuse-2",
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      status: "pending",
      inputType: "idea",
      inputUuids: ["idea-completed"],
      documentDrafts: [{ uuid: "doc-1", type: "prd", title: "PRD", content: "content" }],
      taskDrafts: [],
      project: { uuid: PROJECT_UUID, name: "Test" },
      createdByUuid: ACTOR_UUID,
      createdByType: "agent",
      reviewedByUuid: null,
      reviewNote: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    mockPrisma.proposal.findFirst.mockResolvedValue(proposal);

    mockPrisma.$transaction.mockImplementation(async (callback) => {
      const txMock = {
        proposal: { update: vi.fn().mockResolvedValue({
          ...proposal, status: "approved",
          reviewedByUuid: "reviewer-uuid", reviewNote: "Approved", reviewedAt: now,
          project: { uuid: PROJECT_UUID, name: "Test" },
        }) },
        document: { createManyAndReturn: vi.fn().mockResolvedValue([{ uuid: "doc-uuid", title: "PRD" }]) },
        task: { createManyAndReturn: vi.fn() },
        taskDependency: { createMany: vi.fn() },
        acceptanceCriterion: { createMany: vi.fn() },
      };
      return callback(txMock);
    });

    await approveProposal("proposal-reuse-2", COMPANY_UUID, "reviewer-uuid", "Approved");

    // Ideas should NOT be auto-completed — derived status computed from task progress
    expect(mockPrisma.idea.updateMany).not.toHaveBeenCalled();
  });
});
