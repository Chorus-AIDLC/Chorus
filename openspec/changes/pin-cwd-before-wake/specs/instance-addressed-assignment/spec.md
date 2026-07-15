## REMOVED Requirements

### Requirement: An unreachable assignment-pinned instance degrades to a plain agent

## ADDED Requirements

### Requirement: An unreachable assignment-pinned instance stays notify-only

An assignment pin (a Task `agent_instance` override or an inherited Idea instance) SHALL be a **HARD** pin, with the same offline policy as a mention's typed `?cwd=&host=` markup pin. When a HARD pin resolves to an instance that has no online connection, the system SHALL NOT hang, error opaquely, or silently re-route the wake to a different connection of the same agent; the wake SHALL be notify-only (no wake/turn delivered, recovered by the existing reconnect backfill for recoverable triggers). For a `require_online` stage-advance action, the action SHALL fail with a distinguishable instance-offline error rather than waking a different cwd. A HARD assignment pin SHALL NOT degrade to an un-pinned `agent` for downstream inheritance: it remains the pinned instance, and later resolve wakes continue to target that instance (notify-only while it is offline). This unifies the offline policy of assignment pins with mention pins — there is no SOFT assignment pin.

#### Scenario: Assignment pin to an offline instance stays notify-only

- **WHEN** a wake for a Task/Idea assignment resolves to instance A, A has no online connection, and the agent has another online connection
- **THEN** the wake MUST be notify-only and MUST NOT be re-routed to the agent's other online connection

#### Scenario: A require-online action on an offline pinned instance fails distinguishably

- **GIVEN** an Idea pinned to instance A which currently has no online connection
- **WHEN** a user invokes a `require_online` stage-advance action (Start Development or Yolo) for that Idea
- **THEN** the action MUST fail with an instance-offline error distinguishable from other precondition failures
- **AND** no other cwd of the agent MUST be woken

#### Scenario: Mention pin to an offline instance stays notify-only

- **WHEN** a wake from a mention's `?cwd=&host=` markup resolves to an offline instance
- **THEN** no wake is delivered (notify-only) and the wake is NOT re-routed to online-first

#### Scenario: An offline pinned instance that reconnects wakes at that instance

- **GIVEN** an Idea pinned to instance A that was offline when a recoverable wake was queued
- **WHEN** instance A reconnects
- **THEN** the backfilled wake MUST target instance A (the pin is retained, not degraded to online-first)
