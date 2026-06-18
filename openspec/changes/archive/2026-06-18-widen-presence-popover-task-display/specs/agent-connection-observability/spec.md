## ADDED Requirements

### Requirement: The presence popover SHALL display each execution's task in a readable, non-truncated layout

The sidebar presence popover SHALL present each connection's `running` and `queued`
executions so that the task title is legible without being hard-truncated by the
popover's width. The popover container SHALL be wider than a single narrow column and
SHALL be clamped to the viewport so it never overflows a small screen (a
viewport-relative max width). Within the popover, each execution row SHALL use a layout
in which the task title occupies the full available row width and is NOT forced to
share that width with the row's trailing controls; the elapsed-time indicator and the
Interrupt control (for `running` rows) SHALL be positioned so they do not crowd or
truncate the title (for example, on a second line beneath the title).

The popover SHALL remain actionable: the elapsed-time indicator and the Interrupt
control SHALL continue to be available in the popover for `running` executions — they
SHALL be relaid out, not removed. The deep-link from a task row to its entity, the
running/queued grouping, and the rule that the popover shows only `running`/`queued`
executions (never `interrupted`) SHALL be preserved unchanged.

This readable layout SHALL be specific to the popover surface. The "View all" modal and
its master-detail connection view SHALL retain their existing execution-row layout; the
shared execution-row renderer SHALL expose the roomy layout as an opt-in that the modal
surfaces do not adopt, so that widening the popover introduces no visual change to the
modal. The change SHALL remain frontend-only over the existing data source: it SHALL NOT
modify the presence data spine, the `GET /api/daemon/executions` or
`GET /api/agent-connections` APIs, the `DaemonConnection` schema, add a migration, or add
a new permission bit.

#### Scenario: A long task title is readable in the popover

- **GIVEN** an online connection running a task whose title is long
- **WHEN** the user opens the presence popover
- **THEN** the popover MUST be rendered at a width wider than the prior narrow column and clamped to the viewport
- **AND** the task title MUST be presented in a layout where it is not hard-truncated to a small fraction of the row by the trailing controls

#### Scenario: Running-row controls do not crowd the title

- **GIVEN** the popover is open showing a `running` execution
- **WHEN** the row renders
- **THEN** the elapsed-time indicator and the Interrupt control MUST both still be present in the popover
- **AND** they MUST be positioned so they do not share the title's horizontal width (for example, on a separate line beneath the title)

#### Scenario: The popover stays within a small viewport

- **GIVEN** the popover opens on a narrow (mobile-width) viewport
- **WHEN** it renders
- **THEN** its width MUST be clamped to the viewport so the popover does not overflow horizontally

#### Scenario: The modal execution-row layout is unchanged

- **GIVEN** the change is implemented
- **WHEN** the user opens the "View all" modal and its connection detail
- **THEN** the modal's execution rows MUST retain their existing (single-line) layout
- **AND** the popover-specific roomy layout MUST be an opt-in not adopted by the modal surfaces

#### Scenario: Popover information architecture is preserved

- **GIVEN** a connection with `running`, `queued`, and `interrupted` executions
- **WHEN** the user views it in the widened popover
- **THEN** the popover MUST still show only the `running` and `queued` executions grouped as before
- **AND** it MUST NOT render the `interrupted` row (which remains modal-only)
- **AND** a task row MUST still deep-link to its entity
