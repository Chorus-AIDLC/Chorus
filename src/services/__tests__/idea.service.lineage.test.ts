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
    referenceArtifact: { groupBy: vi.fn() },
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
  getIdeaWithDerivedStatus,
  getIdeasWithDerivedStatus,
  getDescendantUuids,
  moveIdea,
  deleteIdea,
  rollupThemeDerivedStatus,
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
    isContainer: false,
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
  // Reference-count batching (Thread B) in getIdeasWithDerivedStatus — default
  // to none so the lineage/rollup assertions are unaffected.
  mockPrisma.referenceArtifact.groupBy.mockResolvedValue([]);
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

  it("rolls a theme's derived status up from its direct children", async () => {
    // 1 theme + 3 children (1 done, 1 in_progress, 1 todo). The theme's own
    // status (open→todo here) must be overridden to in_progress, with childProgress 1/3.
    mockPrisma.idea.findMany.mockResolvedValueOnce([
      { uuid: "theme", title: "Theme", status: "elaborated", elaborationStatus: "resolved", parentUuid: null, isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "c1", title: "C1", status: "open", elaborationStatus: null, parentUuid: "theme", isContainer: false, createdAt: now, updatedAt: now },
      { uuid: "c2", title: "C2", status: "elaborating", elaborationStatus: "validating", parentUuid: "theme", isContainer: false, createdAt: now, updatedAt: now },
      { uuid: "c3", title: "C3", status: "elaborated", elaborationStatus: "resolved", parentUuid: "theme", isContainer: false, createdAt: now, updatedAt: now },
    ]);
    mockPrisma.idea.groupBy.mockResolvedValueOnce([{ parentUuid: "theme", _count: { _all: 3 } }]);
    // c3 has an approved proposal with all tasks done → child derived = done.
    mockPrisma.proposal.findMany.mockResolvedValueOnce([
      { uuid: "p3", status: "approved", inputUuids: ["c3"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { proposalUuid: "p3", status: "done" },
    ]);

    const res = await getIdeasWithDerivedStatus(COMPANY, PROJECT);
    const theme = res.find((i) => i.uuid === "theme")!;
    expect(theme.derivedStatus).toBe("in_progress"); // not stuck at "planning"/elaborated
    expect(theme.childProgress).toEqual({ done: 1, total: 3 });
  });

  it("rolls completed nested containers from leaves to roots with direct-child progress", async () => {
    mockPrisma.idea.findMany.mockResolvedValueOnce([
      { uuid: "root", title: "Root", status: "open", elaborationStatus: null, parentUuid: null, isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "nested", title: "Nested", status: "open", elaborationStatus: null, parentUuid: "root", isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "leaf", title: "Leaf", status: "elaborated", elaborationStatus: "resolved", parentUuid: "nested", isContainer: false, createdAt: now, updatedAt: now },
    ]);
    mockPrisma.idea.groupBy.mockResolvedValueOnce([
      { parentUuid: "root", _count: { _all: 1 } },
      { parentUuid: "nested", _count: { _all: 1 } },
    ]);
    mockPrisma.proposal.findMany.mockResolvedValueOnce([
      { uuid: "leaf-proposal", status: "approved", inputUuids: ["leaf"], createdAt: now },
    ]);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { proposalUuid: "leaf-proposal", status: "done" },
    ]);

    const result = await getIdeasWithDerivedStatus(COMPANY, PROJECT);

    expect(result.find((idea) => idea.uuid === "nested")).toMatchObject({
      derivedStatus: "done",
      childProgress: { done: 1, total: 1 },
    });
    expect(result.find((idea) => idea.uuid === "root")).toMatchObject({
      derivedStatus: "done",
      childProgress: { done: 1, total: 1 },
    });
    expect(mockPrisma.idea.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.idea.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.findMany).toHaveBeenCalledTimes(1);
  });

  it("propagates partial completion through deep containers independent of result order", async () => {
    const rows = [
      { uuid: "root", title: "Root", status: "open", elaborationStatus: null, parentUuid: null, isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "middle", title: "Middle", status: "open", elaborationStatus: null, parentUuid: "root", isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "inner", title: "Inner", status: "open", elaborationStatus: null, parentUuid: "middle", isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "done-leaf", title: "Done", status: "elaborated", elaborationStatus: "resolved", parentUuid: "inner", isContainer: false, createdAt: now, updatedAt: now },
      { uuid: "todo-leaf", title: "Todo", status: "open", elaborationStatus: null, parentUuid: "inner", isContainer: false, createdAt: now, updatedAt: now },
    ];
    const counts = [
      { parentUuid: "root", _count: { _all: 1 } },
      { parentUuid: "middle", _count: { _all: 1 } },
      { parentUuid: "inner", _count: { _all: 2 } },
    ];
    const proposals = [
      { uuid: "done-proposal", status: "approved", inputUuids: ["done-leaf"], createdAt: now },
    ];
    const tasks = [{ proposalUuid: "done-proposal", status: "done" }];
    mockPrisma.idea.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([...rows].reverse());
    mockPrisma.idea.groupBy
      .mockResolvedValueOnce(counts)
      .mockResolvedValueOnce([...counts].reverse());
    mockPrisma.proposal.findMany
      .mockResolvedValueOnce(proposals)
      .mockResolvedValueOnce(proposals);
    mockPrisma.task.findMany
      .mockResolvedValueOnce(tasks)
      .mockResolvedValueOnce(tasks);

    const first = await getIdeasWithDerivedStatus(COMPANY, PROJECT);
    const second = await getIdeasWithDerivedStatus(COMPANY, PROJECT);
    const snapshot = (items: typeof first) => Object.fromEntries(
      items.map((item) => [item.uuid, {
        status: item.derivedStatus,
        progress: item.childProgress,
      }]),
    );

    expect(snapshot(second)).toEqual(snapshot(first));
    expect(snapshot(first)).toMatchObject({
      inner: { status: "in_progress", progress: { done: 1, total: 2 } },
      middle: { status: "in_progress", progress: { done: 0, total: 1 } },
      root: { status: "in_progress", progress: { done: 0, total: 1 } },
    });
  });

  it("uses each cyclic SCC member's base status deterministically and tolerates missing parents", async () => {
    const rows = [
      { uuid: "cycle-a", title: "A", status: "open", elaborationStatus: null, parentUuid: "cycle-b", isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "cycle-b", title: "B", status: "elaborating", elaborationStatus: "validating", parentUuid: "cycle-a", isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "done-child", title: "Done", status: "elaborated", elaborationStatus: "resolved", parentUuid: "cycle-a", isContainer: false, createdAt: now, updatedAt: now },
      { uuid: "orphan", title: "Orphan", status: "elaborating", elaborationStatus: "validating", parentUuid: "missing-parent", isContainer: false, createdAt: now, updatedAt: now },
    ];
    const counts = [
      { parentUuid: "cycle-a", _count: { _all: 2 } },
      { parentUuid: "cycle-b", _count: { _all: 1 } },
      { parentUuid: "missing-parent", _count: { _all: 1 } },
    ];
    const proposals = [
      { uuid: "done-proposal", status: "approved", inputUuids: ["done-child"], createdAt: now },
    ];
    const tasks = [{ proposalUuid: "done-proposal", status: "done" }];
    mockPrisma.idea.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([rows[2], rows[1], rows[3], rows[0]]);
    mockPrisma.idea.groupBy
      .mockResolvedValueOnce(counts)
      .mockResolvedValueOnce([...counts].reverse());
    mockPrisma.proposal.findMany
      .mockResolvedValueOnce(proposals)
      .mockResolvedValueOnce(proposals);
    mockPrisma.task.findMany
      .mockResolvedValueOnce(tasks)
      .mockResolvedValueOnce(tasks);

    const first = await getIdeasWithDerivedStatus(COMPANY, PROJECT);
    const second = await getIdeasWithDerivedStatus(COMPANY, PROJECT);
    const snapshot = (items: typeof first) => Object.fromEntries(
      items.map((item) => [item.uuid, {
        status: item.derivedStatus,
        progress: item.childProgress,
      }]),
    );

    expect(snapshot(second)).toEqual(snapshot(first));
    expect(snapshot(first)).toMatchObject({
      "cycle-a": { status: "todo", progress: { done: 1, total: 2 } },
      "cycle-b": { status: "in_progress", progress: { done: 0, total: 1 } },
      orphan: { status: "in_progress", progress: null },
    });
  });
});

