import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const {
  mockPrisma,
  mockEventBus,
  mockCreateActivity,
  mockFormatAssigneeComplete,
  mockFormatCreatedBy,
} = vi.hoisted(() => ({
  mockCreateActivity: vi.fn().mockResolvedValue(undefined),
  mockPrisma: {
    idea: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    project: { findFirst: vi.fn() },
    proposal: { findMany: vi.fn(), updateMany: vi.fn() },
    document: { findMany: vi.fn(), updateMany: vi.fn() },
    task: { findMany: vi.fn(), updateMany: vi.fn() },
    activity: { updateMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
  mockEventBus: { emitChange: vi.fn() },
  mockFormatAssigneeComplete: vi.fn().mockResolvedValue(null),
  mockFormatCreatedBy: vi
    .fn()
    .mockResolvedValue({ type: "user", uuid: "creator-uuid", name: "Creator" }),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: mockFormatAssigneeComplete,
  formatCreatedBy: mockFormatCreatedBy,
  formatReview: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/activity.service", () => ({
  createActivity: mockCreateActivity,
}));
// proposal.service is imported by idea.service for report aggregation in getIdea
vi.mock("@/services/proposal.service", () => ({
  getProposalsByIdeaUuid: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/document.service", () => ({
  listDocumentsByProposalUuids: vi.fn().mockResolvedValue([]),
}));

import {
  createIdea,
  setIdeaParent,
  getIdea,
  getIdeasWithDerivedStatus,
  getDescendantUuids,
  moveIdea,
  deleteIdea,
} from "@/services/idea.service";

const COMPANY = "company-1111";
const PROJECT = "project-2222";
const now = new Date("2026-06-11T10:00:00Z");

function ideaRow(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "idea-self",
    title: "Idea",
    content: null,
    attachments: null,
    status: "open",
    elaborationStatus: null,
    elaborationDepth: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    parentUuid: null,
    createdByUuid: "creator-uuid",
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createIdea with parentUuid", () => {
  it("creates a child when parent exists in the same project", async () => {
    // parent existence lookup
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ projectUuid: PROJECT });
    mockPrisma.idea.create.mockResolvedValueOnce(
      ideaRow({ uuid: "child", parentUuid: "parent" }),
    );

    const res = await createIdea({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      title: "Child",
      createdByUuid: "creator-uuid",
      parentUuid: "parent",
    });

    expect(res.parentUuid).toBe("parent");
    expect(mockPrisma.idea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentUuid: "parent" }),
      }),
    );
  });

  it("rejects a missing parent", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(null);
    await expect(
      createIdea({
        companyUuid: COMPANY,
        projectUuid: PROJECT,
        title: "Child",
        createdByUuid: "creator-uuid",
        parentUuid: "ghost",
      }),
    ).rejects.toThrow(/not found/i);
    expect(mockPrisma.idea.create).not.toHaveBeenCalled();
  });

  it("rejects a cross-project parent", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ projectUuid: "other-project" });
    await expect(
      createIdea({
        companyUuid: COMPANY,
        projectUuid: PROJECT,
        title: "Child",
        createdByUuid: "creator-uuid",
        parentUuid: "parent",
      }),
    ).rejects.toThrow(/same project/i);
    expect(mockPrisma.idea.create).not.toHaveBeenCalled();
  });
});

