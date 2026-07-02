// Pure, side-effect-free helpers for the resource-graph mind-map's NODE SEARCH
// feature. Framework-free (no React, no canvas) so they unit-test in isolation,
// mirroring resource-graph-visible-set.ts and resource-graph-tree-layout.ts.
//
// Design notes (Tech Design D1 / D2)
// ==================================
//
// 1. MATCH SET (D1). `computeSearchMatches(nodes, query)` returns the ids of
//    nodes whose lowercased `title` contains the lowercased, trimmed `query`
//    as a SUBSTRING (not fuzzy, not subsequence; title only — never type or
//    status text). It distinguishes two empty states the caller treats
//    differently downstream:
//      - a blank / whitespace-only query → `null`  ("not searching": no dim)
//      - a non-blank query with zero hits → empty `Set` ("no matches" hint)
//    Matching is done over the caller-supplied node list. The caller passes the
//    ALREADY type-filtered nodes (the same `visibleNodes` it hands the
//    renderer), so a filtered-out type can never produce a match (Q7=a). This
//    helper is intentionally agnostic about WHICH list it receives — the
//    type-filter policy lives in the component, not here.
//
// 2. AUTO-EXPAND-TO-REVEAL (D2). `expandAncestorsForMatches(graph, matchIds)`
//    returns the ancestor hubs that must be expanded for every match to become
//    visible, as `{ ideaUuids, proposalUuids }`. The caller UNIONS these into
//    its live `expandedIdeas` / `expandedProposals` Sets so the existing
//    visible-set → tree-layout → tween pipeline reveals the matches. Ancestor
//    resolution mirrors `computeVisibleSet` (resource-graph-visible-set.ts) and
//    the renderer's `ownerOf` (resource-graph.tsx) EXACTLY:
//      - task / document → its source Proposal must be expanded (level 2) AND
//        that proposal's first PROJECT-LOCAL source Idea expanded (level 1);
//      - proposal        → its first project-local source Idea expanded
//        (a proposal needs its parent Idea open to be visible; it does NOT need
//        itself expanded — that only reveals ITS children);
//      - idea            → ideas are always visible; nothing to add.
//    Orphans (a task/document whose `proposalUuid` is null or points outside
//    the project, a proposal with no project-local source idea, an id not in
//    the graph at all) have no collapsing parent — they are already visible, so
//    they contribute nothing and never throw.
//
// 3. ORDERING (D1). Prev/next navigation steps through matches in PRE-ORDER DFS
//    OUTLINE order — the order `computeTreeLayout(...).outline` produces, which
//    is also the mobile outline's top-to-bottom render order and the canvas's
//    visual reading order — so "next" feels spatial, not random. `Set` iteration
//    order is insertion order (not spatial), so callers MUST derive the ordered
//    match list from the outline. `orderMatchIdsByOutline(matchIds, outline)`
//    does this: it walks the outline once and keeps the entries that are in the
//    match set, preserving outline order. (Each id appears exactly once in a
//    pre-order DFS outline, so the result needs no de-duplication.)

import type {
  ResourceGraphNode,
  ResourceGraphResult,
} from "@/services/resource-graph.service";

/**
 * Compute the set of node ids whose title matches the query as a
 * case-insensitive substring.
 *
 * @param nodes The nodes to search — the caller passes its ALREADY
 *   type-filtered node list (so a filtered-out type can never match). Only
 *   `uuid` + `title` are read, so any node-like value works.
 * @param query The raw search query (untrimmed). Whitespace is trimmed before
 *   matching.
 * @returns `null` when the query is blank/whitespace-only ("not searching");
 *   otherwise a `Set` of matching node ids — empty when nothing matched.
 */
export function computeSearchMatches(
  nodes: readonly Pick<ResourceGraphNode, "uuid" | "title">[],
  query: string,
): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null; // not searching — distinct from "zero hits"

  const matches = new Set<string>();
  for (const n of nodes) {
    if (n.title.toLowerCase().includes(needle)) {
      matches.add(n.uuid);
    }
  }
  return matches; // possibly empty — "searched, zero hits"
}

/** The ancestor hubs that must be expanded to reveal a set of matches. */
export interface MatchAncestors {
  /** Idea UUIDs to add to `expandedIdeas` (level-1 reveal). */
  ideaUuids: Set<string>;
  /** Proposal UUIDs to add to `expandedProposals` (level-2 reveal). */
  proposalUuids: Set<string>;
}

