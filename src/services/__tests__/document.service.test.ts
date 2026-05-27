import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  document: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  proposal: {
    findFirst: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockFormatCreatedBy = vi.fn();
vi.mock("@/lib/uuid-resolver", () => ({
  formatCreatedBy: (...args: unknown[]) => mockFormatCreatedBy(...args),
}));

// ===== Event bus mock =====
const mockEventBus = vi.hoisted(() => ({
  emitChange: vi.fn(),
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

// ===== Activity service mock =====
const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
}));
vi.mock("@/services/activity.service", () => mockActivityService);

// ===== Logger mock — capture warn calls so error-path tests can assert =====
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@/lib/logger", () => {
  mockLogger.child.mockReturnValue(mockLogger);
  return { default: mockLogger };
});

import {
  createDocument,
  getDocument,
  updateDocument,
  deleteDocument,
  listDocuments,
  createDocumentFromProposal,
} from "@/services/document.service";

// ===== Helpers =====
const now = new Date("2026-03-13T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const docUuid = "doc-0000-0000-0000-000000000001";
const createdByUuid = "agent-0000-0000-0000-000000000001";

function makeDocRecord(overrides: Record<string, unknown> = {}) {
  return {
    uuid: docUuid,
    type: "prd",
    title: "Test Document",
    content: "# Test",
    version: 1,
    proposalUuid: null,
    createdByUuid,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const createdByInfo = { type: "agent", uuid: createdByUuid, name: "PM Agent" };

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatCreatedBy.mockResolvedValue(createdByInfo);
  // Default: proposal not found — non-report tests don't care, report tests
  // override per-case.
  mockPrisma.proposal.findFirst.mockResolvedValue(null);
  mockActivityService.createActivity.mockResolvedValue(undefined);
  mockLogger.child.mockReturnValue(mockLogger);
});

// ===== createDocument =====
describe("createDocument", () => {
  it("should create document with version 1 and return formatted response", async () => {
    const record = makeDocRecord();
    mockPrisma.document.create.mockResolvedValue(record);

    const result = await createDocument({
      companyUuid,
      projectUuid,
      type: "prd",
      title: "Test Document",
      content: "# Test",
      createdByUuid,
    });

    expect(result.uuid).toBe(docUuid);
    expect(result.version).toBe(1);
    expect(result.content).toBe("# Test");
    expect(result.createdBy).toEqual(createdByInfo);
    expect(result.createdAt).toBe(now.toISOString());
    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 1 }),
      })
    );
  });

  it("should pass proposalUuid when provided", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000001";
    mockPrisma.document.create.mockResolvedValue(makeDocRecord({ proposalUuid }));

    const result = await createDocument({
      companyUuid,
      projectUuid,
      type: "prd",
      title: "From Proposal",
      createdByUuid,
      proposalUuid,
    });

    expect(result.proposalUuid).toBe(proposalUuid);
  });

  // Coverage for add-idea-completion-report spec idea-completion-report:
  // "A report is created with the correct type label" + "Server preserves
  // report content byte-faithfully". `Document.type` is a free-form string,
  // so the report subtype rides the existing createDocument code path.
  it("should round-trip type='report' byte-faithfully (add-idea-completion-report)", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000099";
    const reportTitle = "Idea X — completion report";
    const reportContent =
      "## Summary\nShipped feature X — T1+T2.\n\n" +
      "## Decisions\n- Chose A over B because reasons.\n\n" +
      "## Follow-ups\nNone.\n";

    mockPrisma.document.create.mockResolvedValue(
      makeDocRecord({
        type: "report",
        title: reportTitle,
        content: reportContent,
        proposalUuid,
      })
    );

    const result = await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      proposalUuid,
      createdByUuid,
    });

    // Output preserves type, title, content, proposalUuid, version=1.
    expect(result.type).toBe("report");
    expect(result.title).toBe(reportTitle);
    expect(result.content).toBe(reportContent);
    expect(result.proposalUuid).toBe(proposalUuid);
    expect(result.version).toBe(1);

    // Prisma was asked to persist exactly what we sent — no synthesis,
    // augmentation, or mutation by the service layer.
    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "report",
          title: reportTitle,
          content: reportContent,
          proposalUuid,
          version: 1,
        }),
      })
    );
  });

  it("should accept multiple report Documents per Proposal (no service-side dedupe)", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000100";

    // First write.
    mockPrisma.document.create.mockResolvedValueOnce(
      makeDocRecord({
        uuid: "doc-report-1",
        type: "report",
        title: "First report",
        content: "## Summary\nA",
        proposalUuid,
      })
    );
    const first = await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: "First report",
      content: "## Summary\nA",
      proposalUuid,
      createdByUuid,
    });
    expect(first.type).toBe("report");

    // Second write to the same Proposal — service must not error.
    mockPrisma.document.create.mockResolvedValueOnce(
      makeDocRecord({
        uuid: "doc-report-2",
        type: "report",
        title: "Second report",
        content: "## Summary\nB",
        proposalUuid,
      })
    );
    const second = await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: "Second report",
      content: "## Summary\nB",
      proposalUuid,
      createdByUuid,
    });
    expect(second.type).toBe("report");
    expect(second.uuid).toBe("doc-report-2");

    expect(mockPrisma.document.create).toHaveBeenCalledTimes(2);
  });
});

