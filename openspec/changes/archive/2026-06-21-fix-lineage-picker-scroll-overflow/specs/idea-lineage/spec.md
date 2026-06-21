# idea-lineage Specification (delta)

## ADDED Requirements

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
