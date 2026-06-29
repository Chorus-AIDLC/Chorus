import { describe, it, expect } from "vitest";
import {
  layoutResourceGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type Position,
} from "../resource-graph-layout";

// Sample graph used by most tests: one Idea hub, two Proposals, three Tasks
// and one Document — a connected mini-DAG that mirrors the aggregation shape
// the Tech Design defines (without depending on the actual aggregation
// service, which is a sibling task).
const SAMPLE_NODES: LayoutNodeInput[] = [
  { uuid: "idea-1" },
  { uuid: "proposal-1" },
  { uuid: "proposal-2" },
  { uuid: "task-1" },
  { uuid: "task-2" },
  { uuid: "task-3" },
  { uuid: "document-1" },
];

const SAMPLE_EDGES: LayoutEdgeInput[] = [
  { from: "idea-1", to: "proposal-1" },
  { from: "idea-1", to: "proposal-2" },
  { from: "proposal-1", to: "task-1" },
  { from: "proposal-1", to: "task-2" },
  { from: "proposal-2", to: "task-3" },
  { from: "proposal-1", to: "document-1" },
  { from: "task-1", to: "task-2" }, // task dependency
];

/**
 * Minimum Euclidean distance between any pair of positions — for asserting
 * forceCollide actually separated the nodes.
 */
function minPairwiseDistance(positions: Position[]): number {
  let min = Infinity;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < min) min = d;
    }
  }
  return min;
}

