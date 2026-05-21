import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma, mockEventBus, mockFormatAssigneeComplete, mockFormatCreatedBy, mockCreateActivity, mockParseMentions, mockCreateMentions } = vi.hoisted(() => ({
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
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    activity: {
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockEventBus: { emitChange: vi.fn() },
  mockFormatAssigneeComplete: vi.fn().mockResolvedValue(null),
  mockFormatCreatedBy: vi.fn().mockResolvedValue({ type: "user", uuid: "creator-uuid", name: "Creator" }),
  mockCreateActivity: vi.fn().mockResolvedValue(undefined),
  mockParseMentions: vi.fn().mockReturnValue([]),
  mockCreateMentions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: mockFormatAssigneeComplete,
  formatCreatedBy: mockFormatCreatedBy,
}));
vi.mock("@/services/mention.service", () => ({
  parseMentions: mockParseMentions,
  createMentions: mockCreateMentions,
}));
vi.mock("@/services/activity.service", () => ({
  createActivity: mockCreateActivity,
}));

import { createIdea, claimIdea, assignIdea, releaseIdea, moveIdea, moveIdeaPreview, deleteIdea, updateIdea } from "@/services/idea.service";
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

  it("should throw if idea is elaborated", async () => {
    const existing = makeIdeaRecord({ status: "elaborated", assigneeUuid: null });
    mockPrisma.idea.findFirst.mockResolvedValue(existing);

    await expect(
      claimIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow("Cannot claim an elaborated Idea");
  });

  it("should throw if idea has legacy completed status (normalizes to elaborated)", async () => {
    const existing = makeIdeaRecord({ status: "completed", assigneeUuid: null });
    mockPrisma.idea.findFirst.mockResolvedValue(existing);

    await expect(
      claimIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow("Cannot claim an elaborated Idea");
  });
});

describe("assignIdea", () => {
  it("should transition open idea to elaborating and set assignee", async () => {
    const existing = makeIdeaRecord({ status: "open", assigneeUuid: null });
    const assigned = makeIdeaRecord({
      status: "elaborating",
      assigneeType: "user",
      assigneeUuid: ACTOR_UUID,
      assignedAt: now,
      assignedByUuid: "admin-uuid",
    });

    mockPrisma.idea.findFirst.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(assigned);

    const result = await assignIdea({
      ideaUuid: IDEA_UUID,
      companyUuid: COMPANY_UUID,
      assigneeType: "user",
      assigneeUuid: ACTOR_UUID,
      assignedByUuid: "admin-uuid",
    });

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: expect.objectContaining({
          status: "elaborating",
          assigneeType: "user",
          assigneeUuid: ACTOR_UUID,
        }),
      })
    );

    expect(result.status).toBe("elaborating");
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should keep current status when reassigning non-open idea", async () => {
    const existing = makeIdeaRecord({
      status: "elaborating",
      assigneeType: "agent",
      assigneeUuid: "old-agent-uuid",
    });
    const assigned = makeIdeaRecord({
      status: "elaborating",
      assigneeType: "user",
      assigneeUuid: ACTOR_UUID,
      assignedAt: now,
      assignedByUuid: "admin-uuid",
    });

    mockPrisma.idea.findFirst.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(assigned);

    const result = await assignIdea({
      ideaUuid: IDEA_UUID,
      companyUuid: COMPANY_UUID,
      assigneeType: "user",
      assigneeUuid: ACTOR_UUID,
      assignedByUuid: "admin-uuid",
    });

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "elaborating", // Should keep existing status
        }),
      })
    );

    expect(result.status).toBe("elaborating");
  });

  it("should throw if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      assignIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "user",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow("Idea not found");
  });

  it("should throw if idea is elaborated", async () => {
    const existing = makeIdeaRecord({ status: "elaborated" });
    mockPrisma.idea.findFirst.mockResolvedValue(existing);

    await expect(
      assignIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "user",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow("Cannot assign an elaborated Idea");
  });

  it("should throw if idea has legacy completed status (normalizes to elaborated)", async () => {
    const existing = makeIdeaRecord({ status: "completed" });
    mockPrisma.idea.findFirst.mockResolvedValue(existing);

    await expect(
      assignIdea({
        ideaUuid: IDEA_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "user",
        assigneeUuid: ACTOR_UUID,
      })
    ).rejects.toThrow("Cannot assign an elaborated Idea");
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

  it("should throw if idea is elaborated", async () => {
    mockPrisma.idea.findUnique.mockResolvedValue(makeIdeaRecord({ status: "elaborated" }));

    await expect(releaseIdea(IDEA_UUID)).rejects.toThrow(
      "Cannot release an elaborated Idea"
    );
  });

  it("should throw if idea has legacy closed status (normalizes to elaborated)", async () => {
    mockPrisma.idea.findUnique.mockResolvedValue(makeIdeaRecord({ status: "closed" }));

    await expect(releaseIdea(IDEA_UUID)).rejects.toThrow(
      "Cannot release an elaborated Idea"
    );
  });
});

describe("moveIdea", () => {
  const TARGET_PROJECT_UUID = "target-5555-5555-5555-555555555555";
  const PROPOSAL_A = "proposal-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const PROPOSAL_B = "proposal-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const DOC_UUID = "doc-1111-1111-1111-111111111111";
  const TASK_UUID = "task-2222-2222-2222-222222222222";

  // Reusable scaffolding: `findMany` is consulted three times inside the
  // transaction (proposals → documents → tasks). We seed defaults that the
  // happy-path tests can override.
  function setupCascadeMocks(opts: {
    proposals?: Array<{ uuid: string }>;
    documents?: Array<{ uuid: string }>;
    tasks?: Array<{ uuid: string }>;
    proposalCount?: number;
    documentCount?: number;
    taskCount?: number;
    activityCount?: number;
  }) {
    const proposals = opts.proposals ?? [];
    const documents = opts.documents ?? [];
    const tasks = opts.tasks ?? [];

    mockPrisma.proposal.findMany.mockResolvedValue(proposals);
    mockPrisma.document.findMany.mockResolvedValue(documents);
    mockPrisma.task.findMany.mockResolvedValue(tasks);

    mockPrisma.proposal.updateMany.mockResolvedValue({ count: opts.proposalCount ?? proposals.length });
    mockPrisma.document.updateMany.mockResolvedValue({ count: opts.documentCount ?? documents.length });
    mockPrisma.task.updateMany.mockResolvedValue({ count: opts.taskCount ?? tasks.length });
    mockPrisma.activity.updateMany.mockResolvedValue({ count: opts.activityCount ?? 0 });
  }

  it("cascades Idea + approved Proposal + Document + Task + Activity in one transaction", async () => {
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

    setupCascadeMocks({
      proposals: [{ uuid: PROPOSAL_A }],
      documents: [{ uuid: DOC_UUID }],
      tasks: [{ uuid: TASK_UUID }],
      activityCount: 5,
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return await fn(mockPrisma);
    });

    const result = await moveIdea(
      COMPANY_UUID,
      IDEA_UUID,
      TARGET_PROJECT_UUID,
      ACTOR_UUID,
      "user"
    );

    // Idea row updated.
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { projectUuid: TARGET_PROJECT_UUID },
      })
    );

    // Proposal updateMany — uuid IN clause (PK index walk, not JSON rescan).
    // companyUuid scoped, no status filter (D1 in design).
    const proposalUpdate = mockPrisma.proposal.updateMany.mock.calls[0][0];
    expect(proposalUpdate.where).toEqual({
      companyUuid: COMPANY_UUID,
      uuid: { in: [PROPOSAL_A] },
    });
    expect(proposalUpdate.where.status).toBeUndefined();
    expect(proposalUpdate.where.inputUuids).toBeUndefined();
    expect(proposalUpdate.data).toEqual({ projectUuid: TARGET_PROJECT_UUID });

    // Document updateMany via proposalUuid.
    expect(mockPrisma.document.updateMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY_UUID, proposalUuid: { in: [PROPOSAL_A] } },
      data: { projectUuid: TARGET_PROJECT_UUID },
    });

    // Task updateMany via proposalUuid (no assignee fields touched).
    const taskUpdate = mockPrisma.task.updateMany.mock.calls[0][0];
    expect(taskUpdate.where).toEqual({ companyUuid: COMPANY_UUID, proposalUuid: { in: [PROPOSAL_A] } });
    expect(taskUpdate.data).toEqual({ projectUuid: TARGET_PROJECT_UUID });
    expect(taskUpdate.data).not.toHaveProperty("assigneeUuid");
    expect(taskUpdate.data).not.toHaveProperty("assigneeType");

    // Activity OR-clause across idea/proposal/task/document.
    const activityUpdate = mockPrisma.activity.updateMany.mock.calls[0][0];
    expect(activityUpdate.where.companyUuid).toBe(COMPANY_UUID);
    expect(activityUpdate.where.OR).toEqual([
      { targetType: "idea", targetUuid: IDEA_UUID },
      { targetType: "proposal", targetUuid: { in: [PROPOSAL_A] } },
      { targetType: "task", targetUuid: { in: [TASK_UUID] } },
      { targetType: "document", targetUuid: { in: [DOC_UUID] } },
    ]);
    expect(activityUpdate.data).toEqual({ projectUuid: TARGET_PROJECT_UUID });

    // Activity record for the move event itself.
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "moved",
        value: expect.objectContaining({
          fromProjectUuid: PROJECT_UUID,
          toProjectUuid: TARGET_PROJECT_UUID,
          moved: { proposals: 1, documents: 1, tasks: 1, activities: 5 },
        }),
      })
    );

    // Both project streams are pinged.
    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);

    // Return shape: existing IdeaResponse + the new `moved` field with the
    // exact `count` returned from each updateMany.
    expect(result.uuid).toBe(IDEA_UUID);
    expect(result.moved).toEqual({ proposals: 1, documents: 1, tasks: 1, activities: 5 });
  });

  it("returns counts equal to each updateMany().count", async () => {
    const idea = makeIdeaRecord();
    const targetProject = { uuid: TARGET_PROJECT_UUID, name: "Target Project" };
    const movedIdea = makeIdeaRecord({ projectUuid: TARGET_PROJECT_UUID, project: targetProject });

    mockPrisma.idea.findFirst.mockResolvedValueOnce(idea).mockResolvedValueOnce(movedIdea);
    mockPrisma.project.findFirst.mockResolvedValue(targetProject);

    // Multi-proposal scenario covering the spec's "any non-draft status follows
    // the idea" scenario — we pass the full set through findMany and the
    // updateMany count is whatever Prisma reports.
    setupCascadeMocks({
      proposals: [{ uuid: PROPOSAL_A }, { uuid: PROPOSAL_B }],
      documents: [{ uuid: DOC_UUID }],
      tasks: [{ uuid: "t1" }, { uuid: "t2" }, { uuid: "t3" }],
      proposalCount: 2,
      documentCount: 1,
      taskCount: 3,
      activityCount: 7,
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return await fn(mockPrisma);
    });

    const result = await moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID);
    expect(result.moved).toEqual({ proposals: 2, documents: 1, tasks: 3, activities: 7 });
  });

  it("scopes every updateMany by companyUuid (cross-company isolation)", async () => {
    const idea = makeIdeaRecord();
    const targetProject = { uuid: TARGET_PROJECT_UUID, name: "Target Project" };
    const movedIdea = makeIdeaRecord({ projectUuid: TARGET_PROJECT_UUID, project: targetProject });

    mockPrisma.idea.findFirst.mockResolvedValueOnce(idea).mockResolvedValueOnce(movedIdea);
    mockPrisma.project.findFirst.mockResolvedValue(targetProject);
    setupCascadeMocks({ proposals: [{ uuid: PROPOSAL_A }], documents: [], tasks: [] });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return await fn(mockPrisma);
    });

    await moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID);

    // Every findMany / updateMany inside the transaction must carry companyUuid.
    for (const call of mockPrisma.proposal.findMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
    for (const call of mockPrisma.proposal.updateMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
    for (const call of mockPrisma.document.findMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
    for (const call of mockPrisma.document.updateMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
    for (const call of mockPrisma.task.findMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
    for (const call of mockPrisma.task.updateMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
    for (const call of mockPrisma.activity.updateMany.mock.calls) {
      expect(call[0].where.companyUuid).toBe(COMPANY_UUID);
    }
  });

  it("does NOT touch Comment / TaskDependency / AcceptanceCriterion / AgentSession / SessionTaskCheckin / Notification", async () => {
    const idea = makeIdeaRecord();
    const targetProject = { uuid: TARGET_PROJECT_UUID, name: "Target Project" };
    const movedIdea = makeIdeaRecord({ projectUuid: TARGET_PROJECT_UUID, project: targetProject });

    mockPrisma.idea.findFirst.mockResolvedValueOnce(idea).mockResolvedValueOnce(movedIdea);
    mockPrisma.project.findFirst.mockResolvedValue(targetProject);
    setupCascadeMocks({
      proposals: [{ uuid: PROPOSAL_A }],
      documents: [{ uuid: DOC_UUID }],
      tasks: [{ uuid: TASK_UUID }],
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return await fn(mockPrisma);
    });

    await moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID);

    // The mockPrisma object only declares idea/project/proposal/document/task/activity.
    // If moveIdea ever reached for a forbidden table, TypeScript would have
    // failed at compile time (we'd see prisma.<table> is undefined at runtime
    // anyway). Belt-and-suspenders: confirm none of those properties were
    // accessed by inspecting the mock object directly.
    expect("comment" in mockPrisma).toBe(false);
    expect("taskDependency" in mockPrisma).toBe(false);
    expect("acceptanceCriterion" in mockPrisma).toBe(false);
    expect("agentSession" in mockPrisma).toBe(false);
    expect("sessionTaskCheckin" in mockPrisma).toBe(false);
    expect("notification" in mockPrisma).toBe(false);

    // And the Task update payload must not include assignee fields.
    for (const call of mockPrisma.task.updateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty("assigneeUuid");
      expect(call[0].data).not.toHaveProperty("assigneeType");
      expect(call[0].data).not.toHaveProperty("assignedAt");
    }
  });

  it("short-circuits document/task work when no proposals are linked", async () => {
    // An idea with no proposals (e.g. moved while still in elaborating). The
    // transaction should update Idea + Activity only — document/task findMany
    // and proposal/document/task updateMany must all be skipped, since they'd
    // each return count 0 anyway and just burn round-trips.
    const idea = makeIdeaRecord();
    const targetProject = { uuid: TARGET_PROJECT_UUID, name: "Target Project" };
    const movedIdea = makeIdeaRecord({ projectUuid: TARGET_PROJECT_UUID, project: targetProject });

    mockPrisma.idea.findFirst.mockResolvedValueOnce(idea).mockResolvedValueOnce(movedIdea);
    mockPrisma.project.findFirst.mockResolvedValue(targetProject);
    mockPrisma.proposal.findMany.mockResolvedValueOnce([]); // no proposals
    mockPrisma.activity.updateMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return await fn(mockPrisma);
    });

    const result = await moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID);

    expect(result.moved).toEqual({ proposals: 0, documents: 0, tasks: 0, activities: 2 });
    // Idea + activity ran; everything in between is short-circuited.
    expect(mockPrisma.idea.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.activity.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.proposal.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.document.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
  });

  it("throws if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID)
    ).rejects.toThrow("Idea not found");
  });

  it("throws if target project not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdeaRecord());
    mockPrisma.project.findFirst.mockResolvedValue(null);

    await expect(
      moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID)
    ).rejects.toThrow("Target project not found");
  });

  it("throws if idea is already in target project", async () => {
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

describe("moveIdeaPreview", () => {
  const TARGET_PROJECT_UUID = "target-5555-5555-5555-555555555555";
  const PROPOSAL_A = "proposal-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const DOC_UUID = "doc-1111-1111-1111-111111111111";
  const TASK_UUID = "task-2222-2222-2222-222222222222";

  it("returns counts matching what a subsequent moveIdea would produce", async () => {
    // Same fixture, run once through preview and once through the real move,
    // assert identical `moved` shape.
    const ideaForPreview = makeIdeaRecord();
    const idea = makeIdeaRecord();
    const targetProject = { uuid: TARGET_PROJECT_UUID, name: "Target Project" };
    const movedIdea = makeIdeaRecord({ projectUuid: TARGET_PROJECT_UUID, project: targetProject });

    // ----- preview path -----
    mockPrisma.idea.findFirst.mockResolvedValueOnce(ideaForPreview);
    mockPrisma.project.findFirst.mockResolvedValueOnce(targetProject);
    mockPrisma.proposal.findMany.mockResolvedValueOnce([{ uuid: PROPOSAL_A }]);
    mockPrisma.document.findMany.mockResolvedValueOnce([{ uuid: DOC_UUID }]);
    mockPrisma.task.findMany.mockResolvedValueOnce([{ uuid: TASK_UUID }]);
    mockPrisma.proposal.count.mockResolvedValueOnce(1);
    mockPrisma.document.count.mockResolvedValueOnce(1);
    mockPrisma.task.count.mockResolvedValueOnce(1);
    mockPrisma.activity.count.mockResolvedValueOnce(4);

    const preview = await moveIdeaPreview(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID);
    expect(preview.moved).toEqual({ proposals: 1, documents: 1, tasks: 1, activities: 4 });

    // ----- real move (same fixture, no concurrent writes) -----
    mockPrisma.idea.findFirst.mockResolvedValueOnce(idea).mockResolvedValueOnce(movedIdea);
    mockPrisma.project.findFirst.mockResolvedValueOnce(targetProject);
    mockPrisma.proposal.findMany.mockResolvedValueOnce([{ uuid: PROPOSAL_A }]);
    mockPrisma.document.findMany.mockResolvedValueOnce([{ uuid: DOC_UUID }]);
    mockPrisma.task.findMany.mockResolvedValueOnce([{ uuid: TASK_UUID }]);
    mockPrisma.proposal.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.document.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.task.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.activity.updateMany.mockResolvedValueOnce({ count: 4 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return await fn(mockPrisma);
    });

    const real = await moveIdea(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID, ACTOR_UUID);

    expect(real.moved).toEqual(preview.moved);
  });

  it("does NOT write — only findMany + activity.count are called", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(makeIdeaRecord());
    mockPrisma.project.findFirst.mockResolvedValueOnce({ uuid: TARGET_PROJECT_UUID, name: "Target" });
    // No proposals → short-circuits document/task findMany; only proposal.findMany
    // and activity.count run for an idea that hasn't been proposalized yet.
    mockPrisma.proposal.findMany.mockResolvedValueOnce([]);
    mockPrisma.activity.count.mockResolvedValueOnce(0);

    await moveIdeaPreview(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID);

    // No mutations on any cascaded table.
    expect(mockPrisma.idea.update).not.toHaveBeenCalled();
    expect(mockPrisma.proposal.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.document.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.updateMany).not.toHaveBeenCalled();
    // No transaction at all (the spec is explicit: preview is non-mutating).
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // No move-activity record either.
    expect(mockCreateActivity).not.toHaveBeenCalled();
    // Short-circuit: empty proposal set means document/task findMany must NOT
    // run, and proposal.count is no longer called at all (count = uuids.length).
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.proposal.count).not.toHaveBeenCalled();
    expect(mockPrisma.document.count).not.toHaveBeenCalled();
    expect(mockPrisma.task.count).not.toHaveBeenCalled();
    // Multi-tenancy invariant: the calls that did run carry companyUuid.
    expect(mockPrisma.proposal.findMany.mock.calls[0][0].where.companyUuid).toBe(COMPANY_UUID);
    expect(mockPrisma.activity.count.mock.calls[0][0].where.companyUuid).toBe(COMPANY_UUID);
  });

  it("throws if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(null);
    await expect(
      moveIdeaPreview(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID)
    ).rejects.toThrow("Idea not found");
  });

  it("throws if target project not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(makeIdeaRecord());
    mockPrisma.project.findFirst.mockResolvedValueOnce(null);
    await expect(
      moveIdeaPreview(COMPANY_UUID, IDEA_UUID, TARGET_PROJECT_UUID)
    ).rejects.toThrow("Target project not found");
  });

  it("throws if idea is already in target project", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(makeIdeaRecord());
    mockPrisma.project.findFirst.mockResolvedValueOnce({ uuid: PROJECT_UUID, name: "Same" });
    await expect(
      moveIdeaPreview(COMPANY_UUID, IDEA_UUID, PROJECT_UUID)
    ).rejects.toThrow("Idea is already in the target project");
  });
});

