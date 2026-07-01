// Unit tests for the pure node-search helpers (Tech Design D1 / D2).
//
// What's covered:
//   computeSearchMatches —
//     1. case-insensitive substring on title only (not type/status text)
//     2. substring, NOT fuzzy / subsequence
//     3. blank/whitespace query → null (not-searching) vs. non-blank zero-hit
//        → empty Set (distinct downstream states)
//     4. matches computed over the caller-supplied (type-filtered) node list —
//        a node absent from that list never matches
//   expandAncestorsForMatches —
//     5. deep task → proposal → source-idea expansion
//     6. document → proposal → source-idea expansion
//     7. proposal match → its first project-local source idea only (no proposal)
//     8. idea match → nothing added
//     9. orphan / no-proposal / cross-project / unknown-id nodes → no throw
//    10. first PROJECT-LOCAL source idea is chosen (skips non-local entries)
//   orderMatchIdsByOutline —
//    11. matches are returned in pre-order DFS outline order, verified against
//        the REAL computeTreeLayout(...).outline (not a hand-rolled order)

import { describe, it, expect } from "vitest";
import {
  computeSearchMatches,
  expandAncestorsForMatches,
  orderMatchIdsByOutline,
} from "../resource-graph-search";
import { computeTreeLayout } from "../resource-graph-tree-layout";
import type {
  ResourceGraphResult,
  ResourceGraphNode,
} from "@/services/resource-graph.service";
import type {
  TreeLayoutNode,
  TreeLayoutLink,
} from "../resource-graph-tree-layout";

// --- Fixture ----------------------------------------------------------------
//   idea-root ──lineage──▶ idea-child
//        │ derive               │ derive
//        ▼                      ▼
//   proposal-A             proposal-B
//        │ derive                │ derive
//        ▼                       ▼
//   task-a1 ──depends──▶ task-a2     doc-b1
//        └─ derive ──▶ doc-a1
//
//   orphan-task     (proposalUuid null)            — always visible
//   manual-proposal (no project-local source idea) — always visible
//   ghost-task      (proposalUuid points off-project: "proposal-ghost") — visible