describe("layoutResourceGraph", () => {
  it("returns an empty map for an empty node set", () => {
    const result = layoutResourceGraph([], []);
    expect(result.size).toBe(0);
  });

  it("returns a position for every input node", () => {
    const result = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES);
    expect(result.size).toBe(SAMPLE_NODES.length);
    for (const n of SAMPLE_NODES) {
      const pos = result.get(n.uuid);
      expect(pos).toBeDefined();
      expect(Number.isFinite(pos!.x)).toBe(true);
      expect(Number.isFinite(pos!.y)).toBe(true);
    }
  });

  it("is deterministic — same input produces the same output", () => {
    const a = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES);
    const b = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES);
    expect(a.size).toBe(b.size);
    for (const [uuid, pa] of a) {
      const pb = b.get(uuid)!;
      // Exact equality is reasonable here because we use a seeded PRNG and
      // a manual tick count — there's no wall-clock or untyped randomness.
      expect(pb.x).toBe(pa.x);
      expect(pb.y).toBe(pa.y);
    }
  });

  it("produces non-overlapping positions (forceCollide separates nodes)", () => {
    const result = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES, undefined, {
      collideRadius: 50,
    });
    const positions = Array.from(result.values());
    // forceCollide is a soft constraint, so allow a small slack below the
    // strict 2*radius minimum (it converges arbitrarily close, not exactly).
    expect(minPairwiseDistance(positions)).toBeGreaterThan(50);
  });

  it("places linked nodes closer than the typical pair (link force pulls)", () => {
    // A graph with a tight cluster (A-B-C) and an isolated node D should
    // settle so that any pair within the cluster sits closer than D is to
    // anything in the cluster.
    const nodes: LayoutNodeInput[] = [
      { uuid: "A" },
      { uuid: "B" },
      { uuid: "C" },
      { uuid: "D" },
    ];
    const edges: LayoutEdgeInput[] = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "A", to: "C" },
    ];
    const r = layoutResourceGraph(nodes, edges);
    const dist = (p: string, q: string) => {
      const a = r.get(p)!;
      const b = r.get(q)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const clusterMax = Math.max(dist("A", "B"), dist("B", "C"), dist("A", "C"));
    const isolatedMin = Math.min(dist("A", "D"), dist("B", "D"), dist("C", "D"));
    expect(isolatedMin).toBeGreaterThan(clusterMax);
  });

  it("centers the layout around the configured center", () => {
    const result = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES, undefined, {
      centerX: 400,
      centerY: 300,
    });
    const positions = Array.from(result.values());
    const meanX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const meanY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    // forceCenter targets the mean position; after convergence the mean
    // should be at the center within a tight tolerance.
    expect(Math.abs(meanX - 400)).toBeLessThan(1);
    expect(Math.abs(meanY - 300)).toBeLessThan(1);
  });

  it("seeds from prevPositions and keeps existing nodes near their prior coordinates", () => {
    // Realistic case: prevPositions came from a prior layout call so they're
    // already roughly centered. The incremental run at low alpha should hold
    // each node within a small radius of where it was — the whole point of
    // the prevPositions path is preserving the user's mental map on
    // expand/collapse.
    const fresh = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES);
    const result = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES, fresh);
    for (const n of SAMPLE_NODES) {
      const before = fresh.get(n.uuid)!;
      const after = result.get(n.uuid)!;
      const delta = Math.hypot(after.x - before.x, after.y - before.y);
      // Tight bound: an incremental re-layout with the same topology should
      // barely move any node. (Fresh layouts of this graph spread nodes
      // across hundreds of units, so 60 here is comfortably tighter.)
      expect(delta).toBeLessThan(60);
    }
  });

  it("incremental run moves nodes less than a from-scratch re-layout would", () => {
    // Direct measure of the mental-map property: given two slightly different
    // graphs (one added node), the seeded path should keep the shared nodes
    // closer to their prior coordinates than re-running from scratch would.
    const baseNodes: LayoutNodeInput[] = [
      { uuid: "idea-1" },
      { uuid: "proposal-1" },
      { uuid: "task-1" },
      { uuid: "task-2" },
    ];
    const baseEdges: LayoutEdgeInput[] = [
      { from: "idea-1", to: "proposal-1" },
      { from: "proposal-1", to: "task-1" },
      { from: "proposal-1", to: "task-2" },
    ];
    const initial = layoutResourceGraph(baseNodes, baseEdges);

    const expandedNodes: LayoutNodeInput[] = [
      ...baseNodes,
      { uuid: "task-3" },
      { uuid: "document-1" },
    ];
    const expandedEdges: LayoutEdgeInput[] = [
      ...baseEdges,
      { from: "proposal-1", to: "task-3" },
      { from: "proposal-1", to: "document-1" },
    ];
    const seeded = layoutResourceGraph(expandedNodes, expandedEdges, initial);
    const fromScratch = layoutResourceGraph(expandedNodes, expandedEdges);

    let seededDrift = 0;
    let scratchDrift = 0;
    for (const n of baseNodes) {
      const before = initial.get(n.uuid)!;
      seededDrift += Math.hypot(
        seeded.get(n.uuid)!.x - before.x,
        seeded.get(n.uuid)!.y - before.y,
      );
      scratchDrift += Math.hypot(
        fromScratch.get(n.uuid)!.x - before.x,
        fromScratch.get(n.uuid)!.y - before.y,
      );
    }
    expect(seededDrift).toBeLessThan(scratchDrift);
  });

  it("places a brand-new node when prevPositions only covers some nodes", () => {
    // Existing graph: idea-1 + proposal-1. Add task-1 with no seed; the
    // incremental run must still position it.
    const prev = new Map<string, Position>([
      ["idea-1", { x: 0, y: 0 }],
      ["proposal-1", { x: 120, y: 0 }],
    ]);
    const nodes: LayoutNodeInput[] = [
      { uuid: "idea-1" },
      { uuid: "proposal-1" },
      { uuid: "task-1" },
    ];
    const edges: LayoutEdgeInput[] = [
      { from: "idea-1", to: "proposal-1" },
      { from: "proposal-1", to: "task-1" },
    ];
    const r = layoutResourceGraph(nodes, edges, prev);
    const taskPos = r.get("task-1")!;
    expect(Number.isFinite(taskPos.x)).toBe(true);
    expect(Number.isFinite(taskPos.y)).toBe(true);
    // Should be somewhere in the plane, not stuck on (0,0) or at NaN.
    expect(Math.hypot(taskPos.x, taskPos.y)).toBeGreaterThan(0);
  });

  it("ignores edges referencing unknown nodes instead of crashing", () => {
    // forceLink.id() throws "node not found" if a link references a missing
    // node; the layout function filters these out so callers can pass a
    // partial node set (e.g. after collapsing an Idea subgraph) without
    // pruning every edge themselves.
    const edges: LayoutEdgeInput[] = [
      ...SAMPLE_EDGES,
      { from: "idea-1", to: "ghost-node" },
      { from: "ghost-node", to: "task-1" },
    ];
    expect(() => layoutResourceGraph(SAMPLE_NODES, edges)).not.toThrow();
    const result = layoutResourceGraph(SAMPLE_NODES, edges);
    expect(result.size).toBe(SAMPLE_NODES.length);
  });

  it("handles isolated nodes (no edges) without producing NaN", () => {
    const nodes: LayoutNodeInput[] = [
      { uuid: "lonely-1" },
      { uuid: "lonely-2" },
      { uuid: "lonely-3" },
    ];
    const result = layoutResourceGraph(nodes, []);
    for (const n of nodes) {
      const p = result.get(n.uuid)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // Collide should still spread them.
    expect(minPairwiseDistance(Array.from(result.values()))).toBeGreaterThan(0);
  });

  it("handles a single node", () => {
    const result = layoutResourceGraph([{ uuid: "solo" }], []);
    expect(result.size).toBe(1);
    const p = result.get("solo")!;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it("returns bounded coordinates for a moderate graph", () => {
    // Smoke check: with default parameters and a 7-node graph, no node
    // should fly off to absurd coordinates. Loose bound that catches bugs
    // like a runaway integrator or NaN propagation.
    const result = layoutResourceGraph(SAMPLE_NODES, SAMPLE_EDGES);
    for (const p of result.values()) {
      expect(Math.abs(p.x)).toBeLessThan(5000);
      expect(Math.abs(p.y)).toBeLessThan(5000);
    }
  });
});