describe("updateIdea", () => {
  it("should update idea title and emit change event", async () => {
    const updated = makeIdeaRecord({ title: "Updated Title" });
    mockPrisma.idea.update.mockResolvedValue(updated);

    const result = await updateIdea(IDEA_UUID, COMPANY_UUID, { title: "Updated Title" });

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { title: "Updated Title" },
      })
    );
    expect(result.title).toBe("Updated Title");
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should update idea status", async () => {
    const updated = makeIdeaRecord({ status: "elaborated" });
    mockPrisma.idea.update.mockResolvedValue(updated);

    const result = await updateIdea(IDEA_UUID, COMPANY_UUID, { status: "elaborated" });

    expect(result.status).toBe("elaborated");
  });

  it("should process new mentions when content updated with actor context", async () => {
    const oldContent = "Old content with @user[old-user-uuid]";
    const newContent = "New content with @user[new-user-uuid] and @agent[agent-uuid]";

    const existing = makeIdeaRecord({ content: oldContent });
    const updated = makeIdeaRecord({ content: newContent });

    mockPrisma.idea.findUnique.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(updated);

    mockParseMentions
      .mockReturnValueOnce([{ type: "user", uuid: "old-user-uuid", displayName: "Old User" }])
      .mockReturnValueOnce([
        { type: "user", uuid: "new-user-uuid", displayName: "New User" },
        { type: "agent", uuid: "agent-uuid", displayName: "Test Agent" },
      ]);

    await updateIdea(
      IDEA_UUID,
      COMPANY_UUID,
      { content: newContent },
      { actorType: "user", actorUuid: ACTOR_UUID }
    );

    // Should parse old and new content
    expect(mockParseMentions).toHaveBeenCalledWith(oldContent);
    expect(mockParseMentions).toHaveBeenCalledWith(newContent);

    // Should create mentions for the new content
    expect(mockCreateMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: COMPANY_UUID,
        sourceType: "idea",
        sourceUuid: IDEA_UUID,
        content: newContent,
        actorType: "user",
        actorUuid: ACTOR_UUID,
      })
    );

    // Should create activity for each new mention (2 new mentions)
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mentioned",
        value: expect.objectContaining({
          mentionedType: "user",
          mentionedUuid: "new-user-uuid",
          mentionedName: "New User",
        }),
      })
    );
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mentioned",
        value: expect.objectContaining({
          mentionedType: "agent",
          mentionedUuid: "agent-uuid",
          mentionedName: "Test Agent",
        }),
      })
    );
  });

  it("should skip mention processing when no actor context provided", async () => {
    const updated = makeIdeaRecord({ content: "Content with @user[user-uuid]" });
    mockPrisma.idea.update.mockResolvedValue(updated);

    await updateIdea(IDEA_UUID, COMPANY_UUID, {
      content: "Content with @user[user-uuid]",
    });

    expect(mockPrisma.idea.findUnique).not.toHaveBeenCalled();
    expect(mockParseMentions).not.toHaveBeenCalled();
    expect(mockCreateMentions).not.toHaveBeenCalled();
  });

  it("should skip mention processing when content is undefined", async () => {
    const updated = makeIdeaRecord();
    mockPrisma.idea.update.mockResolvedValue(updated);

    await updateIdea(
      IDEA_UUID,
      COMPANY_UUID,
      { title: "Updated Title" },
      { actorType: "user", actorUuid: ACTOR_UUID }
    );

    expect(mockPrisma.idea.findUnique).not.toHaveBeenCalled();
    expect(mockCreateMentions).not.toHaveBeenCalled();
  });

  it("should skip mention processing when content is null", async () => {
    const existing = makeIdeaRecord({ content: "Old content" });
    const updated = makeIdeaRecord({ content: null });

    mockPrisma.idea.findUnique.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(updated);

    await updateIdea(
      IDEA_UUID,
      COMPANY_UUID,
      { content: null },
      { actorType: "user", actorUuid: ACTOR_UUID }
    );

    // findUnique is called to fetch old content, but then processing is skipped because new content is null/falsy
    expect(mockPrisma.idea.findUnique).toHaveBeenCalled();
    expect(mockCreateMentions).not.toHaveBeenCalled();
  });

  it("should skip mention processing when content is empty string", async () => {
    const existing = makeIdeaRecord({ content: "Old content" });
    const updated = makeIdeaRecord({ content: "" });

    mockPrisma.idea.findUnique.mockResolvedValue(existing);
    mockPrisma.idea.update.mockResolvedValue(updated);

    await updateIdea(
      IDEA_UUID,
      COMPANY_UUID,
      { content: "" },
      { actorType: "user", actorUuid: ACTOR_UUID }
    );

    // findUnique is called, but processing is skipped because content is empty
    expect(mockPrisma.idea.findUnique).toHaveBeenCalled();
    expect(mockCreateMentions).not.toHaveBeenCalled();
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
