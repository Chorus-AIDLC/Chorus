// Unit tests for the TWO-LEVEL expand/collapse visible-set logic.
//
// Model under test:
//   Idea  --(expand)-->  its Proposals          (level 1)
//   Proposal --(expand)-->  its Tasks + Docs     (level 2)
//
// What's covered:
//   1. Default = all collapsed → only Idea hubs (+ orphans) visible.
//   2. Expanding an Idea reveals ONLY its proposals — NOT the proposals'
//      tasks/documents (those need the proposal itself expanded).
//   3. Expanding a Proposal (with its Idea also expanded) reveals its tasks
//      + documents, including tasks reached only through `depends`
//      (root-tasks-only derive rule ≠ source of visibility; node.proposalUuid is).
//   4. Lineage edges between collapsed Ideas stay visible.
//   5. Child counts: Idea→#proposals, Proposal→#(tasks+docs).
//   6. Multi-parent proposal visible iff ANY source Idea expanded.

import { describe, it, expect } from "vitest";
import { computeVisibleSet } from "../resource-graph-visible-set";
import type { ResourceGraphResult } from "@/services/resource-graph.service";
import { shouldShowExpandAffordance } from "@/app/(dashboard)/projects/[uuid]/graph/expand-affordance";

const EMPTY: ReadonlySet<string> = new Set();

// --- Fixtures ---------------------------------------------------------------
//   idea-root ──lineage──▶ idea-child
//        │ derive               │ derive
//        ▼                      ▼
//   proposal-A             proposal-B
//        │ derive (root)        │ derive
//        ▼                      ▼
//   task-a1 ──depends──▶ task-a2     doc-b1
//        └─ derive ──▶ doc-a1
//
//   orphan-task (no proposal) — always visible.
//   manual-proposal (no source Ideas) — always visible.

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
      { from: "proposal-A", to: "task-a1", kind: "derive" },
      { from: "task-a1", to: "task-a2", kind: "depends" },
      { from: "proposal-A", to: "doc-a1", kind: "derive" },
      { from: "proposal-B", to: "doc-b1", kind: "derive" },
    ],
  };
}