function buildGraph(): ResourceGraphResult {
  return {
    nodes: [
      { uuid: "idea-root", type: "idea", title: "Root idea", status: "open", parentIdeaUuid: null },
      { uuid: "idea-child", type: "idea", title: "Child idea", status: "open", parentIdeaUuid: "idea-root" },
      { uuid: "proposal-A", type: "proposal", title: "Proposal Alpha", status: "draft", sourceIdeaUuids: ["idea-root"] },
      { uuid: "proposal-B", type: "proposal", title: "Proposal Beta", status: "draft", sourceIdeaUuids: ["idea-child"] },
      { uuid: "manual-proposal", type: "proposal", title: "Manual proposal", status: "draft", sourceIdeaUuids: [] },
      { uuid: "task-a1", type: "task", title: "Build the widget", status: "open", proposalUuid: "proposal-A" },
      { uuid: "task-a2", type: "task", title: "Test the widget", status: "open", proposalUuid: "proposal-A" },
      { uuid: "doc-a1", type: "document", title: "Widget design doc", status: "prd", proposalUuid: "proposal-A" },
      { uuid: "doc-b1", type: "document", title: "Beta notes", status: "prd", proposalUuid: "proposal-B" },
      { uuid: "orphan-task", type: "task", title: "Orphan widget", status: "open", proposalUuid: null },
      { uuid: "ghost-task", type: "task", title: "Ghost widget", status: "open", proposalUuid: "proposal-ghost" },
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

describe("computeSearchMatches", () => {
  it("blank or whitespace-only query returns null (not searching)", () => {
    const { nodes } = buildGraph();
    expect(computeSearchMatches(nodes, "")).toBeNull();
    expect(computeSearchMatches(nodes, "   ")).toBeNull();
    expect(computeSearchMatches(nodes, "\t\n ")).toBeNull();
  });

  it("non-blank query with zero hits returns an empty Set (not null)", () => {
    const { nodes } = buildGraph();
    const r = computeSearchMatches(nodes, "nonexistent-zzz");
    expect(r).not.toBeNull();
    expect(r).toBeInstanceOf(Set);
    expect(r!.size).toBe(0);
  });

  it("matches a case-insensitive substring on the title", () => {
    const { nodes } = buildGraph();
    // "widget" appears in several titles, in mixed case in the query.
    const r = computeSearchMatches(nodes, "WiDgEt")!;
    expect(r.has("task-a1")).toBe(true); // "Build the widget"
    expect(r.has("task-a2")).toBe(true); // "Test the widget"
    expect(r.has("doc-a1")).toBe(true); // "Widget design doc"
    expect(r.has("orphan-task")).toBe(true); // "Orphan widget"
    expect(r.has("ghost-task")).toBe(true); // "Ghost widget"
    // A title without the substring does not match.
    expect(r.has("proposal-A")).toBe(false); // "Proposal Alpha"
  });

  it("trims surrounding whitespace before matching", () => {
    const { nodes } = buildGraph();
    const r = computeSearchMatches(nodes, "  beta  ")!;
    expect(r.has("proposal-B")).toBe(true); // "Proposal Beta"
    expect(r.has("doc-b1")).toBe(true); // "Beta notes"
  });

  it("matches on title only — never on type or status text", () => {
    const { nodes } = buildGraph();
    // "task" is a node TYPE and "open"/"draft"/"prd" are status strings, but no
    // title contains them, so none must match merely on type/status.
    expect(computeSearchMatches(nodes, "task")!.size).toBe(0);
    expect(computeSearchMatches(nodes, "open")!.size).toBe(0);
    expect(computeSearchMatches(nodes, "draft")!.size).toBe(0);
    expect(computeSearchMatches(nodes, "prd")!.size).toBe(0);
    expect(computeSearchMatches(nodes, "document")!.size).toBe(0);
  });

  it("is substring, not fuzzy / subsequence", () => {
    const { nodes } = buildGraph();
    // "bld" is a subsequence of "Build" but NOT a substring → no match.
    expect(computeSearchMatches(nodes, "bld")!.has("task-a1")).toBe(false);
    // The contiguous substring DOES match.
    expect(computeSearchMatches(nodes, "buil")!.has("task-a1")).toBe(true);
  });

  it("only matches within the caller-supplied node list (type-filter exclusion)", () => {
    const { nodes } = buildGraph();
    // Caller passes the ALREADY type-filtered list. Drop all documents to
    // simulate the "document" type toggled off: a doc title can no longer match.
    const noDocs = nodes.filter((n) => n.type !== "document");
    const r = computeSearchMatches(noDocs, "widget")!;
    expect(r.has("doc-a1")).toBe(false); // filtered out before matching
    expect(r.has("task-a1")).toBe(true); // still present
  });
});

describe("expandAncestorsForMatches", () => {
  it("resolves a deep task: proposal expanded + its source idea expanded", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(g, new Set(["task-a1"]));
    expect([...r.proposalUuids].sort()).toEqual(["proposal-A"]);
    expect([...r.ideaUuids].sort()).toEqual(["idea-root"]);
  });

  it("resolves a deep document the same way (proposal + source idea)", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(g, new Set(["doc-b1"]));
    expect([...r.proposalUuids].sort()).toEqual(["proposal-B"]);
    expect([...r.ideaUuids].sort()).toEqual(["idea-child"]);
  });

  it("a proposal match adds only its first source idea, never the proposal itself", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(g, new Set(["proposal-A"]));
    expect([...r.ideaUuids].sort()).toEqual(["idea-root"]);
    expect(r.proposalUuids.size).toBe(0);
  });

  it("an idea match adds nothing (ideas are always visible)", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(g, new Set(["idea-root"]));
    expect(r.ideaUuids.size).toBe(0);
    expect(r.proposalUuids.size).toBe(0);
  });

  it("unions ancestors across multiple matches", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(g, new Set(["task-a1", "doc-b1"]));
    expect([...r.proposalUuids].sort()).toEqual(["proposal-A", "proposal-B"]);
    expect([...r.ideaUuids].sort()).toEqual(["idea-child", "idea-root"]);
  });

  it("tolerates orphan / cross-project / unknown nodes without throwing", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(
      g,
      // orphan-task (proposalUuid null), ghost-task (off-project proposal),
      // manual-proposal (no project-local source idea), and a totally unknown id.
      new Set(["orphan-task", "ghost-task", "manual-proposal", "does-not-exist"]),
    );
    expect(r.ideaUuids.size).toBe(0);
    expect(r.proposalUuids.size).toBe(0);
  });

  it("picks the first PROJECT-LOCAL source idea, skipping non-local entries", () => {
    const g: ResourceGraphResult = {
      nodes: [
        { uuid: "idea-local", type: "idea", title: "Local", status: "open", parentIdeaUuid: null },
        {
          uuid: "prop-x",
          type: "proposal",
          title: "Cross-source proposal",
          status: "draft",
          // First entry is a foreign idea not present as a node; the helper must
          // skip it and pick the project-local one (mirrors ownerOf / visible-set).
          sourceIdeaUuids: ["idea-foreign", "idea-local"],
        },
        { uuid: "task-x", type: "task", title: "X", status: "open", proposalUuid: "prop-x" },
      ],
      edges: [],
    };
    const r = expandAncestorsForMatches(g, new Set(["task-x"]));
    expect([...r.proposalUuids]).toEqual(["prop-x"]);
    expect([...r.ideaUuids]).toEqual(["idea-local"]); // not idea-foreign
  });

  it("handles the empty match set", () => {
    const g = buildGraph();
    const r = expandAncestorsForMatches(g, new Set());
    expect(r.ideaUuids.size).toBe(0);
    expect(r.proposalUuids.size).toBe(0);
  });
});

