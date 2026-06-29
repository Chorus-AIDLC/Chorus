// Unit tests for the per-Idea expand/collapse visible-set logic.
//
// What's covered (mirroring Wave 3 task ACs):
//   1. Count correctness — N pill shows direct derivative count regardless
//      of current expand state, and direct = proposals listing this Idea
//      in sourceIdeaUuids (NOT the recursive subtree).
//   2. Leaf detection — Tasks/Documents never carry a derivative count;
//      they're not Ideas. Verified indirectly: only Ideas get an entry in
//      derivativeCountByIdea. The renderer's leaf-detection helper has
//      its own assertion below.
//   3. Lineage-always-visible — Idea→Idea lineage edges render even when
//      both endpoints are collapsed (since both endpoints are Ideas, which
//      are always in the visible set).
//   4. Default = all collapsed → only Idea hubs visible.
//   5. Expanding an Idea reveals its proposal + the proposal's
//      tasks/documents — including tasks reached only through depends
//      (the root-tasks-only proposal-derive rule is not the source of
//      visibility; node.proposalUuid is).
//   6. Multi-parent proposal: visible iff ANY source Idea is expanded.

import { describe, it, expect } from "vitest";
import { computeVisibleSet } from "../resource-graph-visible-set";
import type { ResourceGraphResult } from "@/services/resource-graph.service";
import { shouldShowExpandAffordance } from "@/app/(dashboard)/projects/[uuid]/graph/expand-affordance";

// --- Fixtures ---------------------------------------------------------------
// A small graph mirroring the AI-DLC shape:
//
//   idea-root ──lineage──▶ idea-child
//        │                       │
//        ▼ derive                ▼ derive
//   proposal-A             proposal-B
//        │ derive (root-task)         │ derive
//        ▼                            ▼
//   task-a1 ──depends──▶ task-a2  doc-b1
//        │
//        └─ derive ──▶ doc-a1
//
// Plus:
//   - orphan-task (no proposal) — should always be visible.
//   - manual-proposal (no source Ideas) — should always be visible.

function buildGraph(): ResourceGraphResult {
  return {
    nodes: [
      { uuid: "idea-root", type: "idea", title: "Root idea", parentIdeaUuid: null },
      {
        uuid: "idea-child",
        type: "idea",
        title: "Child idea",
        parentIdeaUuid: "idea-root",
      },
      {
        uuid: "proposal-A",
        type: "proposal",
        title: "Proposal A",
        sourceIdeaUuids: ["idea-root"],
      },
      {
        uuid: "proposal-B",
        type: "proposal",
        title: "Proposal B",
        sourceIdeaUuids: ["idea-child"],
      },
      {
        uuid: "manual-proposal",
        type: "proposal",
        title: "Manual proposal",
        sourceIdeaUuids: [],
      },
      { uuid: "task-a1", type: "task", title: "Task A1", proposalUuid: "proposal-A" },
      { uuid: "task-a2", type: "task", title: "Task A2", proposalUuid: "proposal-A" },
      { uuid: "doc-a1", type: "document", title: "Doc A1", proposalUuid: "proposal-A" },
      { uuid: "doc-b1", type: "document", title: "Doc B1", proposalUuid: "proposal-B" },
      { uuid: "orphan-task", type: "task", title: "Orphan", proposalUuid: null },
    ],
    edges: [
      { from: "idea-root", to: "idea-child", kind: "lineage" },
      { from: "idea-root", to: "proposal-A", kind: "derive" },
      { from: "idea-child", to: "proposal-B", kind: "derive" },
      // ROOT-TASKS-ONLY rule: only task-a1 (the root task within proposal-A)
      // gets a direct derive edge. task-a2 is reached via the depends arrow.
      { from: "proposal-A", to: "task-a1", kind: "derive" },
      { from: "task-a1", to: "task-a2", kind: "depends" },
      { from: "proposal-A", to: "doc-a1", kind: "derive" },
      { from: "proposal-B", to: "doc-b1", kind: "derive" },
    ],
  };
}