describe("rollupThemeDerivedStatus (pure)", () => {
  it("is done only when every child is done", () => {
    expect(rollupThemeDerivedStatus(["done", "done"])).toMatchObject({
      derivedStatus: "done",
      childProgress: { done: 2, total: 2 },
    });
  });
  it("is in_progress once any child has started", () => {
    expect(rollupThemeDerivedStatus(["todo", "in_progress", "todo"])).toMatchObject({
      derivedStatus: "in_progress",
      childProgress: { done: 0, total: 3 },
    });
  });
  it("is todo when all children are todo", () => {
    expect(rollupThemeDerivedStatus(["todo", "todo"])).toMatchObject({
      derivedStatus: "todo",
      childProgress: { done: 0, total: 2 },
    });
  });
  it("counts human_conduct_required as started (in_progress)", () => {
    expect(rollupThemeDerivedStatus(["human_conduct_required", "todo"])).toMatchObject({
      derivedStatus: "in_progress",
      childProgress: { done: 0, total: 2 },
    });
  });
  it("returns 0/0 progress for no children", () => {
    expect(rollupThemeDerivedStatus([])).toMatchObject({
      derivedStatus: "todo",
      childProgress: { done: 0, total: 0 },
    });
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

  it("returns the same nested rollup in the Idea detail response", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(
      ideaRow({
        uuid: "root",
        status: "open",
        isContainer: true,
        project: { uuid: PROJECT, name: "P" },
        parent: null,
        children: [
          { uuid: "nested", title: "Nested", status: "open", elaborationStatus: null },
        ],
      }),
    );
    const projectRows = [
      { uuid: "root", title: "Root", status: "open", elaborationStatus: null, parentUuid: null, isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "nested", title: "Nested", status: "open", elaborationStatus: null, parentUuid: "root", isContainer: true, createdAt: now, updatedAt: now },
      { uuid: "leaf", title: "Leaf", status: "elaborated", elaborationStatus: "resolved", parentUuid: "nested", isContainer: false, createdAt: now, updatedAt: now },
    ];
    mockPrisma.idea.findMany
      .mockResolvedValueOnce(projectRows)
      .mockResolvedValueOnce([{ uuid: "nested" }])
      .mockResolvedValueOnce([{ uuid: "leaf" }])
      .mockResolvedValueOnce([]);
    mockPrisma.idea.groupBy.mockResolvedValueOnce([
      { parentUuid: "root", _count: { _all: 1 } },
      { parentUuid: "nested", _count: { _all: 1 } },
    ]);
    mockPrisma.proposal.findMany
      .mockResolvedValueOnce([
        { uuid: "leaf-proposal", status: "approved", inputUuids: ["leaf"], createdAt: now },
      ])
      .mockResolvedValueOnce([]);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { proposalUuid: "leaf-proposal", status: "done" },
    ]);

    const detail = await getIdeaWithDerivedStatus(COMPANY, "root");

    expect(detail).toMatchObject({
      uuid: "root",
      derivedStatus: "done",
      childProgress: { done: 1, total: 1 },
      children: [
        { uuid: "nested", derivedStatus: "done" },
      ],
    });
  });
});

describe("getIdea isContainer flag", () => {
  it("returns isContainer=true when the idea is a container", async () => {
    // Leaf container idea (no children): findFirst -> idea, then the
    // getDescendantUuids walk finds no children, and getProposalsByIdeaUuid
    // (mocked to []) yields no reports.
    mockPrisma.idea.findFirst.mockResolvedValueOnce(
      ideaRow({
        uuid: "cont",
        isContainer: true,
        project: { uuid: PROJECT, name: "P" },
        parent: null,
        children: [],
      }),
    );
    mockPrisma.idea.findMany.mockResolvedValueOnce([]); // getDescendantUuids: no children

    const res = await getIdea(COMPANY, "cont");
    expect(res?.isContainer).toBe(true);
  });

  it("returns isContainer=false for a non-container idea", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(
      ideaRow({
        uuid: "plain",
        isContainer: false,
        project: { uuid: PROJECT, name: "P" },
        parent: null,
        children: [],
      }),
    );
    mockPrisma.idea.findMany.mockResolvedValueOnce([]); // getDescendantUuids: no children

    const res = await getIdea(COMPANY, "plain");
    expect(res?.isContainer).toBe(false);
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