// ===== createDocument: report-realtime side effects =====
// Covers spec `report-realtime` Requirements 1–3:
//   (1) document/created event always fires for type=report
//   (2) idea/updated event fires only when proposal.inputType === "idea"
//   (3) report_created Activity fires only when an idea is resolved
// All three are best-effort; errors must NOT roll back the document insert.
describe("createDocument — report-realtime side effects", () => {
  const proposalUuid = "proposal-0000-0000-0000-000000000200";
  const ideaUuid = "idea-0000-0000-0000-000000000001";
  const reportTitle = "Idea X — completion report";
  const reportContent = "## Summary\nShipped.\n\n## Decisions\n-\n\n## Follow-ups\nNone.\n";

  function arrangeReportCreate(overrides: Record<string, unknown> = {}) {
    mockPrisma.document.create.mockResolvedValue(
      makeDocRecord({
        type: "report",
        title: reportTitle,
        content: reportContent,
        proposalUuid,
        ...overrides,
      }),
    );
  }

  it("emits document/created and idea/updated events + records report_created Activity for an idea-rooted proposal", async () => {
    arrangeReportCreate();
    mockPrisma.proposal.findFirst.mockResolvedValue({
      inputType: "idea",
      inputUuids: [ideaUuid],
    });

    const result = await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      proposalUuid,
      createdByUuid,
    });

    expect(result.uuid).toBe(docUuid);

    // Document-level event — Requirement 1.
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid,
      projectUuid,
      entityType: "document",
      entityUuid: docUuid,
      action: "created",
      actorUuid: createdByUuid,
    });

    // Idea-level event — Requirement 2.
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid,
      projectUuid,
      entityType: "idea",
      entityUuid: ideaUuid,
      action: "updated",
      actorUuid: createdByUuid,
    });
    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);

    // Activity — Requirement 3.
    expect(mockActivityService.createActivity).toHaveBeenCalledWith({
      companyUuid,
      projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType: createdByInfo.type, // resolved via formatCreatedBy
      actorUuid: createdByUuid,
      action: "report_created",
      value: {
        reportUuid: docUuid,
        proposalUuid,
        reportTitle,
      },
    });
  });

  it("does not emit any side-effect events for non-report Documents", async () => {
    mockPrisma.document.create.mockResolvedValue(makeDocRecord({ type: "tech_design" }));

    await createDocument({
      companyUuid,
      projectUuid,
      type: "tech_design",
      title: "Tech Design",
      content: "...",
      proposalUuid,
      createdByUuid,
    });

    expect(mockEventBus.emitChange).not.toHaveBeenCalled();
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
    // Proposal lookup is gated on type === "report", so we shouldn't even hit
    // the DB for non-report documents.
    expect(mockPrisma.proposal.findFirst).not.toHaveBeenCalled();
  });

  it("emits only document/created when the parent Proposal is not idea-rooted", async () => {
    arrangeReportCreate();
    mockPrisma.proposal.findFirst.mockResolvedValue({
      inputType: "document",
      inputUuids: ["doc-0000-0000-0000-000000000999"],
    });

    await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      proposalUuid,
      createdByUuid,
    });

    // document/created fires — Requirement 1 still holds.
    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "document", action: "created" }),
    );
    // No idea event, no Activity.
    expect(mockEventBus.emitChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea" }),
    );
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it("skips idea-scoped side effects when proposalUuid is missing on a report-typed Document", async () => {
    // Edge case: a report-typed Document without a proposalUuid (not produced
    // by chorus_create_report — that tool requires a proposal — but createDocument
    // accepts proposalUuid as optional, so the branch must be safe).
    mockPrisma.document.create.mockResolvedValue(
      makeDocRecord({ type: "report", proposalUuid: null }),
    );

    await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      createdByUuid,
    });

    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "document", action: "created" }),
    );
    expect(mockPrisma.proposal.findFirst).not.toHaveBeenCalled();
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });

  it("does not throw and still returns the new document when eventBus.emitChange throws", async () => {
    arrangeReportCreate();
    mockPrisma.proposal.findFirst.mockResolvedValue({
      inputType: "idea",
      inputUuids: [ideaUuid],
    });
    mockEventBus.emitChange.mockImplementationOnce(() => {
      throw new Error("redis exploded");
    });

    const result = await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      proposalUuid,
      createdByUuid,
    });

    // Document insert is the source of truth — it MUST succeed end-to-end.
    expect(result.uuid).toBe(docUuid);
    expect(result.type).toBe("report");

    // Failure was logged at warn level (Requirement 1 failure semantics).
    expect(mockLogger.warn).toHaveBeenCalled();

    // The second emitChange (idea/updated) and the Activity still fire — a
    // failure in step 1 must not poison subsequent best-effort steps.
    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report_created" }),
    );
  });

  it("does not throw when activityService.createActivity rejects, and still emits SSE events", async () => {
    arrangeReportCreate();
    mockPrisma.proposal.findFirst.mockResolvedValue({
      inputType: "idea",
      inputUuids: [ideaUuid],
    });
    mockActivityService.createActivity.mockRejectedValueOnce(new Error("activity write failed"));

    const result = await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      proposalUuid,
      createdByUuid,
    });

    expect(result.uuid).toBe(docUuid);
    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("tolerates a malformed proposal.inputUuids (non-array) and emits only document/created", async () => {
    arrangeReportCreate();
    mockPrisma.proposal.findFirst.mockResolvedValue({
      inputType: "idea",
      inputUuids: null, // legacy / drift — must not throw
    });

    await createDocument({
      companyUuid,
      projectUuid,
      type: "report",
      title: reportTitle,
      content: reportContent,
      proposalUuid,
      createdByUuid,
    });

    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "document" }),
    );
    expect(mockActivityService.createActivity).not.toHaveBeenCalled();
  });
});

