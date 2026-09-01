## ADDED Requirements

### Requirement: Idea nodes SHALL display frontend-derived daemon session activity

An Idea node in the project resource graph SHALL render a distinct animated running treatment while the shared frontend session-activity state contains at least one active session for that Idea. The treatment SHALL remain visually distinct from the node's lifecycle badge and generic read/write agent-presence ring. Hovering or focusing it SHALL disclose each active session's Agent avatar, identity, and CWD. One session SHALL navigate directly to its exact conversation while preserving agent/CWD focus; several sessions SHALL display a count and chooser. Its hit region SHALL NOT replace the existing card-body Idea-panel action or expand/collapse affordance. Start and end events SHALL update the treatment without a resource-graph refetch.

#### Scenario: Active Idea node is visually distinct

- **WHEN** an Idea has one or more frontend-derived active daemon sessions
- **THEN** its node shows a running treatment in addition to lifecycle and generic presence visuals

#### Scenario: One active session opens its exact conversation

- **WHEN** an Idea node has exactly one active session and the user activates its running treatment
- **THEN** daemon chat opens that session's transcript with its agent/CWD focus and the Idea side panel does not also open

#### Scenario: Multiple graph sessions are selectable

- **WHEN** an Idea node has multiple active sessions
- **THEN** the treatment shows their count, hover or focus lists every Agent avatar and location, and the chooser opens the selected conversation

#### Scenario: Existing node interactions remain intact

- **WHEN** the user activates the Idea card body or expand affordance outside the running-treatment region
- **THEN** the graph performs its existing Idea-panel or expand/collapse behavior

#### Scenario: Session events update the node without graph refetch

- **WHEN** the frontend receives `session_started` or `session_ended` for an Idea
- **THEN** the graph adds, updates, or removes the running treatment from shared client state without fetching the resource graph again

#### Scenario: Non-running state does not animate the node

- **WHEN** an Idea has no running session activity tokens
- **THEN** its graph node shows no daemon-running treatment even if an agent is online or the session is idle, queued, ended, or interrupted
