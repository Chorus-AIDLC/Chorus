// Unit tests for the deterministic FOREST LAYOUT module.
//
// What's covered (per task AC):
//   1. Single-root tree — parent left of children, children to its right.
//   2. Multi-root vertical stacking — separate roots never share a vertical band.
//   3. lineage child as a subtree — a child Idea nests under its parent Idea.
//   4. orphan-as-root — a node with no resolvable tree parent becomes a root.
//   5. `depends` nests a dependent task under its prerequisite (chain flows
//      right); secondary depends + multi-source derive edges stay inert.
//   6. Determinism — identical inputs produce byte-identical coordinates.
//   7. Pre-order DFS outline with per-node depth (mobile outline contract).

import { describe, it, expect } from "vitest";
import {
  computeTreeLayout,
  type TreeLayoutNode,
  type TreeLayoutLink,
} from "../resource-graph-tree-layout";

// --- Fixture helpers ---------------------------------------------------------

function idea(id: string): TreeLayoutNode {
  return { id, type: "idea", title: id, childCount: 0, hasAffordance: false };
}
function proposal(id: string, ownerId?: string): TreeLayoutNode {
  return { id, type: "proposal", title: id, ownerId };
}
function task(id: string, ownerId?: string): TreeLayoutNode {
  return { id, type: "task", title: id, ownerId };
}
function doc(id: string, ownerId?: string): TreeLayoutNode {
  return { id, type: "document", title: id, ownerId };
}

const lineage = (from: string, to: string): TreeLayoutLink => ({
  source: from,
  target: to,
  kind: "lineage",
});
const derive = (from: string, to: string): TreeLayoutLink => ({
  source: from,
  target: to,
  kind: "derive",
});
const depends = (from: string, to: string): TreeLayoutLink => ({
  source: from,
  target: to,
  kind: "depends",
});

// --- 1. Single-root tree -----------------------------------------------------

describe("computeTreeLayout — single-root tree", () => {
  // idea-A ──derive──▶ proposal-P ──derive──▶ task-T, doc-D
  // (proposal/task/doc carry ownerId hints; ideas carry none)
  const nodes: TreeLayoutNode[] = [
    idea("idea-A"),
    proposal("proposal-P", "idea-A"),
    task("task-T", "proposal-P"),
    doc("doc-D", "proposal-P"),
  ];
  const links: TreeLayoutLink[] = [
    derive("idea-A", "proposal-P"),
    derive("proposal-P", "task-T"),
    derive("proposal-P", "doc-D"),
  ];

  it("positions every node and assigns increasing depth left to right", () => {
    const { positions } = computeTreeLayout(nodes, links);
    expect(positions.size).toBe(4);

    const a = positions.get("idea-A")!;
    const p = positions.get("proposal-P")!;
    const t = positions.get("task-T")!;
    const d = positions.get("doc-D")!;

    // Depth = derivation level.
    expect(a.depth).toBe(0);
    expect(p.depth).toBe(1);
    expect(t.depth).toBe(2);
    expect(d.depth).toBe(2);

    // Horizontal: deeper nodes are strictly to the right (left -> right tree).
    expect(p.x).toBeGreaterThan(a.x);
    expect(t.x).toBeGreaterThan(p.x);
    expect(d.x).toBe(t.x); // same depth -> same column
  });

  it("spreads same-depth siblings on the vertical axis", () => {
    const { positions } = computeTreeLayout(nodes, links);
    const t = positions.get("task-T")!;
    const d = positions.get("doc-D")!;
    expect(t.y).not.toBe(d.y);
  });
});

// --- 2. Multi-root vertical stacking ----------------------------------------

