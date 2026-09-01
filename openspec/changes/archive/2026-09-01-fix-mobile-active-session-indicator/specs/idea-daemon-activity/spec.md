## MODIFIED Requirements

### Requirement: Idea Tracker SHALL display active daemon sessions

Every Idea row in flat and lineage Tracker views, and the open Idea detail sidebar, SHALL render a
distinct running indicator based on the shared animated Agent avatar while frontend state contains
at least one active session for that Idea. The indicator SHALL be operable by touch/click and
keyboard on mobile and desktop; mouse hover MAY additionally disclose the chooser but SHALL NOT be
required for activation. Exactly one actionable session SHALL navigate directly to its exact
conversation without displaying a one-item chooser. Several sessions SHALL display a count and a
Popover chooser, and a touch/click on the indicator MUST reliably open that chooser so the user can
select a session. A sole status-only session SHALL remain discoverable but MUST NOT open chat.
Activating the indicator or an entry SHALL NOT also trigger Idea-detail or graph-canvas navigation.
The indicator SHALL disappear immediately after the final `session_ended` event and SHALL NOT
retain recent/history state.

#### Scenario: One active session opens its exact conversation directly

- **WHEN** an Idea row has exactly one actionable active session and the user activates its
  indicator by touch, click, or keyboard
- **THEN** daemon chat opens that session's transcript on desktop and mobile without first showing
  a chooser
- **AND** the Idea detail panel does not open

#### Scenario: Multiple sessions open a touch-accessible chooser

- **WHEN** an Idea row has multiple active sessions and the user taps or clicks its indicator
- **THEN** the indicator's Popover chooser MUST open and list every active session with its Agent
  avatar, identity, location, and ownership-safe status
- **AND** activating an actionable entry opens that exact conversation

#### Scenario: Hover and keyboard preserve chooser access

- **WHEN** a pointer with hover capability enters the multi-session indicator or keyboard focus
  reaches it
- **THEN** the same chooser is disclosed without removing touch/click activation
- **AND** every actionable chooser entry remains keyboard focusable

#### Scenario: Sole other-user session remains status-only

- **WHEN** an Idea has one active session with `canOpen: false`
- **THEN** its indicator can disclose the Agent's status but MUST NOT invoke chat navigation from
  touch, click, or keyboard activation

#### Scenario: Idea detail sidebar mirrors the running state

- **WHEN** an active Idea is open in the Tracker detail sidebar
- **THEN** its header displays the same zero-, one-, and multi-session behavior as the corresponding
  Tracker row

#### Scenario: Flat, lineage, and graph surfaces agree

- **WHEN** the same active Idea is rendered in flat Tracker, lineage Tracker, or project graph
  views
- **THEN** every surface shows the same active-session count and navigation choices
- **AND** activating the indicator does not activate the containing Idea row or graph node

#### Scenario: Final end removes the indicator

- **WHEN** the final running activity token for an Idea receives `session_ended`
- **THEN** its active-session indicator disappears without a page refresh or replacement history
  marker
