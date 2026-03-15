/**
 * dag-view-filtering.test.ts
 *
 * Tests for DAG view proposal-based filtering logic.
 * Since the project uses vitest with node environment (no jsdom/React Testing Library),
 * we extract and test the filtering logic as pure functions.
 */
import { describe, it, expect } from "vitest";

// ------------------------------------------------------------------
// Replicate the filtering logic from dag-view.tsx as pure functions
// ------------------------------------------------------------------

interface DagNode {
  uuid: string;
  title: string;
  status: string;
  priority: string;
  proposalUuid: string | null;
}

interface DagEdge {
  from: string;
  to: string;
}

function parseProposalUuidsParam(param: string | null): Set<string> | null {
  if (!param) return null;
  const uuids = param.split(",").filter(Boolean);
  return uuids.length > 0 ? new Set(uuids) : null;
}

function filterDagByProposals(
  nodes: DagNode[],
  edges: DagEdge[],
  proposalUuids: Set<string> | null
): { nodes: DagNode[]; edges: DagEdge[] } {
  if (!proposalUuids) {
    return { nodes, edges };
  }

  const filteredNodes = nodes.filter(
    (n) => n.proposalUuid !== null && proposalUuids.has(n.proposalUuid)
  );
  const visibleNodeIds = new Set(filteredNodes.map((n) => n.uuid));
  const filteredEdges = edges.filter(
    (e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)
  );

  return { nodes: filteredNodes, edges: filteredEdges };
}

// ------------------------------------------------------------------
// Test data
// ------------------------------------------------------------------

const NODES: DagNode[] = [
  { uuid: "t1", title: "Task 1", status: "open", priority: "high", proposalUuid: "p1" },
  { uuid: "t2", title: "Task 2", status: "in_progress", priority: "medium", proposalUuid: "p1" },
  { uuid: "t3", title: "Task 3", status: "done", priority: "low", proposalUuid: "p2" },
  { uuid: "t4", title: "Task 4", status: "open", priority: "high", proposalUuid: "p2" },
  { uuid: "t5", title: "Task 5", status: "assigned", priority: "medium", proposalUuid: null },
];

const EDGES: DagEdge[] = [
  { from: "t2", to: "t1" },  // t2 depends on t1 (both p1)
  { from: "t3", to: "t1" },  // t3 depends on t1 (cross-proposal: p2 -> p1)
  { from: "t4", to: "t3" },  // t4 depends on t3 (both p2)
  { from: "t5", to: "t2" },  // t5 depends on t2 (null -> p1)
];

// ------------------------------------------------------------------
// 1. ProposalFilter rendering in DAG view (structural test)
// ------------------------------------------------------------------
describe("DAG view - ProposalFilter integration", () => {
  it("ProposalFilter is rendered in the DAG view section of TaskViewToggle", () => {
    // This test verifies the structural contract: the DAG view section
    // in task-view-toggle.tsx includes a ProposalFilter component.
    // We verify this by reading the import and usage pattern.
    // The component is placed above all views (shared filter).
    const fs = require("fs");
    const path = require("path");
    const content = fs.readFileSync(
      path.resolve(__dirname, "../task-view-toggle.tsx"),
      "utf-8"
    );

    // Verify ProposalFilter is imported
    expect(content).toContain('import { ProposalFilter }');
    // Verify ProposalFilter is used with projectUuid prop
    expect(content).toContain('<ProposalFilter projectUuid={projectUuid}');
  });
});

// ------------------------------------------------------------------
// 2. URL param parsing
// ------------------------------------------------------------------
describe("DAG view - proposalUuids param parsing", () => {
  it("returns null for empty/null param", () => {
    expect(parseProposalUuidsParam(null)).toBeNull();
    expect(parseProposalUuidsParam("")).toBeNull();
  });

  it("parses single uuid", () => {
    const result = parseProposalUuidsParam("p1");
    expect(result).toEqual(new Set(["p1"]));
  });

  it("parses multiple uuids", () => {
    const result = parseProposalUuidsParam("p1,p2,p3");
    expect(result).toEqual(new Set(["p1", "p2", "p3"]));
  });
});

// ------------------------------------------------------------------
// 3. Node filtering by proposalUuids
// ------------------------------------------------------------------
describe("DAG view - node filtering", () => {
  it("returns all nodes when proposalUuids is null (no filter)", () => {
    const result = filterDagByProposals(NODES, EDGES, null);
    expect(result.nodes).toHaveLength(5);
    expect(result.edges).toHaveLength(4);
  });

  it("filters to only nodes from selected proposal", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["p1"]));
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.uuid).sort()).toEqual(["t1", "t2"]);
  });

  it("filters to multiple proposals", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["p1", "p2"]));
    expect(result.nodes).toHaveLength(4);
    expect(result.nodes.map((n) => n.uuid).sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("excludes tasks with null proposalUuid", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["p1"]));
    const uuids = result.nodes.map((n) => n.uuid);
    expect(uuids).not.toContain("t5");
  });

  it("returns empty when no proposals match", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["nonexistent"]));
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ------------------------------------------------------------------
// 4. Edge filtering (both ends must be visible)
// ------------------------------------------------------------------
describe("DAG view - edge filtering", () => {
  it("keeps edges where both source and target are visible", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["p1"]));
    // Only t1 and t2 are visible; edge t2->t1 should remain
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ from: "t2", to: "t1" });
  });

  it("removes cross-proposal edges when only one proposal selected", () => {
    // Filter to p2 only: t3, t4 visible
    // Edge t3->t1 is cross-proposal (t1 is in p1, not visible) => removed
    // Edge t4->t3 is within p2 => kept
    const result = filterDagByProposals(NODES, EDGES, new Set(["p2"]));
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ from: "t4", to: "t3" });
  });

  it("keeps cross-proposal edges when both proposals selected", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["p1", "p2"]));
    // t1, t2, t3, t4 visible; t5 hidden (null proposalUuid)
    // Edge t2->t1: both visible => kept
    // Edge t3->t1: both visible => kept
    // Edge t4->t3: both visible => kept
    // Edge t5->t2: t5 not visible => removed
    expect(result.edges).toHaveLength(3);
    expect(result.edges).toContainEqual({ from: "t2", to: "t1" });
    expect(result.edges).toContainEqual({ from: "t3", to: "t1" });
    expect(result.edges).toContainEqual({ from: "t4", to: "t3" });
  });

  it("removes edges to null-proposalUuid tasks", () => {
    // t5 has null proposalUuid, so it's always excluded when filtering
    const result = filterDagByProposals(NODES, EDGES, new Set(["p1"]));
    const edgeTargets = result.edges.map((e) => [e.from, e.to]).flat();
    expect(edgeTargets).not.toContain("t5");
  });

  it("returns no edges when no nodes are visible", () => {
    const result = filterDagByProposals(NODES, EDGES, new Set(["nonexistent"]));
    expect(result.edges).toHaveLength(0);
  });
});
