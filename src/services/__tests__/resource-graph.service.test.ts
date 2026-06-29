// src/services/__tests__/resource-graph.service.test.ts
// Unit tests for getProjectResourceGraph — the four-entity-type aggregation
// underlying the per-project "Resource Graph" view. Mocks Prisma directly
// (mirrors the pattern in task.service.test.ts) so this is a pure
// service-layer test with no DB.

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  idea: { findMany: vi.fn() },
  proposal: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  document: { findMany: vi.fn() },
  taskDependency: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { getProjectResourceGraph } from "@/services/resource-graph.service";

const COMPANY_UUID = "00000000-0000-0000-0000-00000000aaaa";
const PROJECT_UUID = "00000000-0000-0000-0000-00000000bbbb";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: everything empty unless a test overrides
  mockPrisma.idea.findMany.mockResolvedValue([]);
  mockPrisma.proposal.findMany.mockResolvedValue([]);
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.document.findMany.mockResolvedValue([]);
  mockPrisma.taskDependency.findMany.mockResolvedValue([]);
});

describe("getProjectResourceGraph — node types", () => {
  it("returns the four entity types as typed nodes (with title + uuid + type-specific fields)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "i1", title: "Idea 1", parentUuid: null },
      { uuid: "i2", title: "Idea 2 (child)", parentUuid: "i1" },
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "Proposal 1", inputType: "idea", inputUuids: ["i1"] },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "t1", title: "Task 1", proposalUuid: "p1" },
    ]);
    mockPrisma.document.findMany.mockResolvedValue([
      { uuid: "d1", title: "Doc 1", proposalUuid: "p1" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    // 2 ideas + 1 proposal + 1 task + 1 document = 5 nodes (one node per entity).
    expect(result.nodes).toHaveLength(5);
    const byUuid = Object.fromEntries(result.nodes.map((n) => [n.uuid, n]));
    expect(byUuid.i1).toMatchObject({ type: "idea", title: "Idea 1", parentIdeaUuid: null });
    expect(byUuid.i2).toMatchObject({ type: "idea", title: "Idea 2 (child)", parentIdeaUuid: "i1" });
    expect(byUuid.p1).toMatchObject({ type: "proposal", title: "Proposal 1", sourceIdeaUuids: ["i1"] });
    expect(byUuid.t1).toMatchObject({ type: "task", title: "Task 1", proposalUuid: "p1" });
    expect(byUuid.d1).toMatchObject({ type: "document", title: "Doc 1", proposalUuid: "p1" });
  });

  it("returns { nodes: [], edges: [] } for an empty project (not an error)", async () => {
    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);
    expect(result).toEqual({ nodes: [], edges: [] });
  });
});