describe("computeVisibleSet", () => {
  it("collapses every Idea by default — only Ideas + orphans visible", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set());

    expect(r.visibleNodeUuids.has("idea-root")).toBe(true);
    expect(r.visibleNodeUuids.has("idea-child")).toBe(true);

    // Proposals with an Idea parent are hidden by default.
    expect(r.visibleNodeUuids.has("proposal-A")).toBe(false);
    expect(r.visibleNodeUuids.has("proposal-B")).toBe(false);

    // Tasks/Documents underneath hidden Proposals are hidden too.
    expect(r.visibleNodeUuids.has("task-a1")).toBe(false);
    expect(r.visibleNodeUuids.has("task-a2")).toBe(false);
    expect(r.visibleNodeUuids.has("doc-a1")).toBe(false);
    expect(r.visibleNodeUuids.has("doc-b1")).toBe(false);

    // Orphan task (no proposal) — always visible.
    expect(r.visibleNodeUuids.has("orphan-task")).toBe(true);
    // Manual proposal (no source Idea) — always visible.
    expect(r.visibleNodeUuids.has("manual-proposal")).toBe(true);
  });

  it("keeps Idea→Idea lineage edges visible when both Ideas are collapsed", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set());

    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    const lineage = visibleEdges.find(
      (e) => e.kind === "lineage" && e.from === "idea-root" && e.to === "idea-child",
    );
    expect(lineage).toBeDefined();
  });

  it("reports direct-derivative count = # of proposals citing this Idea", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set());

    // Each idea has exactly one direct proposal in this fixture. The count
    // is unaffected by what's currently visible — it's a structural fact.
    expect(r.derivativeCountByIdea.get("idea-root")).toBe(1);
    expect(r.derivativeCountByIdea.get("idea-child")).toBe(1);

    // Non-Idea nodes don't get an entry — count is Idea-only.
    expect(r.derivativeCountByIdea.has("proposal-A")).toBe(false);
    expect(r.derivativeCountByIdea.has("task-a1")).toBe(false);
  });

  it("derivative count is stable across expand state", () => {
    const g = buildGraph();
    const collapsed = computeVisibleSet(g, new Set());
    const expanded = computeVisibleSet(g, new Set(["idea-root"]));

    expect(expanded.derivativeCountByIdea.get("idea-root")).toBe(
      collapsed.derivativeCountByIdea.get("idea-root"),
    );
  });

  it("expanding an Idea reveals proposals + tasks (incl. depends-only) + documents", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set(["idea-root"]));

    // Proposal A is now visible.
    expect(r.visibleNodeUuids.has("proposal-A")).toBe(true);

    // BOTH tasks of proposal A are visible — task-a2 is reachable only
    // through a depends edge from task-a1 (no direct derive edge from
    // proposal-A to task-a2 because of the root-tasks-only rule), but
    // visibility is driven by node.proposalUuid, not the derive edge.
    expect(r.visibleNodeUuids.has("task-a1")).toBe(true);
    expect(r.visibleNodeUuids.has("task-a2")).toBe(true);

    // Document under proposal A.
    expect(r.visibleNodeUuids.has("doc-a1")).toBe(true);

    // Proposal B + its derivatives remain hidden (only idea-root is expanded).
    expect(r.visibleNodeUuids.has("proposal-B")).toBe(false);
    expect(r.visibleNodeUuids.has("doc-b1")).toBe(false);
  });

  it("includes the depends edge when both endpoints become visible", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set(["idea-root"]));

    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    expect(
      visibleEdges.find(
        (e) => e.kind === "depends" && e.from === "task-a1" && e.to === "task-a2",
      ),
    ).toBeDefined();
  });

  it("hides the depends edge again when the Idea collapses", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set()); // all collapsed

    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    expect(
      visibleEdges.find(
        (e) => e.kind === "depends" && e.from === "task-a1" && e.to === "task-a2",
      ),
    ).toBeUndefined();
  });

  it("treats a proposal cited by multiple Ideas as visible when ANY of them is expanded", () => {
    const g: ResourceGraphResult = {
      nodes: [
        { uuid: "idea-1", type: "idea", title: "I1", parentIdeaUuid: null },
        { uuid: "idea-2", type: "idea", title: "I2", parentIdeaUuid: null },
        {
          uuid: "proposal-shared",
          type: "proposal",
          title: "Shared",
          sourceIdeaUuids: ["idea-1", "idea-2"],
        },
      ],
      edges: [
        { from: "idea-1", to: "proposal-shared", kind: "derive" },
        { from: "idea-2", to: "proposal-shared", kind: "derive" },
      ],
    };

    // Neither expanded → hidden.
    expect(
      computeVisibleSet(g, new Set()).visibleNodeUuids.has("proposal-shared"),
    ).toBe(false);

    // Just idea-2 expanded → visible.
    expect(
      computeVisibleSet(g, new Set(["idea-2"])).visibleNodeUuids.has(
        "proposal-shared",
      ),
    ).toBe(true);

    // Both expanded → visible (no double-count, just visible).
    expect(
      computeVisibleSet(g, new Set(["idea-1", "idea-2"])).visibleNodeUuids.has(
        "proposal-shared",
      ),
    ).toBe(true);

    // Both Ideas show derivativeCount=1 (each "directly derives" the shared
    // proposal — the count is per-Idea, not deduped across Ideas).
    const r = computeVisibleSet(g, new Set());
    expect(r.derivativeCountByIdea.get("idea-1")).toBe(1);
    expect(r.derivativeCountByIdea.get("idea-2")).toBe(1);
  });

  it("does not emit edges where one endpoint is hidden", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set()); // every Idea collapsed

    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    // The idea→proposal derive edges should all be hidden because the
    // proposal side is invisible.
    expect(
      visibleEdges.find(
        (e) => e.kind === "derive" && e.from === "idea-root" && e.to === "proposal-A",
      ),
    ).toBeUndefined();
  });

  it("handles the empty graph without crashing", () => {
    const r = computeVisibleSet({ nodes: [], edges: [] }, new Set());
    expect(r.visibleNodeUuids.size).toBe(0);
    expect(r.visibleEdgeIndices).toEqual([]);
    expect(r.derivativeCountByIdea.size).toBe(0);
  });
});

// The leaf-detection symmetry: the renderer's expand-affordance gate must
// reflect the visible-set's structural definition — only Ideas with N > 0
// derivatives show an affordance. Tasks/Documents/Proposals never do.
describe("shouldShowExpandAffordance (renderer leaf detection)", () => {
  it("returns true only for Ideas with derivativeCount > 0", () => {
    expect(shouldShowExpandAffordance("idea", 2)).toBe(true);
    expect(shouldShowExpandAffordance("idea", 1)).toBe(true);
  });

  it("returns false for a leaf Idea (count = 0) — no children to expand", () => {
    expect(shouldShowExpandAffordance("idea", 0)).toBe(false);
    expect(shouldShowExpandAffordance("idea", undefined)).toBe(false);
  });

  it("returns false for non-Idea node types regardless of count", () => {
    expect(shouldShowExpandAffordance("proposal", 5)).toBe(false);
    expect(shouldShowExpandAffordance("task", 0)).toBe(false);
    expect(shouldShowExpandAffordance("document", 99)).toBe(false);
  });
});