describe("orderMatchIdsByOutline", () => {
  // Build the same fully-expanded forest the layout sees, then assert the helper
  // returns matches in the REAL pre-order DFS order computeTreeLayout produces.
  function buildLayout() {
    const g = buildGraph();
    const nodes: TreeLayoutNode[] = g.nodes.map((n: ResourceGraphNode) => ({
      id: n.uuid,
      type: n.type,
      title: n.title,
      // ownerId mirrors the renderer: proposal → first source idea,
      // task/doc → its proposal (when project-local).
      ownerId:
        n.type === "proposal"
          ? (n.sourceIdeaUuids ?? [])[0]
          : n.type === "task" || n.type === "document"
            ? n.proposalUuid ?? undefined
            : undefined,
    }));
    const links: TreeLayoutLink[] = g.edges.map((e) => ({
      source: e.from,
      target: e.to,
      kind: e.kind,
    }));
    return computeTreeLayout(nodes, links);
  }

  it("returns matches in pre-order outline order, not Set insertion order", () => {
    const { outline } = buildLayout();
    const outlineIds = outline.map((o) => o.id);

    // Deliberately insert ids in an order DIFFERENT from the outline so a naive
    // Set-iteration would fail. task-a2 comes before idea-root here.
    const matchIds = new Set(["task-a2", "idea-root", "doc-a1"]);
    const ordered = orderMatchIdsByOutline(matchIds, outline);

    // The result must be a subsequence of the outline in the SAME relative order.
    const expected = outlineIds.filter((id) => matchIds.has(id));
    expect(ordered).toEqual(expected);

    // Sanity: each matched id keeps its outline relative position.
    expect(ordered.indexOf("idea-root")).toBeLessThan(ordered.indexOf("doc-a1"));
    expect(ordered.indexOf("idea-root")).toBeLessThan(ordered.indexOf("task-a2"));
  });

  it("omits match ids that are absent from the outline", () => {
    const { outline } = buildLayout();
    const ordered = orderMatchIdsByOutline(
      new Set(["idea-root", "not-laid-out"]),
      outline,
    );
    expect(ordered).toEqual(["idea-root"]);
  });

  it("returns an empty array for an empty match set", () => {
    const { outline } = buildLayout();
    expect(orderMatchIdsByOutline(new Set(), outline)).toEqual([]);
  });
});
