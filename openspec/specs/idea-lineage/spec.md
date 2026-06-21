# idea-lineage Specification

## Purpose
TBD - created by archiving change add-idea-lineage. Update Purpose after archive.
## Requirements
### Requirement: Single-Parent Lineage Relation

An Idea SHALL have an optional single parent Idea, recorded as a nullable `parentUuid` self-relation. An Idea with no parent is a top-level idea. The resulting structure across a project is a forest (each idea has at most one parent). The relation SHALL NOT distinguish "derivation" from "containment" — it is one undifferentiated edge whose meaning is carried by context.

#### Scenario: Top-level idea has no parent

- **WHEN** an idea is created without a `parentUuid`
- **THEN** its `parentUuid` is null and it appears as a root in the lineage forest

#### Scenario: Parent and child must share a project

- **WHEN** a caller attempts to set a parent that belongs to a different project than the child
- **THEN** the operation is rejected with a same-project constraint error

### Requirement: Weak Semantics — Lineage Does Not Alter Pipeline

The lineage relation SHALL be weak: it MUST NOT block, gate, or alter any idea's own elaboration, proposal, or task flow. A parent idea SHALL remain a full first-class idea regardless of whether it has children — it MAY have its own content, proposals, and tasks. An idea's derived status SHALL continue to be computed solely from its own proposals and tasks, never from its children.

#### Scenario: Parent keeps its own pipeline

- **WHEN** an idea that has children also has its own proposal and tasks
- **THEN** the parent's derived status reflects only its own proposals and tasks, and is never blocked by incomplete children

#### Scenario: Child elaboration is independent

- **WHEN** a child idea runs its own elaboration and proposal
- **THEN** the parent's elaboration/proposal state is unaffected

### Requirement: Derivation Entry Points

The system SHALL support three ways to establish lineage: (1) creating a new idea with a `parentUuid`, (2) attaching an existing idea to a parent after the fact, and (3) detaching an idea from its parent. Entry points (2) and (3) SHALL be exposed through a single `chorus_pm_set_idea_parent` MCP tool that accepts `parentUuid: string | null`, gated by the `idea:write` permission.

#### Scenario: Derive a child at creation time

- **WHEN** `chorus_pm_create_idea` is called with a valid same-project `parentUuid`
- **THEN** the new idea is created with that parent set

#### Scenario: Attach an existing idea after the fact

- **WHEN** `chorus_pm_set_idea_parent` is called with an `ideaUuid` and a valid `parentUuid`
- **THEN** the idea's `parentUuid` is updated to the given parent

#### Scenario: Detach an idea from its parent

- **WHEN** `chorus_pm_set_idea_parent` is called with `parentUuid: null`
- **THEN** the idea becomes top-level (its `parentUuid` is cleared)

### Requirement: Cycle Prevention

Setting a parent SHALL reject any assignment that would create a cycle in the lineage forest. An idea SHALL NOT be its own parent, and an idea SHALL NOT be assigned a parent that is itself a descendant of the idea. Cycle detection SHALL walk the prospective parent's ancestor chain.

#### Scenario: Reject self as parent

- **WHEN** a caller sets an idea's parent to itself
- **THEN** the operation is rejected with a cycle error

#### Scenario: Reject a descendant as parent

- **WHEN** a caller sets idea A's parent to idea B, where B is a descendant of A
- **THEN** the operation is rejected with a cycle error

### Requirement: Read-Only Direct-Child Rollup

The system SHALL expose a read-only rollup of an idea's **direct** children only (not the recursive subtree). `chorus_get_idea` SHALL return the idea's `parent` and `children[]`. `chorus_get_ideas` SHALL return `parentUuid` and a `childCount` of direct children for each idea. The rollup SHALL be computed without per-idea N+1 queries.

The system MAY additionally provide an on-demand transitive-descendant lookup for a **single** idea, used only to support cycle-aware UI affordances (see "Idea Detail Lineage Section"). This single-idea lookup is distinct from the direct-child list rollup and does not change the rollup's direct-children-only semantics.

