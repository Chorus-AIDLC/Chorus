# Design — Idea Lineage

## Context

`Idea` (prisma/schema.prisma) is currently flat with no self-relation. `computeDerivedStatus` (idea.service.ts) derives an idea's post-elaboration status purely from its own Proposals + Tasks — it has no notion of children. The tracker list (`getIdeasWithDerivedStatus` / `getTrackerGroups`) groups ideas by derived status. The decision record (elaboration rounds 1–2) fixes the shape: **single-parent forest, weak read-only rollup, one undifferentiated edge, three entry points, flat/tree dual-mode UI.**

## Data Model

```prisma
model Idea {
  // ... existing fields ...
  parentUuid String?  // self-relation: single parent (nullable = top-level)
  parent     Idea?    @relation("IdeaLineage", fields: [parentUuid], references: [uuid], onDelete: SetNull)
  children   Idea[]   @relation("IdeaLineage")

  @@index([parentUuid])
}
```

- Prisma forbids `onDelete: SetNull` on a self-relation (cyclic referential-action rule). The canonical fix is `NoAction`, but under `relationMode = "prisma"` `NoAction` is not implemented for PostgreSQL — the docs direct you to `Restrict` instead. So the relation uses `onDelete: Restrict, onUpdate: Restrict`. This is compatible with the orphan-to-top-level behavior because it is enforced **entirely in app code**: `deleteIdea` nulls children's `parentUuid` *before* deleting the parent, so by delete time no child references it and `Restrict` never fires. Covered by a delete test.
- Single `parentUuid` keeps the structure a forest. Multi-parent is explicitly deferred; the column can later be promoted to a relation table without breaking reads.

## Cycle Prevention

`setIdeaParent(ideaUuid, parentUuid)` must reject any assignment that would create a cycle. Algorithm (walk the prospective parent's ancestor chain):

```
if parentUuid == null: clear parent, return
if parentUuid == ideaUuid: reject (self-parent)
cursor = parentUuid
while cursor != null:
  if cursor == ideaUuid: reject (would form cycle — ideaUuid is an ancestor of parentUuid)
  cursor = (idea where uuid=cursor).parentUuid
accept
```

- Bounded by tree depth; each hop is a single indexed lookup on `parentUuid`. No recursion in SQL.
- Same-project constraint: parent and child must share `projectUuid` (first version). Cross-project is deferred.

## Service Contracts

| Function | Change |
|---|---|
| `createIdea(params)` | accept optional `parentUuid`; validate same-project + existence; reject if parent missing/cross-project. |
| `setIdeaParent(uuid, parentUuid, companyUuid)` | new; cycle + same-project + existence checks; emits `eventBus` change; returns updated idea. `parentUuid: null` detaches. |
| `getIdea(companyUuid, uuid)` | include `parent` (uuid, title, status) and `children[]` (uuid, title, derived status). |
| `getIdeasWithDerivedStatus(...)` | include `parentUuid` + `childCount` (direct children only, single grouped query — no N+1). |
| `getDescendantUuids(uuid, companyUuid)` | new; return the **transitive** descendant UUID set of one idea (bounded subtree walk for a single idea). Used only by the set-parent picker to disable invalid (cycle-forming) parents. Distinct from the direct-child-only *list* rollup — this is a one-idea, on-demand lookup, not a per-row list aggregate, so it does not reintroduce the N+1 the rollup decision avoided. |
| `deleteIdea(uuid)` | null `parentUuid` of all direct children before deleting (orphan-to-top-level). |

### Why a separate descendant lookup (reviewer round 1, BLOCKER 2)

Cycle prevention forbids assigning **any** descendant (not just a direct child) as a parent. The list rollup deliberately exposes only direct `children[]`/`childCount` (weak-semantic decision, avoids recursive list queries). The picker therefore needs a separate, **single-idea** transitive-descendant lookup to know which candidates to disable. This is consistent — not contradictory — with the direct-child-only rollup: the rollup is a per-row list aggregate (kept shallow to avoid N+1 across many rows); `getDescendantUuids` is an on-demand walk for exactly one idea when its picker opens. The server-side `setIdeaParent` cycle check remains the authoritative guard; the picker disabling is a UX affordance over the same truth.

`computeDerivedStatus` is **unchanged** — lineage is orthogonal to the pipeline; a parent's own status still derives only from its own proposals/tasks. Rollup is presentation-only metadata.

## Rollup query (avoid N+1)

In `getIdeasWithDerivedStatus`, after loading the project's ideas, compute child counts with one `groupBy`:

```ts
const counts = await prisma.idea.groupBy({
  by: ["parentUuid"],
  where: { projectUuid, parentUuid: { not: null } },
  _count: { _all: true },
});
// map parentUuid -> count; attach childCount to each idea
```

## MCP Surface

- `chorus_pm_create_idea`: add optional `parentUuid` to inputSchema + description.
- `chorus_pm_set_idea_parent` (new, gated `idea:write` via permission-map): `{ ideaUuid, parentUuid: string | null }`. Returns updated idea; surfaces cycle/same-project errors as tool errors.
- `chorus_get_idea`: payload includes `parent`, `children[]`.
- `chorus_get_ideas`: each idea includes `parentUuid`, `childCount`.

## REST Surface

- `POST /api/projects/[uuid]/ideas` (or existing idea-create route): accept `parentUuid`.
- `PATCH /api/ideas/[uuid]` (or a dedicated `…/parent` route): set/clear parent, returning the same errors as the service.
- Read routes echo `parentUuid` + `childCount` + (detail) `parent`/`children`.

## UI

- **Tracker list** (`getTrackerGroups` consumer): add a flat/tree segmented toggle. Flat = current status-grouped behavior. Tree = lineage-indented: roots first, direct children indented under each with a `↳` connector and reused status badges; parent rows show a `+N derived` rollup chip.
- **Idea detail panel**: a "Lineage" section — parent breadcrumb (clickable, "derived from"), a "set parent" affordance opening the picker, and a children list with status badges. A "derive" button in the header creates a child via `create_idea(parentUuid)`.
- **Set-parent modal**: searchable same-project idea picker; descendants of the current idea are disabled with a "would form a cycle" indicator; a warning line explains the constraint.
- i18n: all strings in en + zh.

## Testing

- Service unit tests (Vitest, mocked prisma): cycle rejection (self, direct, transitive), same-project enforcement, create-with-parent, delete-orphans-children, rollup childCount correctness.
- MCP tool registration: `set_idea_parent` visible only with `idea:write`.
- Playwright acceptance (local dev server): flat→tree toggle renders lineage, detail panel shows parent + children, set-parent modal blocks a descendant.

## Risks

- **Cycle bug** → infinite loop in tree render. Mitigated by service-level ancestor walk + a render-time visited set.
- **Rollup N+1** → mitigated by the single `groupBy`.
- **relationMode = "prisma"**: `onDelete: SetNull` is not DB-enforced; `deleteIdea` must null children in app code. Covered by a delete test.
