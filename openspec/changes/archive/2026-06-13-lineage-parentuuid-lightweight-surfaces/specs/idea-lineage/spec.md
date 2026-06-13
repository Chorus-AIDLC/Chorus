# idea-lineage delta — propagate `parentUuid` to lightweight idea-read surfaces

## MODIFIED Requirements

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
