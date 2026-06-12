# Idea Lineage

## ADDED Requirements

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

#### Scenario: Detail view returns parent and children

- **WHEN** `chorus_get_idea` is called for an idea with a parent and two children
- **THEN** the response includes the parent reference and a `children[]` array of length 2

#### Scenario: List view returns child counts

- **WHEN** `chorus_get_ideas` is called for a project
- **THEN** each idea includes its `parentUuid` and a `childCount` equal to its number of direct children

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
