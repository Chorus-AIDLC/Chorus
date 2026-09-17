## ADDED Requirements

### Requirement: The daemon transcript header SHALL omit redundant lifecycle metadata

The Agent Daemon transcript header SHALL NOT render an “Active” lifecycle badge for an active conversation. It SHALL retain an explicit “Ended” badge for an ended conversation and SHALL preserve the independent running indicator and live elapsed runtime whenever the current turn is running.

The expanded connection-details disclosure SHALL NOT render the connection process start time or its relative “Started” value. It SHALL retain connection identity, online uptime, host, and all existing actions, and the retained fields SHALL reflow without an empty placeholder.

These presentation rules SHALL apply to every Agent Daemon transcript regardless of whether the session is idea-anchored or ad-hoc. They SHALL NOT remove `startedAt` from the connection data contract or change other connection-observability surfaces.

#### Scenario: Active conversation omits the lifecycle badge

- **WHEN** an active Agent Daemon conversation transcript renders
- **THEN** the header MUST NOT show the “Active” lifecycle badge
- **AND** the running indicator and elapsed runtime MUST still appear when the current turn is running

#### Scenario: Ended conversation retains terminal status

- **WHEN** an ended Agent Daemon conversation transcript renders
- **THEN** the header MUST show the existing “Ended” badge

#### Scenario: Connection disclosure omits relative start time

- **WHEN** the user expands connection details for a connection with a non-null `startedAt`
- **THEN** the disclosure MUST NOT show a “Started” field or relative process-start value
- **AND** connection identity, uptime when online, and host MUST remain visible without an empty reserved row

#### Scenario: Presentation scope does not alter the connection contract

- **WHEN** this header simplification is implemented
- **THEN** the connection API and frontend connection type MUST retain `startedAt`
- **AND** connection views outside the Agent Daemon transcript MUST remain unchanged