The stored single-parent edge SHALL additionally be carried on the lightweight idea-read surfaces so an agent's view of lineage is consistent across discovery and tracker tools without a follow-up `chorus_get_idea` round-trip. Specifically, `chorus_get_available_ideas`, `chorus_get_my_assignments`, and the `ideaTracker` of `chorus_checkin` SHALL each include `parentUuid` (the stored edge, or `null` for a top-level idea) on every idea entry. These lightweight surfaces SHALL carry the `parentUuid` field **only** — they SHALL NOT include the `childCount` rollup or the parent title, which remain exclusive to `chorus_get_ideas` / `chorus_get_idea`. Adding `parentUuid` to these surfaces SHALL NOT introduce additional database queries — it rides along in the existing idea `select` projection. `chorus_search` idea hits SHALL NOT be modified, because the search result type is generic across all entity types.

#### Scenario: Detail view returns parent and children

- **WHEN** `chorus_get_idea` is called for an idea with a parent and two children
- **THEN** the response includes the parent reference and a `children[]` array of length 2

#### Scenario: List view returns child counts

- **WHEN** `chorus_get_ideas` is called for a project
- **THEN** each idea includes its `parentUuid` and a `childCount` equal to its number of direct children

#### Scenario: Available-ideas discovery surface carries the parent edge

- **WHEN** `chorus_get_available_ideas` is called for a project that has a claimable idea whose `parentUuid` points at another idea
- **THEN** that idea's entry includes `parentUuid` equal to the stored parent edge
- **AND** a claimable top-level idea's entry includes `parentUuid` equal to `null`
- **AND** no entry includes a `childCount` field

#### Scenario: Tracker surfaces carry the parent edge

- **WHEN** `chorus_get_my_assignments` or `chorus_checkin` is called and the agent's tracker includes an idea whose `parentUuid` points at another idea
- **THEN** that idea's tracker entry includes `parentUuid` equal to the stored parent edge
- **AND** a tracked top-level idea's entry includes `parentUuid` equal to `null`
- **AND** the entry does not include a `childCount` field

#### Scenario: Lightweight surfaces add no extra queries and no rollup

- **WHEN** `chorus_get_available_ideas`, `chorus_get_my_assignments`, or `chorus_checkin` builds its idea payload
- **THEN** `parentUuid` is sourced from the existing idea `select` projection with no additional per-idea query
- **AND** neither `childCount` nor a parent title is computed for these surfaces

#### Scenario: Search results are left unchanged

- **WHEN** `chorus_search` returns idea hits
- **THEN** the idea hit shape is unchanged and does not gain a `parentUuid` field

### Requirement: Delete Orphans Children To Top-Level

When an idea that has children is deleted, its direct children SHALL survive with their `parentUuid` set to null (becoming top-level). Deletion SHALL NOT cascade to children.

#### Scenario: Deleting a parent preserves children

- **WHEN** an idea with two children is deleted
- **THEN** both children still exist and their `parentUuid` is null

### Requirement: Tracker Flat/Tree Dual-Mode View

The idea tracker SHALL default to a flat list and SHALL offer a toggle to a lineage-grouped (tree) view. The tree view SHALL render each idea as a full idea row (reusing the existing status badge), indent direct children under their parent with a derivation connector, and show a `+N derived` rollup chip on rows that have children. The tree view SHALL NOT use a folder/file metaphor.

#### Scenario: Default flat view

- **WHEN** a user opens the idea tracker without toggling
- **THEN** ideas are shown in the existing flat, status-grouped list

#### Scenario: Toggle to lineage tree view

- **WHEN** a user enables the "group by lineage" toggle
- **THEN** ideas are shown indented by parent/child with derivation connectors and `+N derived` rollup chips

### Requirement: Idea Detail Lineage Section

The idea detail view SHALL show a lineage section containing: a parent breadcrumb when the idea has a parent, an affordance to set or change the parent (opening a picker), and a list of the idea's direct children with their status badges. The detail header SHALL offer a "derive" action that creates a child idea under the current idea.