describe("getProjectResourceGraph — edge kinds and direction", () => {
  it("emits a 'lineage' edge from parent Idea to child Idea (parentUuid -> uuid)", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "parent", title: "Parent", parentUuid: null },
      { uuid: "child", title: "Child", parentUuid: "parent" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    const lineageEdges = result.edges.filter((e) => e.kind === "lineage");
    expect(lineageEdges).toHaveLength(1);
    expect(lineageEdges[0]).toEqual({ from: "parent", to: "child", kind: "lineage" });
  });

  it("emits a 'derive' edge from Idea to Proposal when Proposal.inputType==='idea' and inputUuids includes a project-local idea", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "i1", title: "Idea", parentUuid: null },
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "Proposal", inputType: "idea", inputUuids: ["i1"] },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    const deriveEdges = result.edges.filter((e) => e.kind === "derive");
    expect(deriveEdges).toContainEqual({ from: "i1", to: "p1", kind: "derive" });
  });

  it("does NOT emit Idea→Proposal derive when Proposal.inputType is 'document'", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: "i1", title: "Idea", parentUuid: null },
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      // Even if inputUuids accidentally contained an idea UUID, inputType
      // gates the edge — a document-input proposal contributes no lineage.
      { uuid: "p1", title: "Doc-input proposal", inputType: "document", inputUuids: ["i1"] },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    expect(result.edges.filter((e) => e.kind === "derive")).toHaveLength(0);
    // Proposal still appears as a node (it belongs to the project), with no
    // sourceIdeaUuids since inputType !== "idea".
    const proposalNode = result.nodes.find((n) => n.uuid === "p1");
    expect(proposalNode).toMatchObject({ type: "proposal", sourceIdeaUuids: [] });
  });

  it("emits 'derive' edges from Proposal to Task and Proposal to Document (proposalUuid -> entity)", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "P", inputType: "idea", inputUuids: [] },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      // t1 is a root task within p1 (no TaskDependency rows below), so it
      // gets a direct proposal→task derive edge per the root-tasks-only rule.
      { uuid: "t1", title: "T", proposalUuid: "p1" },
    ]);
    mockPrisma.document.findMany.mockResolvedValue([
      { uuid: "d1", title: "D", proposalUuid: "p1" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    const deriveEdges = result.edges.filter((e) => e.kind === "derive");
    expect(deriveEdges).toContainEqual({ from: "p1", to: "t1", kind: "derive" });
    expect(deriveEdges).toContainEqual({ from: "p1", to: "d1", kind: "derive" });
  });

  it("ROOT-TASKS-ONLY: emits proposal→task derive ONLY for tasks with in-proposal indegree 0; non-root tasks are reached transitively via depends", async () => {
    // p1 has three tasks: tRoot (no prerequisite within p1) and tMid +
    // tLeaf forming a chain tRoot -> tMid -> tLeaf. The proposal must link
    // ONLY to tRoot. tMid and tLeaf must NOT have a direct proposal edge;
    // they are reachable transitively through `depends` edges.
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "P", inputType: "idea", inputUuids: [] },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "tRoot", title: "Root", proposalUuid: "p1" },
      { uuid: "tMid", title: "Mid", proposalUuid: "p1" },
      { uuid: "tLeaf", title: "Leaf", proposalUuid: "p1" },
    ]);
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: "tMid", dependsOnUuid: "tRoot" }, // tMid depends on tRoot
      { taskUuid: "tLeaf", dependsOnUuid: "tMid" }, // tLeaf depends on tMid
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    const proposalToTaskEdges = result.edges.filter(
      (e) => e.kind === "derive" && e.from === "p1" && ["tRoot", "tMid", "tLeaf"].includes(e.to)
    );
    // EXACTLY one proposal→task derive edge: p1 → tRoot.
    expect(proposalToTaskEdges).toEqual([{ from: "p1", to: "tRoot", kind: "derive" }]);
    // tMid and tLeaf are still reachable — via the depends chain.
    const dependsEdges = result.edges.filter((e) => e.kind === "depends");
    expect(dependsEdges).toContainEqual({ from: "tRoot", to: "tMid", kind: "depends" });
    expect(dependsEdges).toContainEqual({ from: "tMid", to: "tLeaf", kind: "depends" });
  });

  it("ROOT-TASKS-ONLY: a cross-proposal prerequisite does NOT block the proposal-edge (in-proposal indegree only)", async () => {
    // tDownstream belongs to p2 but depends on a task in p1. Its
    // *in-proposal* indegree (counting prerequisites that share p2) is 0,
    // so it MUST still get a direct p2→tDownstream derive edge. The
    // cross-proposal `depends` arrow is preserved separately.
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "P1", inputType: "idea", inputUuids: [] },
      { uuid: "p2", title: "P2", inputType: "idea", inputUuids: [] },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "tUpstream", title: "Up", proposalUuid: "p1" },
      { uuid: "tDownstream", title: "Down", proposalUuid: "p2" },
    ]);
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: "tDownstream", dependsOnUuid: "tUpstream" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    const proposalToTaskEdges = result.edges.filter(
      (e) => e.kind === "derive" && (e.from === "p1" || e.from === "p2")
    );
    // Both root-of-their-proposal: tUpstream (no prereq at all) and
    // tDownstream (no in-proposal prereq).
    expect(proposalToTaskEdges).toContainEqual({ from: "p1", to: "tUpstream", kind: "derive" });
    expect(proposalToTaskEdges).toContainEqual({ from: "p2", to: "tDownstream", kind: "derive" });
    expect(proposalToTaskEdges).toHaveLength(2);
    // Cross-proposal depends edge is preserved on its own merits.
    expect(result.edges).toContainEqual({
      from: "tUpstream",
      to: "tDownstream",
      kind: "depends",
    });
  });

  it("emits a 'depends' edge from dependsOn task to dependent task (upstream -> downstream)", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "tA", title: "A", proposalUuid: null },
      { uuid: "tB", title: "B", proposalUuid: null },
    ]);
    // Task B depends on task A — A must finish first. Graph edge must point
    // from A (upstream) to B (downstream) per the documented convention.
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: "tB", dependsOnUuid: "tA" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    const dependsEdges = result.edges.filter((e) => e.kind === "depends");
    expect(dependsEdges).toEqual([{ from: "tA", to: "tB", kind: "depends" }]);
  });

  it("drops a 'depends' edge whose dependsOn task lives outside the project (closed graph invariant)", async () => {
    // Only tB is project-local. tA lives in another project (not in the task
    // findMany result), so the edge would dangle — the service must drop it.
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "tB", title: "B", proposalUuid: null },
    ]);
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: "tB", dependsOnUuid: "tA-foreign" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    expect(result.edges.filter((e) => e.kind === "depends")).toHaveLength(0);
  });

  it("drops an Idea→Proposal derive edge whose input idea is not project-local", async () => {
    // Proposal claims to derive from idea-foreign, but that idea isn't in
    // this project's idea set; the edge must be dropped.
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", title: "P", inputType: "idea", inputUuids: ["i-foreign"] },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    expect(result.edges.filter((e) => e.kind === "derive")).toHaveLength(0);
    // sourceIdeaUuids on the node must also exclude the foreign UUID.
    expect(result.nodes.find((n) => n.uuid === "p1")?.sourceIdeaUuids).toEqual([]);
  });
});