describe("setIdeaParent cycle prevention", () => {
  it("rejects self as parent", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce({
      uuid: "A",
      projectUuid: PROJECT,
    });
    await expect(setIdeaParent("A", "A", COMPANY)).rejects.toThrow(/own parent/i);
    expect(mockPrisma.idea.update).not.toHaveBeenCalled();
  });

  it("rejects a direct cycle (parent's parent is the idea)", async () => {
    // idea A; prospective parent B whose parentUuid is A -> cycle
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce({ uuid: "A", projectUuid: PROJECT }) // idea
      .mockResolvedValueOnce({ uuid: "B", projectUuid: PROJECT, parentUuid: "A" }); // parent B
    await expect(setIdeaParent("A", "B", COMPANY)).rejects.toThrow(/cycle/i);
    expect(mockPrisma.idea.update).not.toHaveBeenCalled();
  });

  it("rejects a transitive cycle (ancestor chain reaches the idea)", async () => {
    // idea A; parent C whose chain is C -> B -> A
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce({ uuid: "A", projectUuid: PROJECT }) // idea
      .mockResolvedValueOnce({ uuid: "C", projectUuid: PROJECT, parentUuid: "B" }) // parent C
      .mockResolvedValueOnce({ parentUuid: "A" }); // ancestor B -> A
    await expect(setIdeaParent("A", "C", COMPANY)).rejects.toThrow(/cycle/i);
    expect(mockPrisma.idea.update).not.toHaveBeenCalled();
  });

  it("rejects a cross-project parent", async () => {
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce({ uuid: "A", projectUuid: PROJECT })
      .mockResolvedValueOnce({ uuid: "B", projectUuid: "other", parentUuid: null });
    await expect(setIdeaParent("A", "B", COMPANY)).rejects.toThrow(/same project/i);
  });

  it("accepts a valid parent and emits a change event", async () => {
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce({ uuid: "A", projectUuid: PROJECT }) // idea
      .mockResolvedValueOnce({ uuid: "B", projectUuid: PROJECT, parentUuid: null }); // parent B, top-level
    mockPrisma.idea.update.mockResolvedValueOnce(
      ideaRow({ uuid: "A", parentUuid: "B", project: { uuid: PROJECT, name: "P" } }),
    );

    const res = await setIdeaParent("A", "B", COMPANY, { actorType: "user", actorUuid: "u1" });
    expect(res.parentUuid).toBe("B");
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { parentUuid: "B" } }),
    );
    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea", action: "updated" }),
    );
    // Records a reparented activity capturing from/to (idea A had no parent).
    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "idea",
        targetUuid: "A",
        action: "reparented",
        actorType: "user",
        actorUuid: "u1",
        value: { fromParentUuid: null, toParentUuid: "B" },
      }),
    );
  });

  it("does NOT record a reparented activity without actor context", async () => {
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce({ uuid: "A", projectUuid: PROJECT, parentUuid: null })
      .mockResolvedValueOnce({ uuid: "B", projectUuid: PROJECT, parentUuid: null });
    mockPrisma.idea.update.mockResolvedValueOnce(
      ideaRow({ uuid: "A", parentUuid: "B", project: { uuid: PROJECT, name: "P" } }),
    );

    await setIdeaParent("A", "B", COMPANY);

    expect(mockCreateActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "reparented" }),
    );
  });

  it("detaches when parentUuid is null", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ uuid: "A", projectUuid: PROJECT });
    mockPrisma.idea.update.mockResolvedValueOnce(
      ideaRow({ uuid: "A", parentUuid: null, project: { uuid: PROJECT, name: "P" } }),
    );

    const res = await setIdeaParent("A", null, COMPANY);
    expect(res.parentUuid).toBeNull();
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { parentUuid: null } }),
    );
  });
});

describe("getDescendantUuids", () => {
  it("returns the full transitive descendant set (direct + indirect)", async () => {
    // A -> [B, C]; B -> [D]; D -> []; C -> []
    mockPrisma.idea.findMany
      .mockResolvedValueOnce([{ uuid: "B" }, { uuid: "C" }]) // children of A
      .mockResolvedValueOnce([{ uuid: "D" }]) // children of B,C
      .mockResolvedValueOnce([]); // children of D
    const res = await getDescendantUuids("A", COMPANY);
    expect(res.sort()).toEqual(["B", "C", "D"]);
  });

  it("returns empty for a leaf idea", async () => {
    mockPrisma.idea.findMany.mockResolvedValueOnce([]);
    const res = await getDescendantUuids("leaf", COMPANY);
    expect(res).toEqual([]);
  });
});

describe("deleteIdea orphans children", () => {
  it("nulls children parentUuid (company-scoped) before deleting the parent", async () => {
    mockPrisma.idea.findUnique.mockResolvedValueOnce({ companyUuid: COMPANY });
    mockPrisma.idea.updateMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.idea.delete.mockResolvedValueOnce(
      ideaRow({ uuid: "parent", companyUuid: COMPANY, projectUuid: PROJECT }),
    );

    await deleteIdea("parent");

    // Orphan updateMany is scoped by both companyUuid and parentUuid.
    expect(mockPrisma.idea.updateMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, parentUuid: "parent" },
      data: { parentUuid: null },
    });
    // orphan-first ordering: updateMany invoked before delete
    const updateOrder = mockPrisma.idea.updateMany.mock.invocationCallOrder[0];
    const deleteOrder = mockPrisma.idea.delete.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(deleteOrder);
  });
});

