import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma, mockEventBus, mockFormatAssigneeComplete, mockFormatCreatedBy, mockCreateActivity } = vi.hoisted(() => ({
  mockPrisma: {
    idea: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
    proposal: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockEventBus: { emitChange: vi.fn() },
  mockFormatAssigneeComplete: vi.fn().mockResolvedValue(null),
  mockFormatCreatedBy: vi.fn().mockResolvedValue({ type: "user", uuid: "creator-uuid", name: "Creator" }),
  mockCreateActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: mockFormatAssigneeComplete,
  formatCreatedBy: mockFormatCreatedBy,
}));
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/activity.service", () => ({
  createActivity: mockCreateActivity,
}));

import { createIdea, claimIdea, releaseIdea, moveIdea, deleteIdea } from "@/services/idea.service";
import { AlreadyClaimedError } from "@/lib/errors";

// ===== Test Data =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const PROJECT_UUID = "project-2222-2222-2222-222222222222";
const IDEA_UUID = "idea-3333-3333-3333-333333333333";
const ACTOR_UUID = "actor-4444-4444-4444-444444444444";

const now = new Date("2026-01-15T10:00:00Z");

function makeIdeaRecord(overrides: Record<string, unknown> = {}) {
  return {
    uuid: IDEA_UUID,
    title: "Test Idea",
    content: "Some content",
    attachments: null,
    status: "open",
    elaborationStatus: null,
    elaborationDepth: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    createdByUuid: ACTOR_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: PROJECT_UUID,
    createdAt: now,
    updatedAt: now,
    project: { uuid: PROJECT_UUID, name: "Test Project" },
    ...overrides,
  };
}

// ===== Tests =====

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createIdea", () => {
  it("should create an idea with correct defaults and emit event", async () => {
    const created = makeIdeaRecord({ status: "open" });
    mockPrisma.idea.create.mockResolvedValue(created);

    const result = await createIdea({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "Test Idea",
      content: "Some content",
      createdByUuid: ACTOR_UUID,
    });

    expect(mockPrisma.idea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyUuid: COMPANY_UUID,
          projectUuid: PROJECT_UUID,
          title: "Test Idea",
          content: "Some content",
          status: "open",
          createdByUuid: ACTOR_UUID,
        }),
      })
    );

    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "idea",
        action: "created",
      })
    );

    expect(result.uuid).toBe(IDEA_UUID);
    expect(result.title).toBe("Test Idea");
    expect(result.status).toBe("open");
  });

  it("should handle null content", async () => {
    const created = makeIdeaRecord({ content: null });
    mockPrisma.idea.create.mockResolvedValue(created);

    const result = await createIdea({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "No Content Idea",
      content: null,
      createdByUuid: ACTOR_UUID,
    });

    expect(result.content).toBeNull();
  });
});

describe("claimIdea", () => {
  it("should transition open idea to elaborating and set assignee", async () => {
    const existing = makeIdeaRecord({ status: "open", assigneeUuid: null });
    const claimed = makeIdeaRecord({
      status: "elaborating",
      assigneeType: "agent",
      assigneeUuid: ACTOR_UUID,
      assignedAt: now,
      assignedByUuid: null,
    });

    mockPrisma.idea.findFirst.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(claimed);

    const result = await claimIdea({
      ideaUuid: IDEA_UUID,
      companyUuid: COMPANY_UUID,
      assigneeType: "agent",
      assigneeUuid: ACTOR_UUID,
    });

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: expect.objectContaining({
          status: "elaborating",
          assigneeType: "agent",
          assigneeUuid: ACTOR_UUID,
        }),
      })
    );

    expect(result.status).toBe("elaborating");
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should throw AlreadyClaimedError if idea is already claimed", async () => {
    const existing = makeIdeaRecord({
      status: "elaborating",
      assigneeUuid: "other-agent-uuid",
    });
    mockPrisma.idea.findFirst.mockResolvedValue(existing);

    await expect(
      claimIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow(AlreadyClaimedError);
  });

  it("should throw AlreadyClaimedError if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      claimIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow(AlreadyClaimedError);
  });

  it("should throw if idea is completed or closed", async () => {
    const existing = makeIdeaRecord({ status: "completed", assigneeUuid: null });
    mockPrisma.idea.findFirst.mockResolvedValue(existing);

    await expect(
      claimIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow("Cannot claim a completed or closed Idea");
  });
});