describe("computeTreeLayout — multi-root vertical stacking", () => {
  // Two unrelated root ideas, each with one proposal child.
  const nodes: TreeLayoutNode[] = [
    idea("idea-1"),
    proposal("prop-1", "idea-1"),
    idea("idea-2"),
    proposal("prop-2", "idea-2"),
  ];
  const links: TreeLayoutLink[] = [
    derive("idea-1", "prop-1"),
    derive("idea-2", "prop-2"),
  ];

  it("stacks separate roots so their vertical bands do not overlap", () => {
    const { positions } = computeTreeLayout(nodes, links);

    const tree1Ys = [positions.get("idea-1")!.y, positions.get("prop-1")!.y];
    const tree2Ys = [positions.get("idea-2")!.y, positions.get("prop-2")!.y];

    const tree1Max = Math.max(...tree1Ys);
    const tree2Min = Math.min(...tree2Ys);

    // The second tree starts strictly below the first tree's lowest node
    // (vertical stacking with a fixed gap).
    expect(tree2Min).toBeGreaterThan(tree1Max);
  });

  it("both roots share the same starting horizontal column (depth 0)", () => {
    const { positions } = computeTreeLayout(nodes, links);
    expect(positions.get("idea-1")!.x).toBe(positions.get("idea-2")!.x);
    expect(positions.get("idea-1")!.depth).toBe(0);
    expect(positions.get("idea-2")!.depth).toBe(0);
  });
});

// --- 3. lineage child as a subtree ------------------------------------------

describe("computeTreeLayout — lineage child as subtree", () => {
  // idea-root ──lineage──▶ idea-child (child Idea nests under parent Idea).
  // The child idea's parentage comes from the lineage edge, NOT an ownerId.
  const nodes: TreeLayoutNode[] = [idea("idea-root"), idea("idea-child")];
  const links: TreeLayoutLink[] = [lineage("idea-root", "idea-child")];

  it("nests the child Idea one level deeper than its lineage parent", () => {
    const { positions, outline } = computeTreeLayout(nodes, links);
    const root = positions.get("idea-root")!;
    const child = positions.get("idea-child")!;

    expect(root.depth).toBe(0);
    expect(child.depth).toBe(1);
    expect(child.x).toBeGreaterThan(root.x);

    // Only ONE forest root: idea-child must NOT be a top-level root.
    const rootsInOutline = outline.filter((e) => e.depth === 0);
    expect(rootsInOutline).toHaveLength(1);
    expect(rootsInOutline[0].id).toBe("idea-root");
  });

  it("treats a lineage edge whose parent is hidden as making the child a root", () => {
    // Only the child is visible; its lineage parent is not in the node set.
    const orphanChild: TreeLayoutNode[] = [idea("idea-child")];
    const orphanLinks: TreeLayoutLink[] = [lineage("idea-root", "idea-child")];
    const { positions } = computeTreeLayout(orphanChild, orphanLinks);
    expect(positions.get("idea-child")!.depth).toBe(0); // root, parent absent
  });
});

// --- 4. orphan-as-root -------------------------------------------------------

describe("computeTreeLayout — orphan as root", () => {
  // A manual task with no ownerId, and a proposal whose owner idea is absent.
  const nodes: TreeLayoutNode[] = [
    idea("idea-A"),
    task("orphan-task"), // no ownerId at all
    proposal("secondary-prop", "missing-idea"), // owner not in node set
  ];
  const links: TreeLayoutLink[] = [];

  it("makes nodes with no resolvable tree parent their own roots", () => {
    const { positions, outline } = computeTreeLayout(nodes, links);
    expect(positions.get("idea-A")!.depth).toBe(0);
    expect(positions.get("orphan-task")!.depth).toBe(0);
    expect(positions.get("secondary-prop")!.depth).toBe(0);

    // Three forest roots, all stacked at depth 0.
    expect(outline.filter((e) => e.depth === 0)).toHaveLength(3);
    // ...and they do not vertically overlap (strictly increasing y in input order).
    const y1 = positions.get("idea-A")!.y;
    const y2 = positions.get("orphan-task")!.y;
    const y3 = positions.get("secondary-prop")!.y;
    expect(y2).toBeGreaterThan(y1);
    expect(y3).toBeGreaterThan(y2);
  });
});