describe("getProjectResourceGraph — orphans", () => {
  it("returns an entity with no relationships as a standalone node (no incident edges)", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      // Manual task (no proposalUuid) and no TaskDependency rows.
      { uuid: "lone", title: "Lone task", proposalUuid: null },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ uuid: "lone", type: "task", proposalUuid: null });
    expect(result.edges).toEqual([]);
  });

  it("keeps a task whose proposalUuid points outside the project as a node, but emits no derive edge", async () => {
    // Task references a Proposal that isn't in this project's proposal set
    // (e.g. proposal was moved or never project-local). The task still
    // appears as a node — the field is preserved — but the derive edge is
    // dropped to keep the graph closed.
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "t1", title: "T", proposalUuid: "p-foreign" },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ uuid: "t1", proposalUuid: "p-foreign" });
    expect(result.edges).toEqual([]);
  });
});

describe("getProjectResourceGraph — multi-tenancy scoping", () => {
  it("scopes every Prisma query by companyUuid AND projectUuid", async () => {
    await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    // Direct entity queries: both scopes explicit.
    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY_UUID, projectUuid: PROJECT_UUID } })
    );
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY_UUID, projectUuid: PROJECT_UUID } })
    );
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY_UUID, projectUuid: PROJECT_UUID } })
    );
    expect(mockPrisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyUuid: COMPANY_UUID, projectUuid: PROJECT_UUID } })
    );
    // TaskDependency: scoped through the related task (the model itself has
    // no companyUuid/projectUuid columns — same approach as
    // getProjectTaskDependencies in task.service.ts).
    expect(mockPrisma.taskDependency.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { task: { companyUuid: COMPANY_UUID, projectUuid: PROJECT_UUID } },
      })
    );
  });

  it("issues queries in parallel (single Promise.all)", async () => {
    // Smoke-test: all five findMany calls happen even if one of them is slow.
    let resolveSlow!: (v: unknown) => void;
    const slowPromise = new Promise<unknown[]>((resolve) => {
      resolveSlow = resolve as (v: unknown) => void;
    });
    mockPrisma.idea.findMany.mockReturnValueOnce(slowPromise);

    const pending = getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    // All five queries should already have been issued even though one is unresolved.
    expect(mockPrisma.idea.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.proposal.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.document.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.taskDependency.findMany).toHaveBeenCalledTimes(1);

    resolveSlow([]);
    await pending;
  });
});

describe("getProjectResourceGraph — defensive coding", () => {
  it("handles a malformed inputUuids JSON value as empty (does not throw)", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([
      // inputUuids is Json — a row with a null/object value (e.g. legacy
      // data) must not break the whole aggregation.
      { uuid: "p1", title: "P", inputType: "idea", inputUuids: null },
      { uuid: "p2", title: "P2", inputType: "idea", inputUuids: { not: "an array" } },
    ]);

    const result = await getProjectResourceGraph(COMPANY_UUID, PROJECT_UUID);

    expect(result.nodes.find((n) => n.uuid === "p1")?.sourceIdeaUuids).toEqual([]);
    expect(result.nodes.find((n) => n.uuid === "p2")?.sourceIdeaUuids).toEqual([]);
    expect(result.edges.filter((e) => e.kind === "derive")).toEqual([]);
  });
});