/**
 * Resolve the ancestor ideas/proposals that must be expanded for every match to
 * be visible under the two-level expand model. Add-only by design — the caller
 * unions the result into its live expand sets and never removes a user's manual
 * expansion mid-search.
 *
 * Resolution mirrors `computeVisibleSet` / the renderer's `ownerOf` (see module
 * note 2). Tolerates ids absent from the graph and orphan nodes (no proposal /
 * no project-local source idea) without throwing — they are already visible and
 * contribute nothing.
 *
 * @param graph The FULL aggregation payload (matches may be hidden under
 *   collapsed hubs, so the ancestor chain must be resolved from the whole graph,
 *   not just the currently-visible nodes).
 * @param matchIds The ids returned by {@link computeSearchMatches}.
 */
export function expandAncestorsForMatches(
  graph: ResourceGraphResult,
  matchIds: ReadonlySet<string>,
): MatchAncestors {
  const ideaUuids = new Set<string>();
  const proposalUuids = new Set<string>();

  // Index the graph once: ids of Idea nodes (so "project-local source idea"
  // means "a source idea that is actually an Idea node here"), the Proposal
  // nodes by uuid, and every node by uuid for match→node lookup.
  const ideaUuidSet = new Set<string>();
  const proposalsByUuid = new Map<string, ResourceGraphNode>();
  const nodeByUuid = new Map<string, ResourceGraphNode>();
  for (const n of graph.nodes) {
    nodeByUuid.set(n.uuid, n);
    if (n.type === "idea") ideaUuidSet.add(n.uuid);
    else if (n.type === "proposal") proposalsByUuid.set(n.uuid, n);
  }

  // First project-local source idea of a proposal — the same selection the
  // renderer's `ownerOf` and `computeVisibleSet` use to decide the proposal's
  // collapsing parent. `undefined` for an orphan/manual proposal (no parent).
  const firstSourceIdeaOf = (
    proposal: ResourceGraphNode,
  ): string | undefined =>
    (proposal.sourceIdeaUuids ?? []).find((u) => ideaUuidSet.has(u));

  for (const id of matchIds) {
    const node = nodeByUuid.get(id);
    if (node === undefined) continue; // id not in the graph — tolerate

    if (node.type === "idea") {
      // Ideas are always visible — nothing to expand.
      continue;
    }

    if (node.type === "proposal") {
      // A proposal is visible once its parent Idea is expanded; it does NOT need
      // to be expanded itself (that reveals ITS children, not the proposal).
      const ideaUuid = firstSourceIdeaOf(node);
      if (ideaUuid !== undefined) ideaUuids.add(ideaUuid);
      continue;
    }

    // task / document: needs its proposal expanded (level 2) AND that
    // proposal's parent idea expanded (level 1).
    const proposalUuid = node.proposalUuid ?? null;
    if (proposalUuid === null) continue; // orphan — already visible
    const proposal = proposalsByUuid.get(proposalUuid);
    if (proposal === undefined) continue; // proposal not project-local — visible
    proposalUuids.add(proposalUuid);
    const ideaUuid = firstSourceIdeaOf(proposal);
    if (ideaUuid !== undefined) ideaUuids.add(ideaUuid);
  }

  return { ideaUuids, proposalUuids };
}

/**
 * Order a match set by pre-order DFS outline order for prev/next navigation.
 *
 * Walks the outline once (the `computeTreeLayout(...).outline` array, or any
 * `{ id }[]` in that order) and keeps the entries present in `matchIds`,
 * preserving outline order so "next" steps top-to-bottom / left-to-right rather
 * than in `Set` insertion order. A match id absent from the outline (e.g. a
 * node that is not currently laid out) is omitted.
 *
 * @param matchIds The match set from {@link computeSearchMatches}.
 * @param outline The pre-order DFS outline (only `id` is read).
 * @returns The matching ids in outline order.
 */
export function orderMatchIdsByOutline(
  matchIds: ReadonlySet<string>,
  outline: readonly { id: string }[],
): string[] {
  const ordered: string[] = [];
  for (const entry of outline) {
    if (matchIds.has(entry.id)) ordered.push(entry.id);
  }
  return ordered;
}