// --- 5. depends shapes the task chain; secondary edges stay inert -----------

describe("computeTreeLayout — depends nests the task chain", () => {
  const baseNodes: TreeLayoutNode[] = [
    idea("idea-A"),
    proposal("prop-P", "idea-A"),
    task("task-1", "prop-P"),
    task("task-2", "prop-P"),
  ];
  const treeLinks: TreeLayoutLink[] = [
    derive("idea-A", "prop-P"),
    derive("prop-P", "task-1"),
    derive("prop-P", "task-2"),
  ];

  it("nests a dependent task UNDER its prerequisite (chain flows right)", () => {
    // task-2 depends on task-1 → task-2 should hang off task-1, one level
    // deeper, instead of sitting as a same-column sibling under the proposal.
    const { positions, treeParentById } = computeTreeLayout(baseNodes, [
      ...treeLinks,
      depends("task-1", "task-2"),
    ]);

    const p = positions.get("prop-P")!;
    const t1 = positions.get("task-1")!;
    const t2 = positions.get("task-2")!;

    // task-1 is a root task (depth 2, under the proposal); task-2 nests under
    // task-1 (depth 3, strictly to its right).
    expect(t1.depth).toBe(2);
    expect(t2.depth).toBe(3);
    expect(t2.x).toBeGreaterThan(t1.x);
    expect(t1.x).toBeGreaterThan(p.x);

    // The spine map records task-1 (not the proposal) as task-2's tree parent.
    expect(treeParentById.get("task-2")).toBe("task-1");
    expect(treeParentById.get("task-1")).toBe("prop-P");
  });

  it("keeps a root task (no prerequisite) directly under its proposal", () => {
    const { positions, treeParentById } = computeTreeLayout(baseNodes, [
      ...treeLinks,
      depends("task-1", "task-2"),
    ]);
    // task-1 has no incoming depends → stays under prop-P at depth 2.
    expect(positions.get("task-1")!.depth).toBe(2);
    expect(treeParentById.get("task-1")).toBe("prop-P");
  });

  it("falls back to the proposal when the prerequisite is not visible", () => {
    // Only task-2 is visible; its prerequisite task-1 is absent → task-2 nests
    // under its ownerId proposal instead of becoming an orphan root.
    const nodes: TreeLayoutNode[] = [
      idea("idea-A"),
      proposal("prop-P", "idea-A"),
      task("task-2", "prop-P"),
    ];
    const { positions, treeParentById } = computeTreeLayout(nodes, [
      derive("idea-A", "prop-P"),
      depends("task-1", "task-2"), // task-1 not in node set
    ]);
    expect(positions.get("task-2")!.depth).toBe(2);
    expect(treeParentById.get("task-2")).toBe("prop-P");
  });

  it("treats a second `depends` prerequisite as inert (first wins)", () => {
    // task-3 depends on BOTH task-1 and task-2. Only the FIRST depends edge in
    // input order shapes the spine; the second is a cross-link, not a re-home.
    const nodes: TreeLayoutNode[] = [
      ...baseNodes,
      task("task-3", "prop-P"),
    ];
    const { treeParentById } = computeTreeLayout(nodes, [
      ...treeLinks,
      derive("prop-P", "task-3"),
      depends("task-1", "task-3"), // first prerequisite → spine parent
      depends("task-2", "task-3"), // second prerequisite → inert cross-link
    ]);
    expect(treeParentById.get("task-3")).toBe("task-1");
  });

  it("a multi-source secondary `derive` edge to an already-parented node is inert", () => {
    // prop-P is owned by idea-A (ownerId). A second source idea is represented
    // ONLY as an extra derive edge from idea-B; it must not re-home prop-P.
    const nodes: TreeLayoutNode[] = [...baseNodes, idea("idea-B")];
    const withSecondarySource = computeTreeLayout(nodes, [
      ...treeLinks,
      derive("idea-B", "prop-P"), // secondary source — NOT the ownerId
    ]);

    // prop-P keeps idea-A as its tree parent (depth 1 under idea-A), and idea-B
    // is its own root (no children).
    const p = withSecondarySource.positions.get("prop-P")!;
    expect(p.depth).toBe(1);
    expect(withSecondarySource.treeParentById.get("prop-P")).toBe("idea-A");
    // idea-B has no tree children, so it is a leaf root.
    const b = withSecondarySource.positions.get("idea-B")!;
    expect(b.depth).toBe(0);
  });
});

