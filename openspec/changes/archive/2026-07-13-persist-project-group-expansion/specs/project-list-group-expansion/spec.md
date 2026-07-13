## ADDED Requirements

### Requirement: Project-list group expand/collapse state persists across visits

The project-list page SHALL remember which project groups (and the Ungrouped
section) the user has expanded, and SHALL restore that state on the next visit,
so the page reopens the way the user left it rather than resetting to a fixed
default. The state SHALL be persisted client-side in the browser's
`localStorage` (per browser; no server-side sync). A group whose expansion state
has never been recorded — including a user's first-ever visit and any
newly-created group not present in the saved state — SHALL default to collapsed.
The Ungrouped section SHALL be persisted and restored on the same terms as a
real group, keyed by a stable sentinel. When `localStorage` is unavailable
(disabled or throwing), the page SHALL still render with all groups collapsed and
SHALL NOT error.

#### Scenario: Expanded groups are restored on the next visit

- **WHEN** a user expands one or more project groups (and/or collapses others) and later reloads the project-list page in the same browser
- **THEN** exactly the groups that were expanded are shown expanded, and the others collapsed, matching the state the user left

#### Scenario: First visit / never-toggled groups default to collapsed

- **WHEN** the project-list page is opened with no saved expansion state (first-ever visit, or after the stored value is cleared)
- **THEN** every group is rendered collapsed, and no group is auto-expanded by position

#### Scenario: A newly-created group defaults to collapsed

- **WHEN** a group that is not present in the saved expansion state is rendered
- **THEN** it is shown collapsed until the user expands it, after which its expanded state is remembered on the next visit

#### Scenario: The Ungrouped section is remembered

- **WHEN** the user expands the Ungrouped section and reloads the page
- **THEN** the Ungrouped section is shown expanded on return, persisted under its own stable key like any real group

#### Scenario: localStorage unavailable degrades gracefully

- **WHEN** `localStorage` cannot be read or written (server-side render, privacy mode, or a throwing storage)
- **THEN** the page renders with all groups collapsed and continues to function without error, simply not persisting the expansion state