describe("releaseIdea", () => {
  it("should clear assignee and reset to open", async () => {
    const existing = makeIdeaRecord({
      status: "elaborating",
      assigneeType: "agent",
      assigneeUuid: ACTOR_UUID,
    });
    const released = makeIdeaRecord({
      status: "open",
      assigneeType: null,
      assigneeUuid: null,
      assignedAt: null,
      assignedByUuid: null,
      elaborationDepth: null,
      elaborationStatus: null,
    });

    mockPrisma.idea.findUnique.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(released);

    const result = await releaseIdea(IDEA_UUID);

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: expect.objectContaining({
          status: "open",
          assigneeType: null,
          assigneeUuid: null,
          assignedAt: null,
          assignedByUuid: null,
          elaborationDepth: null,
          elaborationStatus: null,
        }),
      })
    );

    expect(result.status).toBe("open");
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should throw if idea not found", async () => {
    mockPrisma.idea.findUnique.mockResolvedValue(null);

    await expect(releaseIdea(IDEA_UUID)).rejects.toThrow("Idea not found");
  });

  it("should throw if idea is closed", async () => {
    mockPrisma.idea.findUnique.mockResolvedValue(makeIdeaRecord({ status: "closed" }));

    await expect(releaseIdea(IDEA_UUID)).rejects.toThrow(
      "Cannot release a completed or closed Idea"
    );
  });
});

describe("moveIdea", () => {
  const TARGET_PROJECT_UUID = "target-5555-5555-5555-555555555555";

  it("should move idea to target project and log activity", async () => {
    const idea = makeIdeaRecord();
    const targetProject = { uuid: TARGET_PROJECT_UUID, name: "Target Project" };
    const movedIdea = makeIdeaRecord({
      projectUuid: TARGET_PROJECT_UUID,
      project: targetProject,
    });

    mockPrisma.idea.findFirst
      .mockResolvedValueOnce(idea)
      .mockResolvedValueOnce(movedIdea);
    mockPrisma.project.findFirst.mockResolvedValue(targetProject);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<void>) => {
      await fn(mockPrisma);
    });

    const result = await moveIdea(
      COMPANY_UUID,
      IDEA_UUID,
      TARGET_PROJECT_UUID,
      ACTOR_UUID,
      "user"
    );

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { projectUuid: TARGET_PROJECT_UUID },
      })
    );
    expect(mockPrisma.proposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { projectUuid: TARGET_PROJECT_UUID },
      })
    );

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "moved",
        value: expect.objectContaining({
          fromProjectUuid: PROJECT_UUID,
          toProjectUuid: TARGET_PROJECT_UUID,
        }),
      })
    );

    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);
    expect(result.uuid).toBe(IDEA_UUID);
  });

  it("should throw if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID)
    ).rejects.toThrow("Idea not found");
  });

  it("should throw if target project not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdeaRecord());
    mockPrisma.project.findFirst.mockResolvedValue(null);

    await expect(
      moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID)
    ).rejects.toThrow("Target project not found");
  });

  it("should throw if idea is already in target project", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdeaRecord());
    mockPrisma.project.findFirst.mockResolvedValue({
      uuid: PROJECT_UUID,
      name: "Same Project",
    });

    await expect(
      moveIdea(COMPANY_UUID, IDEA_UUID, PROJECT_UUID, ACTOR_UUID)
    ).rejects.toThrow("Idea is already in the target project");
  });
});

describe("deleteIdea", () => {
  it("should delete idea and emit event", async () => {
    const deleted = makeIdeaRecord();
    mockPrisma.idea.delete.mockResolvedValue(deleted);

    const result = await deleteIdea(IDEA_UUID);

    expect(mockPrisma.idea.delete).toHaveBeenCalledWith({
      where: { uuid: IDEA_UUID },
    });
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: COMPANY_UUID,
        entityType: "idea",
        action: "deleted",
      })
    );
    expect(result.uuid).toBe(IDEA_UUID);
  });
});