#### Scenario: Show parent breadcrumb and children

- **WHEN** a user opens an idea that has a parent and children
- **THEN** the detail view shows the parent breadcrumb and the children list

#### Scenario: Set-parent picker blocks descendants

- **WHEN** a user opens the set-parent picker for an idea
- **THEN** the picker uses the idea's transitive-descendant set to disable every descendant (direct and indirect) with an indicator that selecting it would form a cycle

#### Scenario: Server rejects a cycle even if the picker is bypassed

- **WHEN** a set-parent request names a descendant as the parent despite the UI affordance
- **THEN** the server-side cycle check rejects it, so no cyclic lineage can be persisted

### Requirement: Set-Parent Picker Is Scrollable And Bounded

The set-parent picker's candidate list SHALL be vertically scrollable through its full
length regardless of the number of candidates, and SHALL NOT clip or hide candidates that
fall beyond the visible height. The picker SHALL rely on a single scroll container for the
candidate list — it SHALL NOT nest a second scroll region inside the command list's own
scroll region.

#### Scenario: All candidates are reachable by scrolling

- **WHEN** a project has more candidate ideas than fit in the picker's visible height
- **THEN** the candidate list scrolls vertically to reveal every candidate down to the last one
- **AND** the last candidate can be selected

#### Scenario: No nested scroll region

- **WHEN** the set-parent picker renders its candidate list
- **THEN** the candidate list is scrolled by the command list's own overflow container
- **AND** there is no additional nested scroll-area wrapper around the candidate rows

### Requirement: Lineage Rows Truncate Long Titles Without Overflow

Lineage rows SHALL keep an arbitrarily long idea title within their container's width on
every surface that renders a title alongside a fixed-width affordance — the set-parent
picker candidate rows and the idea-detail parent breadcrumb. The title SHALL truncate with
an ellipsis, the adjacent affordance (the would-cycle badge, the derivation icon/label)
SHALL remain fully visible and aligned, and no such row SHALL cause horizontal overflow of
its dialog or panel, including at the minimum dialog width.

#### Scenario: Long candidate title truncates inside the picker

- **WHEN** the set-parent picker lists a candidate whose title is far wider than the dialog
- **THEN** the candidate's title is truncated with an ellipsis
- **AND** the row does not extend beyond the dialog's content boundary
- **AND** the "would form a cycle" badge on a blocked candidate stays fully visible and right-aligned

#### Scenario: Long parent title truncates in the breadcrumb

- **WHEN** the idea detail view shows a parent breadcrumb whose parent title is very long
- **THEN** the parent title is truncated with an ellipsis
- **AND** the derivation icon and "derived from" label remain visible
- **AND** the breadcrumb row does not overflow the detail panel

### Requirement: Lineage Tree View Groups Unrelated Trees

The dashboard Lineage view SHALL visually separate distinct top-level lineage trees from
one another so that each blood-related cluster reads as one group. The separation between
two unrelated top-level trees SHALL be visually stronger than the separator between a
parent and its child within the same tree. Rows within a single tree SHALL remain visually
contiguous (the existing tight separator and indentation), and the change SHALL NOT alter
the depth-first ordering or indentation of the forest.

#### Scenario: Gap between unrelated top-level trees

- **WHEN** the Lineage view renders two or more top-level trees
- **THEN** a larger vertical gap separates the start of each top-level tree after the first
- **AND** rows inside a single tree remain separated only by the tight in-tree separator

#### Scenario: Single tree is not split

- **WHEN** the Lineage view renders a parent with its direct and indirect children
- **THEN** no group gap is inserted between the parent and any of its descendants
- **AND** the descendants stay indented under the parent with the derivation connector

#### Scenario: Ordering is preserved

- **WHEN** the Lineage view groups trees with the added spacing
- **THEN** the depth-first order of ideas is unchanged from before the grouping change

