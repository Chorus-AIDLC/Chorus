// Pure computation for the project resource graph's TWO-LEVEL
// expand/collapse model.
//
// Given the full aggregation payload plus the sets of expanded Idea UUIDs
// and expanded Proposal UUIDs, returns which nodes / edges are visible and,
// for each expandable hub (Idea or Proposal), the count of direct hidden
// children (the "N" on the expand button).
//
// Design notes
// ============
//
// 1. The expand model is TWO LEVELS, matching the derivation hierarchy:
//      Idea  --(expand)-->  its Proposals        (level 1)
//      Proposal --(expand)-->  its Tasks + Docs   (level 2)
//    Expanding an Idea reveals ONLY its directly-derived Proposals — NOT
//    the proposals' tasks/documents. Each Proposal is then independently
//    expandable to reveal its own tasks + documents. (A one-click "expand
//    everything two levels deep" was the old, wrong behavior.)
//
// 2. Default = all collapsed → only Idea hubs visible. Idea→Idea lineage
//    edges are ALWAYS visible (they connect hubs and never get hidden).
//
// 3. A Proposal is visible iff at least one of its source Ideas is expanded,
//    OR it has no project-local source Idea (no collapsing parent — e.g. an
//    inputType != "idea" proposal). Such an orphan proposal stays visible.
//
// 4. A Task or Document is visible iff its source Proposal is visible AND
//    that Proposal is expanded (level 2), OR it has no proposal (manually
//    created — no collapsing parent, always visible).
//
// 5. The aggregation's ROOT-TASKS-ONLY rule for proposal→task derive edges
//    means a non-root task has NO direct proposal-derive edge — it's reached
//    only through the depends chain. So Task/Document visibility is driven by
//    the node's `proposalUuid` field (the source of truth), NOT by which
//    tasks happen to have a direct derive edge.
//
// 6. Edges are visible iff BOTH endpoints are visible.
//
// 7. Child counts (shown on the expand button of a collapsed hub):
//      - Idea: number of direct project-local Proposals (sourceIdeaUuids).
//      - Proposal: number of Tasks + Documents whose proposalUuid is this
//        proposal.

import type {
  ResourceGraphNode,
  ResourceGraphEdge,
  ResourceGraphResult,
} from "@/services/resource-graph.service";

export interface VisibleSet {
  /** UUIDs of nodes that should render given the current expanded sets. */
  visibleNodeUuids: Set<string>;
  /** Indices into the input edges array that should render. */
  visibleEdgeIndices: number[];
  /**
   * Per-hub direct-child count, keyed by hub UUID. Idea → proposal count;
   * Proposal → (task + document) count. Used by the "N" on the expand
   * button + to decide whether a hub shows an expand affordance at all.
   */
  childCountByHub: Map<string, number>;
}

/**
 * Compute the visible set of nodes/edges and the per-hub child count for the
 * two-level resource graph expand model.
 *
 * @param graph The full aggregation payload (every node + edge).
 * @param expandedIdeas Set of Idea UUIDs currently expanded (reveals their
 *   Proposals). Default empty = every Idea collapsed (only Idea hubs visible).
 * @param expandedProposals Set of Proposal UUIDs currently expanded (reveals
 *   their Tasks + Documents). A Proposal only matters here once it is itself
 *   visible (i.e. its parent Idea is expanded).
 */
export function computeVisibleSet(
  graph: ResourceGraphResult,
  expandedIdeas: ReadonlySet<string>,
  expandedProposals: ReadonlySet<string>,
): VisibleSet {
  const { nodes, edges } = graph;

  const ideaUuidSet = new Set<string>();
  const proposalsByUuid = new Map<string, ResourceGraphNode>();
  const tasksAndDocs: ResourceGraphNode[] = [];

  for (const n of nodes) {
    if (n.type === "idea") {
      ideaUuidSet.add(n.uuid);
    } else if (n.type === "proposal") {
      proposalsByUuid.set(n.uuid, n);
    } else {
      tasksAndDocs.push(n);
    }
  }

  // --- 1. Child counts per hub ---------------------------------------------
  const childCountByHub = new Map<string, number>();
  for (const ideaUuid of ideaUuidSet) childCountByHub.set(ideaUuid, 0);
  for (const proposalUuid of proposalsByUuid.keys()) {
    childCountByHub.set(proposalUuid, 0);
  }
  // Idea → direct proposal count.
  for (const proposal of proposalsByUuid.values()) {
    for (const ideaUuid of proposal.sourceIdeaUuids ?? []) {
      if (!ideaUuidSet.has(ideaUuid)) continue;
      childCountByHub.set(ideaUuid, (childCountByHub.get(ideaUuid) ?? 0) + 1);
    }
  }
  // Proposal → (task + document) count.
  for (const td of tasksAndDocs) {
    const proposalUuid = td.proposalUuid ?? null;
    if (proposalUuid !== null && proposalsByUuid.has(proposalUuid)) {
      childCountByHub.set(
        proposalUuid,
        (childCountByHub.get(proposalUuid) ?? 0) + 1,
      );
    }
  }

  // --- 2. Visible nodes -----------------------------------------------------
  // Ideas are always visible.
  const visibleNodeUuids = new Set<string>(ideaUuidSet);

  // Level 1: Proposals — visible iff a source Idea is expanded, or no
  // project-local source Idea (orphan, no collapsing parent).
  const visibleProposalUuids = new Set<string>();
  for (const proposal of proposalsByUuid.values()) {
    const sources = (proposal.sourceIdeaUuids ?? []).filter((u) =>
      ideaUuidSet.has(u),
    );
    const shouldShow =
      sources.length === 0 || sources.some((u) => expandedIdeas.has(u));
    if (shouldShow) {
      visibleProposalUuids.add(proposal.uuid);
      visibleNodeUuids.add(proposal.uuid);
    }
  }

  // Level 2: Tasks / Documents — visible iff their Proposal is visible AND
  // expanded, or they have no proposal (orphan, always visible).
  for (const td of tasksAndDocs) {
    const proposalUuid = td.proposalUuid ?? null;
    if (proposalUuid === null || !proposalsByUuid.has(proposalUuid)) {
      // No project-local collapsing parent — always visible.
      visibleNodeUuids.add(td.uuid);
      continue;
    }
    if (
      visibleProposalUuids.has(proposalUuid) &&
      expandedProposals.has(proposalUuid)
    ) {
      visibleNodeUuids.add(td.uuid);
    }
  }

  // --- 3. Visible edges -----------------------------------------------------
  const visibleEdgeIndices: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (visibleNodeUuids.has(e.from) && visibleNodeUuids.has(e.to)) {
      visibleEdgeIndices.push(i);
    }
  }

  return { visibleNodeUuids, visibleEdgeIndices, childCountByHub };
}

// Re-export the edge type so test files don't need to dual-import.
export type { ResourceGraphEdge };
