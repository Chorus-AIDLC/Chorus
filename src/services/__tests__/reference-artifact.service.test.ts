import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  referenceArtifact: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  proposal: {
    findFirst: vi.fn(),
  },
  task: {
    findFirst: vi.fn(),
  },
  idea: {
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
  listReferences,
  createReference,
  createReferences,
  getReference,
  updateReference,
  deleteReference,
} from "@/services/reference-artifact.service";

// ===== Helpers =====
const now = new Date("2026-07-10T00:00:00Z");
const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const proposalUuid = "proposal-0000-0000-0000-000000000001";
const taskUuid = "task-0000-0000-0000-000000000001";
const ideaUuid = "idea-0000-0000-0000-000000000001";
const refUuid = "ref-0000-0000-0000-000000000001";
const createdByUuid = "agent-0000-0000-0000-000000000001";

function makeRefRecord(overrides: Record<string, unknown> = {}) {
  return {
    uuid: refUuid,
    targetType: "proposal",
    targetUuid: proposalUuid,
    type: "repo",
    url: "https://github.com/acme/repo",
    title: "Reference implementation",
    notes: "Look at the router module.",
    createdByType: "agent",
    createdByUuid,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const createdByInfo = { type: "agent", uuid: createdByUuid, name: "PM Agent" };

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatCreatedBy.mockResolvedValue(createdByInfo);
  mockActivityService.createActivity.mockResolvedValue(undefined);
  mockLogger.child.mockReturnValue(mockLogger);
  // Default target resolution: proposal exists, task exists, idea exists.
  mockPrisma.proposal.findFirst.mockResolvedValue({ projectUuid });
  mockPrisma.task.findFirst.mockResolvedValue({ projectUuid });
  mockPrisma.idea.findFirst.mockResolvedValue({ projectUuid });
  // Spy on global fetch to assert the service never performs a network fetch of
  // the url (q5: URL + notes capture only). Stub it so an accidental call
  // wouldn't hit the network either.
  fetchSpy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchSpy);
});

