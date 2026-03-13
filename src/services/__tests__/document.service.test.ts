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
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockFormatCreatedBy = vi.fn();
vi.mock("@/lib/uuid-resolver", () => ({
  formatCreatedBy: (...args: unknown[]) => mockFormatCreatedBy(...args),
}));

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
