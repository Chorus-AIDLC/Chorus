## Context

`getIdeasWithDerivedStatus()` currently computes base statuses, groups those base values by parent, and then rolls containers up in result order. Because the grouped values are snapshots, a parent container never observes the later rolled-up value of a child container. The detail path reads direct children after project aggregation, producing inconsistent tracker and panel results.

Constraints are to preserve direct-child progress semantics, avoid per-Idea database reads, and tolerate malformed lineage defensively.

## Goals / Non-Goals

**Goals:**

- Produce deterministic leaf-to-root container status aggregation at arbitrary depth.
- Ensure each container's progress counts only direct children.
- Reuse the existing batched Idea, Proposal, Task, child-count, and reference-count queries.
- Terminate safely for missing-parent edges and accidental cycles.

**Non-Goals:**

- Flattening descendant counts into `childProgress`.
- Changing stored Idea status, lineage validation, or API response shapes.
- Adding database queries or migrations.

## Decisions

### Resolve container status with a memoized lineage walk

Build an in-memory UUID index and direct-child adjacency map from the already fetched results. Resolve each node through a memoized depth-first walk: resolve direct children first, then roll a container from those final child statuses. Track nodes currently being visited so a back-edge terminates at the affected node's base status instead of recurring forever.

This is preferred over sorting by computed depth because malformed cycles make depth undefined. It is preferred over repeated fixed-point passes because the memoized walk is linear for valid forests.

### Normalize every cyclic component before rollup

Before resolving containers, identify strongly connected components in the in-project lineage graph. Any component with more than one node, or a self-loop, is cyclic. Mark every member of that component as resolved at its own immutable proposal/task-derived base status. The normal leaf-to-root resolver then treats those values as stable inputs, allowing non-cycle ancestors to aggregate deterministically.

Applying the fallback to the whole strongly connected component is preferred over cutting whichever back-edge a DFS encounters first, because the latter changes memoized results when database order changes.

### Preserve base status as the fallback

Keep each Idea's proposal/task-derived base status available during the walk. A childless container, a node whose parent is missing, or a member of a cyclic component retains that base status unless valid direct children outside the cyclic component can be safely aggregated by an ancestor.

### Keep direct-child progress

Each container calls `rollupThemeDerivedStatus()` with only the final statuses of entries in its direct-child adjacency list. Descendant completion influences ancestors through each intermediate container's final status, not by flattening descendants.

## Risks / Trade-offs

- **Cycle participants can have no mathematically unique rollup** → Detect the complete strongly connected component and retain every member's base status; prove results are unchanged across input-order permutations.
- **Mutable result objects can obscure base values** → Store immutable base status/badge values separately or return resolved values from the memoized function before applying them.
- **Tracker/detail drift can reappear through separate assumptions** → Cover the service result and real tracker integration with the same nested fixtures.

## Migration Plan

Deploy as an application-only change with no data migration. Rollback is the previous application image; stored data is unchanged.

## Open Questions

None.