// ===== getDocument =====
describe("getDocument", () => {
  it("should return document with project info and content", async () => {
    const record = makeDocRecord({
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.findFirst.mockResolvedValue(record);

    const result = await getDocument(companyUuid, docUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(docUuid);
    expect(result!.project).toEqual({ uuid: projectUuid, name: "Test Project" });
    expect(result!.content).toBe("# Test");
  });

  it("should return null when document not found", async () => {
    mockPrisma.document.findFirst.mockResolvedValue(null);

    const result = await getDocument(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== updateDocument =====
describe("updateDocument", () => {
  it("should update title and content", async () => {
    const updated = makeDocRecord({
      title: "Updated Title",
      content: "# Updated",
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    const result = await updateDocument(docUuid, {
      title: "Updated Title",
      content: "# Updated",
    });

    expect(result.title).toBe("Updated Title");
    expect(result.content).toBe("# Updated");
  });

  it("should increment version when requested", async () => {
    const updated = makeDocRecord({
      version: 2,
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    const result = await updateDocument(docUuid, {
      content: "# V2",
      incrementVersion: true,
    });

    expect(result.version).toBe(2);
    expect(mockPrisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: { increment: 1 },
        }),
      })
    );
  });

  it("should not include version increment when not requested", async () => {
    const updated = makeDocRecord({
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    await updateDocument(docUuid, { title: "New Title" });

    const callData = mockPrisma.document.update.mock.calls[0][0].data;
    expect(callData.version).toBeUndefined();
  });

  it("should update only title when only title is provided", async () => {
    const updated = makeDocRecord({
      title: "Only Title Changed",
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    await updateDocument(docUuid, { title: "Only Title Changed" });

    const callData = mockPrisma.document.update.mock.calls[0][0].data;
    expect(callData.title).toBe("Only Title Changed");
    expect(callData.content).toBeUndefined();
    expect(callData.version).toBeUndefined();
  });

  it("should update only content when only content is provided", async () => {
    const updated = makeDocRecord({
      content: "# Only content changed",
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    await updateDocument(docUuid, { content: "# Only content changed" });

    const callData = mockPrisma.document.update.mock.calls[0][0].data;
    expect(callData.content).toBe("# Only content changed");
    expect(callData.title).toBeUndefined();
  });

  it("should allow setting content to null", async () => {
    const updated = makeDocRecord({
      content: null,
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    await updateDocument(docUuid, { content: null });

    const callData = mockPrisma.document.update.mock.calls[0][0].data;
    expect(callData.content).toBeNull();
  });

  it("should update all fields when all are provided", async () => {
    const updated = makeDocRecord({
      title: "All Updated",
      content: "# All fields",
      version: 2,
      project: { uuid: projectUuid, name: "Test Project" },
    });
    mockPrisma.document.update.mockResolvedValue(updated);

    await updateDocument(docUuid, {
      title: "All Updated",
      content: "# All fields",
      incrementVersion: true,
    });

    const callData = mockPrisma.document.update.mock.calls[0][0].data;
    expect(callData.title).toBe("All Updated");
    expect(callData.content).toBe("# All fields");
    expect(callData.version).toEqual({ increment: 1 });
  });

  it("should throw error if document not found during update", async () => {
    const notFoundError = new Error("Record to update not found.");
    (notFoundError as any).code = "P2025";
    mockPrisma.document.update.mockRejectedValue(notFoundError);

    await expect(
      updateDocument("nonexistent-uuid", { title: "New Title" })
    ).rejects.toThrow("Record to update not found.");
  });
});

// ===== deleteDocument =====
describe("deleteDocument", () => {
  it("should delete document by uuid", async () => {
    mockPrisma.document.delete.mockResolvedValue(makeDocRecord());

    await deleteDocument(docUuid);

    expect(mockPrisma.document.delete).toHaveBeenCalledWith({
      where: { uuid: docUuid },
    });
  });

  it("should throw error if document not found during delete", async () => {
    const notFoundError = new Error("Record to delete does not exist.");
    (notFoundError as any).code = "P2025";
    mockPrisma.document.delete.mockRejectedValue(notFoundError);

    await expect(deleteDocument("nonexistent-uuid")).rejects.toThrow(
      "Record to delete does not exist."
    );
  });
});

// ===== listDocuments =====
describe("listDocuments", () => {
  it("should return paginated documents without content", async () => {
    const record = makeDocRecord();
    mockPrisma.document.findMany.mockResolvedValue([record]);
    mockPrisma.document.count.mockResolvedValue(1);

    const result = await listDocuments({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.documents[0].uuid).toBe(docUuid);
    // formatDocumentResponse with includeContent=false should not include content
    expect(result.documents[0].content).toBeUndefined();
  });

  it("should filter by type when provided", async () => {
    mockPrisma.document.findMany.mockResolvedValue([]);
    mockPrisma.document.count.mockResolvedValue(0);

    await listDocuments({
      companyUuid,
      projectUuid,
      skip: 0,
      take: 20,
      type: "architecture",
    });

    expect(mockPrisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: "architecture" }),
      })
    );
  });
});

// ===== createDocumentFromProposal =====
describe("createDocumentFromProposal", () => {
  it("should create document linked to proposal with version 1", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000001";
    const record = makeDocRecord({ proposalUuid });
    mockPrisma.document.create.mockResolvedValue(record);

    const result = await createDocumentFromProposal(
      companyUuid,
      projectUuid,
      proposalUuid,
      createdByUuid,
      { type: "prd", title: "Test Document", content: "# Test" }
    );

    expect(result.proposalUuid).toBe(proposalUuid);
    expect(result.version).toBe(1);
    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposalUuid,
          version: 1,
        }),
      })
    );
  });

  it("should use 'prd' as default type when empty string provided", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000001";
    mockPrisma.document.create.mockResolvedValue(makeDocRecord({ proposalUuid }));

    await createDocumentFromProposal(
      companyUuid,
      projectUuid,
      proposalUuid,
      createdByUuid,
      { type: "", title: "Untitled" }
    );

    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "prd" }),
      })
    );
  });

  it("should handle missing content and set it to null", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000001";
    const record = makeDocRecord({ proposalUuid, content: null });
    mockPrisma.document.create.mockResolvedValue(record);

    const result = await createDocumentFromProposal(
      companyUuid,
      projectUuid,
      proposalUuid,
      createdByUuid,
      { type: "architecture", title: "No Content Doc" }
    );

    expect(result.content).toBeNull();
    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: null,
        }),
      })
    );
  });

  it("should include content when provided in doc parameter", async () => {
    const proposalUuid = "proposal-0000-0000-0000-000000000001";
    const content = "# Architecture\n\nDetailed architecture...";
    const record = makeDocRecord({ proposalUuid, content });
    mockPrisma.document.create.mockResolvedValue(record);

    const result = await createDocumentFromProposal(
      companyUuid,
      projectUuid,
      proposalUuid,
      createdByUuid,
      { type: "architecture", title: "Arch Doc", content }
    );

    expect(result.content).toBe(content);
  });
});