// --- 6. Determinism ----------------------------------------------------------

describe("computeTreeLayout — determinism", () => {
  const nodes: TreeLayoutNode[] = [
    idea("idea-root"),
    idea("idea-child"),
    proposal("prop-1", "idea-root"),
    proposal("prop-2", "idea-child"),
    task("task-1", "prop-1"),
    doc("doc-1", "prop-1"),
    task("task-2", "prop-2"),
  ];
  const links: TreeLayoutLink[] = [
    lineage("idea-root", "idea-child"),
    derive("idea-root", "prop-1"),
    derive("idea-child", "prop-2"),
    derive("prop-1", "task-1"),
    derive("prop-1", "doc-1"),
    derive("prop-2", "task-2"),
    depends("task-1", "task-2"),
  ];

  it("produces identical coordinates across repeated runs", () => {
    const a = computeTreeLayout(nodes, links);
    const b = computeTreeLayout(nodes, links);

    expect(serialize(a.positions)).toEqual(serialize(b.positions));
    expect(a.outline).toEqual(b.outline);
  });

  it("is insensitive to a fresh copy of the same inputs (no shared mutation)", () => {
    const a = computeTreeLayout(nodes, links);
    const b = computeTreeLayout(
      nodes.map((n) => ({ ...n })),
      links.map((l) => ({ ...l })),
    );
    expect(serialize(a.positions)).toEqual(serialize(b.positions));
  });
});

// --- 7. Pre-order DFS outline ------------------------------------------------

describe("computeTreeLayout — pre-order DFS outline", () => {
  // idea-root
  //   ├─ idea-child         (lineage)
  //   │    └─ prop-2        (derive, owner idea-child)
  //   │          └─ task-2  (derive, owner prop-2)
  //   └─ prop-1             (derive, owner idea-root)
  //          └─ task-1      (derive, owner prop-1)
  const nodes: TreeLayoutNode[] = [
    idea("idea-root"),
    idea("idea-child"),
    proposal("prop-2", "idea-child"),
    task("task-2", "prop-2"),
    proposal("prop-1", "idea-root"),
    task("task-1", "prop-1"),
  ];
  const links: TreeLayoutLink[] = [
    lineage("idea-root", "idea-child"),
    derive("idea-child", "prop-2"),
    derive("prop-2", "task-2"),
    derive("idea-root", "prop-1"),
    derive("prop-1", "task-1"),
  ];

  it("emits a pre-order ordering with correct per-node depth", () => {
    const { outline } = computeTreeLayout(nodes, links);

    // Pre-order: parent appears before all its descendants; siblings in input
    // order. idea-child precedes prop-1 (lineage child added before the
    // derive-child because idea-child appears earlier in the node list).
    expect(outline.map((e) => e.id)).toEqual([
      "idea-root",
      "idea-child",
      "prop-2",
      "task-2",
      "prop-1",
      "task-1",
    ]);
    expect(outline.map((e) => e.depth)).toEqual([0, 1, 2, 3, 1, 2]);
  });

  it("includes every visible node exactly once", () => {
    const { outline } = computeTreeLayout(nodes, links);
    const ids = outline.map((e) => e.id).sort();
    expect(ids).toEqual([...nodes.map((n) => n.id)].sort());
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });
});

// --- helpers -----------------------------------------------------------------

function serialize(positions: Map<string, { x: number; y: number; depth: number }>) {
  return [...positions.entries()]
    .map(([id, p]) => `${id}:${p.x},${p.y},${p.depth}`)
    .sort();
}