describe("getIdeasWithDerivedStatus rollup", () => {
  it("attaches parentUuid and direct childCount via groupBy (no per-idea query)", async () => {
    mockPrisma.idea.findMany.mockResolvedValueOnce([
      { uuid: "root", title: "Root", status: "open", elaborationStatus: null, parentUuid: null, createdAt: now, updatedAt: now },
      { uuid: "child", title: "Child", status: "open", elaborationStatus: null, parentUuid: "root", createdAt: now, updatedAt: now },
    ]);
    mockPrisma.idea.groupBy.mockResolvedValueOnce([
      { parentUuid: "root", _count: { _all: 1 } },
    ]);
    mockPrisma.proposal.findMany.mockResolvedValueOnce([]); // no proposals

    const res = await getIdeasWithDerivedStatus(COMPANY, PROJECT);
    const root = res.find((i) => i.uuid === "root")!;
    const child = res.find((i) => i.uuid === "child")!;
    expect(root.childCount).toBe(1);
    expect(root.parentUuid).toBeNull();
    expect(child.childCount).toBe(0);
    expect(child.parentUuid).toBe("root");
    // groupBy used exactly once — the rollup is not a per-idea query
    expect(mockPrisma.idea.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe("getIdea lineage payload", () => {
  it("returns parent, children[], and descendantUuids", async () => {
    // getIdea's main findFirst returns the idea with parent + children included
    mockPrisma.idea.findFirst.mockResolvedValueOnce(
      ideaRow({
        uuid: "mid",
        parentUuid: "root",
        project: { uuid: PROJECT, name: "P" },
        parent: { uuid: "root", title: "Root", status: "open" },
        children: [
          { uuid: "leaf", title: "Leaf", status: "open", elaborationStatus: null },
        ],
      }),
    );
    // children present -> getIdeasWithDerivedStatus is invoked for the project
    mockPrisma.idea.findMany.mockResolvedValueOnce([
      { uuid: "leaf", title: "Leaf", status: "open", elaborationStatus: null, parentUuid: "mid", createdAt: now, updatedAt: now },
    ]);
    mockPrisma.idea.groupBy.mockResolvedValueOnce([]);
    mockPrisma.proposal.findMany.mockResolvedValueOnce([]);
    // getDescendantUuids walk: children of "mid" -> [leaf]; children of leaf -> []
    mockPrisma.idea.findMany
      .mockResolvedValueOnce([{ uuid: "leaf" }])
      .mockResolvedValueOnce([]);

    const res = await getIdea(COMPANY, "mid");
    expect(res?.parent).toEqual({ uuid: "root", title: "Root", status: "open" });
    expect(res?.children?.map((c) => c.uuid)).toEqual(["leaf"]);
    expect(res?.descendantUuids).toEqual(["leaf"]);
  });
});

describe("moveIdea lineage cascade", () => {
  const TARGET = "project-target";

  function wireTransaction() {
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  }

  it("moves the whole descendant subtree + detaches the root from a non-moving parent", async () => {
    // Root R has an outside parent P (not moving) and descendants C1, C2.
    const root = ideaRow({ uuid: "R", parentUuid: "P", project: { uuid: TARGET, name: "T" } });
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce(root) // validate
      .mockResolvedValueOnce(root); // post-move re-fetch
    mockPrisma.project.findFirst.mockResolvedValueOnce({ uuid: TARGET, name: "T" });
    // getDescendantUuids BFS: R -> [C1, C2]; then [] 
    mockPrisma.idea.findMany
      .mockResolvedValueOnce([{ uuid: "C1" }, { uuid: "C2" }])
      .mockResolvedValueOnce([]);
    mockPrisma.idea.updateMany.mockResolvedValueOnce({ count: 3 }); // R + C1 + C2
    mockPrisma.idea.update.mockResolvedValueOnce(ideaRow({ uuid: "R", parentUuid: null }));
    mockPrisma.proposal.findMany.mockResolvedValueOnce([]); // no proposals
    mockPrisma.activity.updateMany.mockResolvedValueOnce({ count: 0 });
    wireTransaction();

    const res = await moveIdea(COMPANY, "R", TARGET, "actor", "user");

    // ideas count = root + 2 descendants
    expect(res.moved.ideas).toBe(3);
    // subtree moved via updateMany over {R, C1, C2}
    expect(mockPrisma.idea.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyUuid: COMPANY, uuid: { in: ["R", "C1", "C2"] } },
        data: { projectUuid: TARGET },
      }),
    );
    // root detached from its non-moving parent P
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uuid: "R" }, data: { parentUuid: null } }),
    );
  });

  it("cascades a DESCENDANT's own proposal + its documents/tasks", async () => {
    // Root R (no parent) with one child C1. C1 owns proposal PC1 (inputUuids:[C1]),
    // which has document DC1 and task TC1. Moving R must carry C1's proposal/
    // doc/task too — this is the load-bearing "descendants' own work cascades" AC.
    const root = ideaRow({ uuid: "R", parentUuid: null, project: { uuid: TARGET, name: "T" } });
    mockPrisma.idea.findFirst.mockResolvedValueOnce(root).mockResolvedValueOnce(root);
    mockPrisma.project.findFirst.mockResolvedValueOnce({ uuid: TARGET, name: "T" });
    // getDescendantUuids BFS: R -> [C1]; then []
    mockPrisma.idea.findMany
      .mockResolvedValueOnce([{ uuid: "C1" }])
      .mockResolvedValueOnce([]);
    mockPrisma.idea.updateMany.mockResolvedValueOnce({ count: 2 }); // R + C1
    // The child's proposal is matched by the OR-of-array_contains over [R, C1].
    mockPrisma.proposal.findMany.mockResolvedValueOnce([{ uuid: "PC1" }]);
    mockPrisma.document.findMany.mockResolvedValueOnce([{ uuid: "DC1" }]);
    mockPrisma.task.findMany.mockResolvedValueOnce([{ uuid: "TC1" }]);
    mockPrisma.proposal.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.document.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.task.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.activity.updateMany.mockResolvedValueOnce({ count: 0 });
    wireTransaction();

    const res = await moveIdea(COMPANY, "R", TARGET, "actor", "user");

    // The proposal lookup ORs one array_contains clause per moved idea, so the
    // child C1's proposal is in scope — not just the root's.
    const proposalQuery = mockPrisma.proposal.findMany.mock.calls[0][0];
    expect(proposalQuery.where.OR).toEqual([
      { inputUuids: { array_contains: ["R"] } },
      { inputUuids: { array_contains: ["C1"] } },
    ]);
    // The child's proposal + its document + task all migrate to the target.
    expect(mockPrisma.proposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY, uuid: { in: ["PC1"] } }, data: { projectUuid: TARGET } }),
    );
    expect(mockPrisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY, proposalUuid: { in: ["PC1"] } }, data: { projectUuid: TARGET } }),
    );
    expect(mockPrisma.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY, proposalUuid: { in: ["PC1"] } }, data: { projectUuid: TARGET } }),
    );
    expect(res.moved).toEqual({ ideas: 2, proposals: 1, documents: 1, tasks: 1, activities: 0 });
  });

  it("does not detach when the moved root has no parent", async () => {
    const root = ideaRow({ uuid: "R", parentUuid: null, project: { uuid: TARGET, name: "T" } });
    mockPrisma.idea.findFirst.mockResolvedValueOnce(root).mockResolvedValueOnce(root);
    mockPrisma.project.findFirst.mockResolvedValueOnce({ uuid: TARGET, name: "T" });
    mockPrisma.idea.findMany.mockResolvedValueOnce([]); // no descendants
    mockPrisma.idea.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.proposal.findMany.mockResolvedValueOnce([]);
    mockPrisma.activity.updateMany.mockResolvedValueOnce({ count: 0 });
    wireTransaction();

    const res = await moveIdea(COMPANY, "R", TARGET, "actor", "user");

    expect(res.moved.ideas).toBe(1);
    // no detach update — root had no parent (only the subtree updateMany ran)
    expect(mockPrisma.idea.update).not.toHaveBeenCalled();
  });
});
