# idea-lineage-view Specification

## Purpose
TBD - created by archiving change redesign-idea-lineage-dashboard-ui. Update Purpose after archive.
## Requirements
### Requirement: Single primary view switch

The project dashboard Overview SHALL present idea view selection as a single segmented
control with exactly three mutually exclusive options — `Ideas` (flat status-grouped list),
`Lineage` (derivation tree), and `Stats` — and SHALL NOT render a separate `Flat / By lineage`
control. The `New Idea` action SHALL be a standalone control to the right of the switch.

#### Scenario: Three options in one control

- **WHEN** the user views a project dashboard Overview
- **THEN** a single segmented control shows `Ideas`, `Lineage`, and `Stats`
- **AND** there is no second `Flat / By lineage` segmented control on the page
- **AND** the `New Idea` button is rendered to the right of the switch

#### Scenario: Selecting a view

- **WHEN** the user clicks one of `Ideas`, `Lineage`, or `Stats`
- **THEN** the corresponding content renders (status-grouped list, lineage tree, or stats)
- **AND** only the clicked option is shown as selected

#### Scenario: No layout jump when switching to Stats

- **WHEN** the user switches between `Ideas`/`Lineage` and `Stats`
- **THEN** the primary control row remains present and in the same position
- **AND** no second control row appears or disappears

#### Scenario: Switch stays reachable with zero ideas

- **WHEN** the project has no ideas
- **THEN** the primary view switch remains visible and interactive
- **AND** the empty-state call-to-action renders in the content area below the switch
- **AND** the user can still select `Stats`

### Requirement: Adaptive default view on first mount

The dashboard SHALL choose the initial view adaptively on first mount when the user has no
stored preference for the project: it SHALL default to `Lineage` if any idea in the initial
tracker data has a parent (`parentUuid` set) or derived children (`childCount > 0`), and
SHALL default to `Ideas` otherwise. This default SHALL be computed once on mount and SHALL
NOT be recomputed when the underlying idea data changes afterward.

#### Scenario: Project with derivation defaults to Lineage

- **WHEN** the dashboard first mounts with no stored preference
- **AND** at least one idea has `parentUuid` set or `childCount > 0`
- **THEN** the `Lineage` view is selected by default

#### Scenario: Project without derivation defaults to Ideas

- **WHEN** the dashboard first mounts with no stored preference
- **AND** no idea has a parent or derived children
- **THEN** the `Ideas` (status-grouped) view is selected by default

#### Scenario: Missing lineage fields fall back to Ideas

- **WHEN** the dashboard first mounts with no stored preference
- **AND** the tracker data carries neither `parentUuid` nor `childCount` signals
- **THEN** the `Ideas` view is selected by default
- **AND** no error is thrown

#### Scenario: Newly derived child does not switch the view mid-session

- **WHEN** the user is viewing the `Ideas` flat view
- **AND** a new derived child idea appears via a realtime data refresh
- **THEN** the view remains on `Ideas`
- **AND** the view is not forcibly switched to `Lineage`

### Requirement: Per-project manual override memory

When the user manually selects a view, that choice SHALL be persisted per project in the
browser's `localStorage`, and on subsequent mounts the stored choice SHALL take precedence
over the adaptive default. A stored value that is not one of the three valid options SHALL
be ignored in favor of the adaptive default.

#### Scenario: Manual choice persists across visits

- **WHEN** the user manually selects `Ideas` on a project that would adaptively default to `Lineage`
- **AND** the user later reopens that project dashboard
- **THEN** the `Ideas` view is selected

#### Scenario: Stored choice wins over adaptive default

- **WHEN** a stored preference exists for the project
- **THEN** the stored view is selected on mount regardless of whether the project has lineage

#### Scenario: Preference is scoped per project

- **WHEN** the user sets a view preference on project A
- **THEN** project B's default is unaffected and still resolves via its own stored value or adaptive default

#### Scenario: Invalid stored value falls back to adaptive default

- **WHEN** the stored preference for a project is not one of `ideas`, `lineage`, or `stats`
- **THEN** the adaptive default is used instead
- **AND** no error is thrown

### Requirement: Unified segmented control styling

The primary view switch SHALL use a single consistent visual style for all three options —
a beige track with a white highlighted selected state — rather than mixing two different
segmented-control styles.

#### Scenario: Consistent style across options

- **WHEN** the user views the primary view switch
- **THEN** all three options share the same segmented-control track styling
- **AND** the selected option is shown with the white highlighted state

