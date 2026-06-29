// Pure computation for the project resource graph's per-Idea
// expand/collapse model.
//
// Given the full aggregation payload plus the set of expanded Idea UUIDs,
// returns which nodes / edges are visible and, for each Idea, the count of
// direct hidden derivatives (the "N ›" pill).
//
// Design notes
// ============
//
// 1. Default = all Ideas collapsed → only Idea hubs visible. Idea→Idea
//    lineage edges are ALWAYS visible (they connect hubs and never get
//    hidden by the collapse model).
//
// 2. A Proposal is visible iff at least one of its source Ideas is expanded.
//    A Proposal with no project-local source Ideas (e.g. an inputType !=
//    "idea" proposal, or one whose Ideas live in a different project) is
//    treated as having NO collapsing parent and stays visible at all times
//    — otherwise an orphan proposal would never be reachable.
//
// 3. A Task or Document is visible iff its source Proposal is visible.
//    Tasks/Documents with no proposal (manually created) are not tied to
//    any Idea hub and stay visible at all times.
//
// 4. The aggregation's ROOT-TASKS-ONLY rule for proposal→task derive edges
//    means a non-root task has NO direct proposal-derive edge — it's
//    reached only through the depends chain within the same proposal. The
//    visible-set logic must therefore include EVERY task whose
//    proposalUuid points at a visible proposal (NOT just the ones with a
//    direct derive edge from that proposal). Consume the node's
//    proposalUuid field — it's the source of truth.
//
// 5. Edges are visible iff BOTH endpoints are visible. Lineage edges are
//    exempt — they connect Ideas, which are always visible, so the rule
//    reduces to the same check.
//
// 6. The "N" derivative count for a collapsed Idea is the number of
//    DIRECT derivatives: project-local Proposals that list this Idea in
//    their sourceIdeaUuids. The spec scenario phrases it as "a count of
//    its hidden direct derivatives", and the design.pen mock shows small
//    counts that line up with proposal counts (e.g. "2 ›"). Tasks /
//    Documents are reached transitively through the proposal hub and are
//    not counted here.

import type {
  ResourceGraphNode,
  ResourceGraphEdge,
  ResourceGraphResult,
} from "@/services/resource-graph.service";

export interface VisibleSet {
  /** UUIDs of nodes that should render given the current expanded-ideas set. */
  visibleNodeUuids: Set<string>;
  /** Indices into the input edges array that should render. */
  visibleEdgeIndices: number[];
  /** Per-Idea direct-derivative count (used by the "N ›" pill). */
  derivativeCountByIdea: Map<string, number>;
}

/**
 * Compute the visible set of nodes/edges and the per-Idea derivative count
 * for the resource graph.
 *
 * @param graph The full aggregation payload (every node + edge).
 * @param expandedIdeas Set of Idea UUIDs currently expanded. Default empty
 *   = every Idea is collapsed (only Idea hubs visible).
 */
export function computeVisibleSet(
  graph: ResourceGraphResult,
  expandedIdeas: ReadonlySet<string>,
): VisibleSet {
  const { nodes, edges } = graph;

  // Bucket nodes by type once so the rest of the function is linear in the
  // node count.
  const ideaUuidSet = new Set<string>();
  const proposalsByUuid = new Map<string, ResourceGraphNode>();
  const tasksAndDocs: ResourceGraphNode[] = [];

  for (const n of nodes) {
    if (n.type === "idea") {
      ideaUuidSet.add(n.uuid);
    } else if (n.type === "proposal") {
      proposalsByUuid.set(n.uuid, n);
    } else {
      // task | document
      tasksAndDocs.push(n);
    }
  }

  // --- 1. Direct-derivative count per Idea ----------------------------------
  // Direct derivative = a Proposal that lists this Idea in its
  // sourceIdeaUuids (post-aggregation, these are already filtered to
  // project-local ideas in resource-graph.service.ts).
  const derivativeCountByIdea = new Map<string, number>();
  for (const ideaUuid of ideaUuidSet) {
    derivativeCountByIdea.set(ideaUuid, 0);
  }
  for (const proposal of proposalsByUuid.values()) {
    const sources = proposal.sourceIdeaUuids ?? [];
    for (const ideaUuid of sources) {
      if (!ideaUuidSet.has(ideaUuid)) continue;
      derivativeCountByIdea.set(
        ideaUuid,
        (derivativeCountByIdea.get(ideaUuid) ?? 0) + 1,
      );
    }
  }

  // --- 2. Visible nodes -----------------------------------------------------
  // Ideas are always visible. A Proposal is visible iff at least one of its
  // source ideas is expanded, OR it has no project-local source ideas (no
  // collapsing parent). A Task/Document is visible iff its source Proposal
  // is visible, OR it has no proposal (manually created — no collapsing
  // parent).
  const visibleNodeUuids = new Set<string>(ideaUuidSet);

  const visibleProposalUuids = new Set<string>();
  for (const proposal of proposalsByUuid.values()) {
    const sources = (proposal.sourceIdeaUuids ?? []).filter((u) =>
      ideaUuidSet.has(u),
    );
    let shouldShow: boolean;
    if (sources.length === 0) {
      // No collapsing parent — always visible.
      shouldShow = true;
    } else {
      // Visible iff at least one source is expanded.
      shouldShow = sources.some((u) => expandedIdeas.has(u));
    }
    if (shouldShow) {
      visibleProposalUuids.add(proposal.uuid);
      visibleNodeUuids.add(proposal.uuid);
    }
  }

  for (const td of tasksAndDocs) {
    const proposalUuid = td.proposalUuid ?? null;
    if (proposalUuid === null) {
      // No source proposal — always visible.
      visibleNodeUuids.add(td.uuid);
      continue;
    }
    if (!proposalsByUuid.has(proposalUuid)) {
      // Proposal isn't in this project; the task/doc is an orphan w.r.t.
      // the collapse model — always visible.
      visibleNodeUuids.add(td.uuid);
      continue;
    }
    if (visibleProposalUuids.has(proposalUuid)) {
      visibleNodeUuids.add(td.uuid);
    }
  }

  // --- 3. Visible edges -----------------------------------------------------
  // An edge is visible iff BOTH endpoints are visible. Lineage edges fall
  // out of this rule naturally (Ideas are always visible) but are listed
  // here explicitly for clarity.
  const visibleEdgeIndices: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (visibleNodeUuids.has(e.from) && visibleNodeUuids.has(e.to)) {
      visibleEdgeIndices.push(i);
    }
  }

  return { visibleNodeUuids, visibleEdgeIndices, derivativeCountByIdea };
}

// Re-export the edge type so test files don't need to dual-import.
export type { ResourceGraphEdge };