describe("computeVisibleSet (two-level)", () => {
  it("collapses everything by default — only Ideas + orphans visible", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, EMPTY, EMPTY);

    expect(r.visibleNodeUuids.has("idea-root")).toBe(true);
    expect(r.visibleNodeUuids.has("idea-child")).toBe(true);

    expect(r.visibleNodeUuids.has("proposal-A")).toBe(false);
    expect(r.visibleNodeUuids.has("proposal-B")).toBe(false);
    expect(r.visibleNodeUuids.has("task-a1")).toBe(false);
    expect(r.visibleNodeUuids.has("doc-a1")).toBe(false);

    // Orphans (no collapsing parent) — always visible.
    expect(r.visibleNodeUuids.has("orphan-task")).toBe(true);
    expect(r.visibleNodeUuids.has("manual-proposal")).toBe(true);
  });

  it("keeps Idea→Idea lineage edges visible when both Ideas are collapsed", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, EMPTY, EMPTY);
    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    expect(
      visibleEdges.find(
        (e) => e.kind === "lineage" && e.from === "idea-root" && e.to === "idea-child",
      ),
    ).toBeDefined();
  });

  it("expanding an Idea reveals ONLY its proposals, NOT their tasks/docs", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set(["idea-root"]), EMPTY);

    // Level 1: proposal appears.
    expect(r.visibleNodeUuids.has("proposal-A")).toBe(true);

    // Level 2 stays hidden — the proposal itself is not expanded yet.
    expect(r.visibleNodeUuids.has("task-a1")).toBe(false);
    expect(r.visibleNodeUuids.has("task-a2")).toBe(false);
    expect(r.visibleNodeUuids.has("doc-a1")).toBe(false);

    // Other idea's proposal stays hidden.
    expect(r.visibleNodeUuids.has("proposal-B")).toBe(false);
  });

  it("expanding the Proposal reveals its tasks + docs (incl. depends-only task)", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, new Set(["idea-root"]), new Set(["proposal-A"]));

    expect(r.visibleNodeUuids.has("proposal-A")).toBe(true);
    // task-a2 has NO direct derive edge (root-tasks-only) — reached via depends —
    // but visibility is driven by node.proposalUuid, so it still appears.
    expect(r.visibleNodeUuids.has("task-a1")).toBe(true);
    expect(r.visibleNodeUuids.has("task-a2")).toBe(true);
    expect(r.visibleNodeUuids.has("doc-a1")).toBe(true);

    // depends edge between the two now-visible tasks renders.
    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    expect(
      visibleEdges.find(
        (e) => e.kind === "depends" && e.from === "task-a1" && e.to === "task-a2",
      ),
    ).toBeDefined();
  });

  it("expanding a Proposal whose Idea is collapsed does nothing (parent gates it)", () => {
    const g = buildGraph();
    // proposal-A expanded but idea-root NOT expanded → proposal itself hidden,
    // so its children stay hidden too.
    const r = computeVisibleSet(g, EMPTY, new Set(["proposal-A"]));
    expect(r.visibleNodeUuids.has("proposal-A")).toBe(false);
    expect(r.visibleNodeUuids.has("task-a1")).toBe(false);
  });

  it("reports child counts: Idea→#proposals, Proposal→#(tasks+docs)", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, EMPTY, EMPTY);

    expect(r.childCountByHub.get("idea-root")).toBe(1); // proposal-A
    expect(r.childCountByHub.get("idea-child")).toBe(1); // proposal-B
    // proposal-A has task-a1, task-a2, doc-a1 = 3 children.
    expect(r.childCountByHub.get("proposal-A")).toBe(3);
    // proposal-B has doc-b1 = 1.
    expect(r.childCountByHub.get("proposal-B")).toBe(1);
    // Tasks/Docs are leaves — no hub entry.
    expect(r.childCountByHub.has("task-a1")).toBe(false);
  });

  it("child count is stable across expand state", () => {
    const g = buildGraph();
    const collapsed = computeVisibleSet(g, EMPTY, EMPTY);
    const expanded = computeVisibleSet(
      g,
      new Set(["idea-root"]),
      new Set(["proposal-A"]),
    );
    expect(expanded.childCountByHub.get("proposal-A")).toBe(
      collapsed.childCountByHub.get("proposal-A"),
    );
  });

  it("treats a proposal cited by multiple Ideas as visible when ANY is expanded", () => {
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

    expect(
      computeVisibleSet(g, EMPTY, EMPTY).visibleNodeUuids.has("proposal-shared"),
    ).toBe(false);
    expect(
      computeVisibleSet(g, new Set(["idea-2"]), EMPTY).visibleNodeUuids.has(
        "proposal-shared",
      ),
    ).toBe(true);

    // Each idea counts the shared proposal once (per-Idea, not deduped).
    const r = computeVisibleSet(g, EMPTY, EMPTY);
    expect(r.childCountByHub.get("idea-1")).toBe(1);
    expect(r.childCountByHub.get("idea-2")).toBe(1);
  });

  it("does not emit edges where one endpoint is hidden", () => {
    const g = buildGraph();
    const r = computeVisibleSet(g, EMPTY, EMPTY);
    const visibleEdges = r.visibleEdgeIndices.map((i) => g.edges[i]);
    expect(
      visibleEdges.find(
        (e) => e.kind === "derive" && e.from === "idea-root" && e.to === "proposal-A",
      ),
    ).toBeUndefined();
  });

  it("handles the empty graph without crashing", () => {
    const r = computeVisibleSet({ nodes: [], edges: [] }, EMPTY, EMPTY);
    expect(r.visibleNodeUuids.size).toBe(0);
    expect(r.visibleEdgeIndices).toEqual([]);
    expect(r.childCountByHub.size).toBe(0);
  });
});

// Leaf-detection symmetry: the renderer's affordance gate must mirror the
// visible-set's structural definition — Idea AND Proposal hubs with children
// show the +/- button; Tasks/Documents never do.
describe("shouldShowExpandAffordance (two-level hub detection)", () => {
  it("returns true for Ideas and Proposals with children", () => {
    expect(shouldShowExpandAffordance("idea", 2)).toBe(true);
    expect(shouldShowExpandAffordance("proposal", 3)).toBe(true);
  });

  it("returns false for a childless hub", () => {
    expect(shouldShowExpandAffordance("idea", 0)).toBe(false);
    expect(shouldShowExpandAffordance("proposal", undefined)).toBe(false);
  });

  it("returns false for leaf node types regardless of count", () => {
    expect(shouldShowExpandAffordance("task", 5)).toBe(false);
    expect(shouldShowExpandAffordance("document", 99)).toBe(false);
  });
});
