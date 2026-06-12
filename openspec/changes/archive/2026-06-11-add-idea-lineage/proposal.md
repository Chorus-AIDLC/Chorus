# Idea Lineage — Single-Parent Derivation Hierarchy

## Why

Today an `Idea` is flat: it belongs to one Project, runs elaboration, then spawns Proposals → Documents + Tasks. There is no idea-to-idea relationship. In practice requirements are not isolated — discussing one idea spawns new directions (derivation), and a large idea is often broken into smaller ones (containment). Users need to see and navigate that lineage without the platform forcing a rigid classification.

This change adds a **single-parent lineage** between ideas: derive a new child idea from a parent, or attach an existing idea under a parent. The relationship is deliberately **weak** — a parent aggregates a read-only rollup of its direct children, but never blocks or alters any idea's own elaboration/proposal/task flow.

## What Changes

- **Data model**: add `Idea.parentUuid` self-relation (nullable) + index. Single parent → the idea graph is a forest.
- **One undifferentiated edge**: no `type` field separating "derivation" vs "containment" — the semantics are carried by context, matching the decision that real-world lineage is too messy to force-classify.
- **Three derivation entry points**:
  1. `chorus_pm_create_idea` gains an optional `parentUuid` (covers detail-page derive + elaboration/brainstorm split-out).
  2. New `chorus_pm_set_idea_parent({ ideaUuid, parentUuid | null })` with cycle prevention (covers after-the-fact attach + detach).
  3. REST + UI affordances wired to the above.
- **Read-only rollup**: `chorus_get_idea` returns `parent` + `children[]`; `chorus_get_ideas` returns `parentUuid` per idea plus a `childCount` rollup of **direct children only**.
- **Tracker UI — flat/tree dual mode**: default flat list; a "group by lineage" toggle switches to a blood-lineage indented view (full idea rows, `↳` derivation connector, `+N derived` rollup chip — **not** a folder-tree metaphor).
- **Idea detail — lineage section**: parent breadcrumb ("derived from …"), a "set parent" picker affordance with cycle prevention, and a direct-children list with status badges.
- **Delete behavior**: deleting a parent nulls its children's `parentUuid` (children survive as top-level), consistent with the weak-ownership semantics.

## Capabilities

- `idea-lineage` (new): the parent/child relation, the three entry points, cycle prevention, weak rollup, and the dual-mode tracker + detail UI.

## Impact

- **Schema**: one nullable column + one index on the existing `Idea` model. No data migration (DDL only).
- **Service layer**: `idea.service.ts` — `createIdea` accepts `parentUuid`; new `setIdeaParent` with ancestor-chain cycle detection; `getIdea` includes parent + children; `getIdeasWithDerivedStatus` includes `parentUuid` + `childCount`; `deleteIdea` nulls children.
- **MCP**: `chorus_pm_create_idea` param add; new `chorus_pm_set_idea_parent` (gated `idea:write`); enriched read payloads. Docs in `MCP_TOOLS.md` + skill files.
- **REST**: `POST/PATCH` idea routes accept `parentUuid`; a parent-setting endpoint.
- **UI**: idea tracker list (flat/tree toggle), idea detail panel (lineage section), set-parent modal with same-project + cycle constraints. i18n en/zh. `design.pen` already updated.
- **Out of scope (deferred)**: multi-parent/graph, cross-project parent-child, drag-to-reparent, `move_idea` cascade, strong status linkage, recursive rollup.