// ===== createReference =====
describe("createReference", () => {
  it("creates a reference, returns a UUID-only DTO (never the serial id), and stores notes verbatim", async () => {
    const record = makeRefRecord();
    // Simulate Prisma returning the selected columns (no `id`).
    mockPrisma.referenceArtifact.create.mockResolvedValue(record);

    const result = await createReference({
      companyUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      type: "repo",
      url: "https://github.com/acme/repo",
      title: "Reference implementation",
      notes: "Look at the router module.",
      createdByType: "agent",
      createdByUuid,
    });

    expect(result.uuid).toBe(refUuid);
    expect(result).not.toHaveProperty("id");
    expect(result.type).toBe("repo");
    expect(result.url).toBe("https://github.com/acme/repo");
    // notes round-trip unchanged (q5).
    expect(result.notes).toBe("Look at the router module.");
    expect(result.createdBy).toEqual(createdByInfo);
    expect(result.createdAt).toBe(now.toISOString());

    // Persisted verbatim — the service does not synthesize/mutate fields.
    expect(mockPrisma.referenceArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyUuid,
          targetType: "proposal",
          targetUuid: proposalUuid,
          type: "repo",
          url: "https://github.com/acme/repo",
          title: "Reference implementation",
          notes: "Look at the router module.",
          createdByType: "agent",
          createdByUuid,
        }),
      })
    );
    // The `select` must never request the serial id.
    const createArg = mockPrisma.referenceArtifact.create.mock.calls[0][0];
    expect(createArg.select).not.toHaveProperty("id");

    // q5: NO network fetch of the url at create time.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves a task target and emits best-effort activity + change events", async () => {
    mockPrisma.referenceArtifact.create.mockResolvedValue(
      makeRefRecord({ targetType: "task", targetUuid: taskUuid })
    );

    await createReference({
      companyUuid,
      targetType: "task",
      targetUuid: taskUuid,
      type: "docs",
      url: "https://docs.example.com/guide",
      title: "Official docs",
      createdByType: "user",
      createdByUuid,
    });

    expect(mockPrisma.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: taskUuid, companyUuid } })
    );
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
        entityType: "task",
        entityUuid: taskUuid,
        action: "updated",
      })
    );
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
        targetType: "task",
        targetUuid: taskUuid,
        action: "reference_added",
      })
    );
  });

  it("rejects an invalid type and does not persist", async () => {
    await expect(
      createReference({
        companyUuid,
        targetType: "proposal",
        targetUuid: proposalUuid,
        type: "tweet",
        url: "https://example.com",
        title: "Bad type",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/Invalid reference type/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) url (file://) and does not persist", async () => {
    await expect(
      createReference({
        companyUuid,
        targetType: "proposal",
        targetUuid: proposalUuid,
        type: "docs",
        url: "file:///etc/passwd",
        title: "Local file",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/Invalid reference url/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("rejects a blank url and does not persist", async () => {
    await expect(
      createReference({
        companyUuid,
        targetType: "proposal",
        targetUuid: proposalUuid,
        type: "docs",
        url: "   ",
        title: "Blank url",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/Invalid reference url/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("rejects an unsupported targetType and does not persist", async () => {
    await expect(
      createReference({
        companyUuid,
        targetType: "acceptance_criterion",
        targetUuid: "ac-0000",
        type: "docs",
        url: "https://example.com",
        title: "Bad target",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/Unsupported reference targetType/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("throws '… not found' when the proposal target does not resolve in the company", async () => {
    mockPrisma.proposal.findFirst.mockResolvedValue(null);

    await expect(
      createReference({
        companyUuid,
        targetType: "proposal",
        targetUuid: "missing-proposal",
        type: "docs",
        url: "https://example.com",
        title: "No such proposal",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/not found/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("throws '… not found' when the task target does not resolve in the company", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      createReference({
        companyUuid,
        targetType: "task",
        targetUuid: "missing-task",
        type: "docs",
        url: "https://example.com",
        title: "No such task",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/not found/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("resolves an idea target (V2) and emits best-effort activity + change events", async () => {
    mockPrisma.referenceArtifact.create.mockResolvedValue(
      makeRefRecord({ targetType: "idea", targetUuid: ideaUuid })
    );

    await createReference({
      companyUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      type: "paper_blog",
      url: "https://arxiv.org/abs/1234.5678",
      title: "Grounding research",
      createdByType: "agent",
      createdByUuid,
    });

    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: ideaUuid, companyUuid } })
    );
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
        entityType: "idea",
        entityUuid: ideaUuid,
        action: "updated",
      })
    );
    expect(mockActivityService.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid,
        projectUuid,
        targetType: "idea",
        targetUuid: ideaUuid,
        action: "reference_added",
      })
    );
  });

  it("throws '… not found' when the idea target does not resolve in the company", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      createReference({
        companyUuid,
        targetType: "idea",
        targetUuid: "missing-idea",
        type: "docs",
        url: "https://example.com",
        title: "No such idea",
        createdByType: "agent",
        createdByUuid,
      })
    ).rejects.toThrow(/not found/);

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("does not throw and still returns the DTO when eventBus.emitChange throws", async () => {
    mockPrisma.referenceArtifact.create.mockResolvedValue(makeRefRecord());
    mockEventBus.emitChange.mockImplementationOnce(() => {
      throw new Error("redis exploded");
    });

    const result = await createReference({
      companyUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      type: "repo",
      url: "https://github.com/acme/repo",
      title: "Reference implementation",
      notes: "Look at the router module.",
      createdByType: "agent",
      createdByUuid,
    });

    expect(result.uuid).toBe(refUuid);
    expect(mockLogger.warn).toHaveBeenCalled();
    // Activity still fires — a failure in the SSE step must not poison it.
    expect(mockActivityService.createActivity).toHaveBeenCalled();
  });

  it("does not throw when activityService.createActivity rejects", async () => {
    mockPrisma.referenceArtifact.create.mockResolvedValue(makeRefRecord());
    mockActivityService.createActivity.mockRejectedValueOnce(
      new Error("activity write failed")
    );

    const result = await createReference({
      companyUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      type: "repo",
      url: "https://github.com/acme/repo",
      title: "Reference implementation",
      createdByType: "agent",
      createdByUuid,
    });

    expect(result.uuid).toBe(refUuid);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("stores notes as null when omitted", async () => {
    mockPrisma.referenceArtifact.create.mockResolvedValue(
      makeRefRecord({ notes: null })
    );

    const result = await createReference({
      companyUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
      type: "repo",
      url: "https://github.com/acme/repo",
      title: "No notes",
      createdByType: "agent",
      createdByUuid,
    });

    expect(result.notes).toBeNull();
    expect(mockPrisma.referenceArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: null }),
      })
    );
  });
});

// ===== createReferences (batch, fail-soft — Thread C) =====
describe("createReferences", () => {
  it("creates every valid item and returns them under `created` with no errors", async () => {
    mockPrisma.referenceArtifact.create
      .mockResolvedValueOnce(makeRefRecord({ uuid: "ref-a", targetType: "idea", targetUuid: ideaUuid }))
      .mockResolvedValueOnce(makeRefRecord({ uuid: "ref-b", targetType: "idea", targetUuid: ideaUuid }));

    const result = await createReferences(
      companyUuid,
      "idea",
      ideaUuid,
      [
        { type: "docs", url: "https://docs.example.com/a", title: "A" },
        { type: "repo", url: "https://github.com/acme/repo", title: "B", notes: "note" },
      ],
      { type: "agent", uuid: createdByUuid }
    );

    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(2);
    expect(result.created[0].uuid).toBe("ref-a");
    expect(result.created[1].uuid).toBe("ref-b");
    expect(mockPrisma.referenceArtifact.create).toHaveBeenCalledTimes(2);
  });

  it("is fail-soft: a bad item (file:// url) is reported in `errors` and does NOT abort the valid ones", async () => {
    // First item is valid (created), second is invalid (rejected at validation
    // before any create call), third is valid (created). The bad item never
    // reaches prisma.create, so only two create calls happen.
    mockPrisma.referenceArtifact.create
      .mockResolvedValueOnce(makeRefRecord({ uuid: "ref-1", targetType: "task", targetUuid: taskUuid }))
      .mockResolvedValueOnce(makeRefRecord({ uuid: "ref-2", targetType: "task", targetUuid: taskUuid }));

    const result = await createReferences(
      companyUuid,
      "task",
      taskUuid,
      [
        { type: "docs", url: "https://docs.example.com/ok", title: "Good 1" },
        { type: "docs", url: "file:///etc/passwd", title: "Bad local file" },
        { type: "repo", url: "https://github.com/acme/repo", title: "Good 2" },
      ],
      { type: "agent", uuid: createdByUuid }
    );

    // Two valid refs created, one error captured.
    expect(result.created).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        index: 1,
        url: "file:///etc/passwd",
        title: "Bad local file",
      })
    );
    expect(result.errors[0].error).toMatch(/Invalid reference url/);
    expect(mockPrisma.referenceArtifact.create).toHaveBeenCalledTimes(2);
  });

  it("returns empty created + empty errors for a null/empty item list (no create calls)", async () => {
    const nullResult = await createReferences(companyUuid, "idea", ideaUuid, null, {
      type: "agent",
      uuid: createdByUuid,
    });
    expect(nullResult).toEqual({ created: [], errors: [] });

    const emptyResult = await createReferences(companyUuid, "idea", ideaUuid, [], {
      type: "agent",
      uuid: createdByUuid,
    });
    expect(emptyResult).toEqual({ created: [], errors: [] });

    expect(mockPrisma.referenceArtifact.create).not.toHaveBeenCalled();
  });

  it("captures a DB/target-resolution failure per item without throwing", async () => {
    // Target idea does not resolve → createReference throws "… not found",
    // which the batch helper must catch and report (never propagate).
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    const result = await createReferences(
      companyUuid,
      "idea",
      "missing-idea",
      [{ type: "docs", url: "https://docs.example.com/x", title: "X" }],
      { type: "user", uuid: createdByUuid }
    );

    expect(result.created).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/not found/);
  });
});

// ===== listReferences =====
describe("listReferences", () => {
  it("returns references for a target, oldest-first, scoped by companyUuid, without leaking id", async () => {
    mockPrisma.referenceArtifact.findMany.mockResolvedValue([makeRefRecord()]);

    const result = await listReferences({
      companyUuid,
      targetType: "proposal",
      targetUuid: proposalUuid,
    });

    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(refUuid);
    expect(result[0]).not.toHaveProperty("id");

    expect(mockPrisma.referenceArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid, targetType: "proposal", targetUuid: proposalUuid },
        orderBy: { createdAt: "asc" },
      })
    );
    const findArg = mockPrisma.referenceArtifact.findMany.mock.calls[0][0];
    expect(findArg.select).not.toHaveProperty("id");

    // Reads never fetch the url either (q5).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an empty array when there are no references", async () => {
    mockPrisma.referenceArtifact.findMany.mockResolvedValue([]);

    const result = await listReferences({
      companyUuid,
      targetType: "task",
      targetUuid: taskUuid,
    });

    expect(result).toEqual([]);
  });
});

// ===== getReference =====
describe("getReference", () => {
  it("returns a company-scoped reference DTO", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue(makeRefRecord());

    const result = await getReference(companyUuid, refUuid);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(refUuid);
    expect(result).not.toHaveProperty("id");
    expect(mockPrisma.referenceArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: refUuid, companyUuid } })
    );
  });

  it("returns null when the reference is absent or cross-tenant", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue(null);

    const result = await getReference(companyUuid, "nonexistent");
    expect(result).toBeNull();
  });
});

// ===== updateReference =====
describe("updateReference", () => {
  it("updates title and notes for an existing reference", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue({ uuid: refUuid });
    mockPrisma.referenceArtifact.update.mockResolvedValue(
      makeRefRecord({ title: "Updated", notes: "New notes" })
    );

    const result = await updateReference(companyUuid, refUuid, {
      title: "Updated",
      notes: "New notes",
    });

    expect(result.title).toBe("Updated");
    expect(result.notes).toBe("New notes");
    // Existence is checked company-scoped before the update.
    expect(mockPrisma.referenceArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: refUuid, companyUuid } })
    );
  });

  it("re-validates type when present", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue({ uuid: refUuid });

    await expect(
      updateReference(companyUuid, refUuid, { type: "bogus" })
    ).rejects.toThrow(/Invalid reference type/);

    expect(mockPrisma.referenceArtifact.update).not.toHaveBeenCalled();
  });

  it("re-validates url when present", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue({ uuid: refUuid });

    await expect(
      updateReference(companyUuid, refUuid, { url: "ftp://nope" })
    ).rejects.toThrow(/Invalid reference url/);

    expect(mockPrisma.referenceArtifact.update).not.toHaveBeenCalled();
  });

  it("throws '… not found' when the uuid is absent or cross-tenant", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue(null);

    await expect(
      updateReference(companyUuid, "nonexistent", { title: "X" })
    ).rejects.toThrow(/not found/);

    expect(mockPrisma.referenceArtifact.update).not.toHaveBeenCalled();
  });

  it("only writes the provided fields (partial update)", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue({ uuid: refUuid });
    mockPrisma.referenceArtifact.update.mockResolvedValue(makeRefRecord());

    await updateReference(companyUuid, refUuid, { notes: "only notes" });

    const callData = mockPrisma.referenceArtifact.update.mock.calls[0][0].data;
    expect(callData.notes).toBe("only notes");
    expect(callData.title).toBeUndefined();
    expect(callData.type).toBeUndefined();
    expect(callData.url).toBeUndefined();
  });
});

// ===== deleteReference =====
describe("deleteReference", () => {
  it("deletes an existing company-scoped reference", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue({ uuid: refUuid });
    mockPrisma.referenceArtifact.delete.mockResolvedValue(makeRefRecord());

    await deleteReference(companyUuid, refUuid);

    expect(mockPrisma.referenceArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: refUuid, companyUuid } })
    );
    expect(mockPrisma.referenceArtifact.delete).toHaveBeenCalledWith({
      where: { uuid: refUuid },
    });
  });

  it("throws '… not found' when the uuid is absent or cross-tenant", async () => {
    mockPrisma.referenceArtifact.findFirst.mockResolvedValue(null);

    await expect(deleteReference(companyUuid, "nonexistent")).rejects.toThrow(
      /not found/
    );

    expect(mockPrisma.referenceArtifact.delete).not.toHaveBeenCalled();
  });
});
