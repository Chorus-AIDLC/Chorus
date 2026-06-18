# daemon-execution-state — delta

## REMOVED Requirements

### Requirement: The Agent Connections detail pane SHALL display the connection's running and queued tasks

## ADDED Requirements

### Requirement: The sidebar popover and connection modal SHALL display each connection's running and queued tasks

The dashboard SHALL display a connection's execution state — its `running` tasks
and its `queued` tasks — in the **sidebar presence popover** (under each online
connection) and in the **connection modal** (in the selected connection's detail),
replacing the former standalone page's detail pane as the host of this view. Each
execution row SHALL identify the task (title and a link to the task) and, when
present, the root-idea session the task belongs to. Each `running` row SHALL show a
started/elapsed indicator derived from `startedAt`; `queued` rows SHALL be presented
as waiting without an elapsed timer. The popover and modal SHALL share one
rendering vocabulary so a running/queued row looks identical in both surfaces.

The surfaces SHALL render correct initial state on first paint before any SSE event
arrives. First-paint state SHALL be sourced from the aggregate read endpoint
(`GET /api/daemon/executions`, see the agent-connection-observability capability)
so the resident sidebar surface obtains all visible connections' executions in a
single request rather than one request per connection. This aggregate source SHALL
replace the prior page's per-connection `execution-state` first-paint fetch without
loss of detail-pane correctness: when the modal opens a connection's detail, that
connection's running/queued (and, in the modal, `interrupted`) executions MUST be
present on first paint, partitioned to the correct connection, equivalent to what
the per-connection fetch previously produced. After first paint, the surfaces SHALL
update live from the existing per-connection execution SSE events
(`execution:{connectionUuid}`) merged by connection. The surfaces SHALL show a clear
empty/idle state when a connection has no running or queued tasks rather than a
blank area. All user-facing strings SHALL be localized in both supported locales.

#### Scenario: Running and queued tasks are listed for a connection

- **GIVEN** a visible online connection running task T1 (on a root-idea session) with task T2 queued
- **WHEN** the user opens the sidebar popover or the connection modal
- **THEN** the surface MUST show T1 under running with an elapsed indicator and its root-idea session
- **AND** it MUST show T2 under queued without an elapsed timer

#### Scenario: Initial state renders from the aggregate endpoint before any SSE event

- **GIVEN** a user with a connection already running a task when the shell loads
- **WHEN** the presence data source fetches first-paint state
- **THEN** it MUST obtain the running task from a single aggregate `GET /api/daemon/executions` request
- **AND** the running task MUST be visible without waiting for an SSE event or issuing one request per connection

#### Scenario: A connection with no active execution shows an empty/idle state

- **GIVEN** a visible online connection with no running or queued tasks
- **WHEN** the user views it in the popover or modal
- **THEN** the surface MUST show a localized empty/idle state rather than fabricated rows or a blank area

#### Scenario: Execution rows update live after first paint

- **GIVEN** the popover or modal is open showing a connection's executions
- **WHEN** an `execution:{connectionUuid}` SSE event changes that connection's running/queued set
- **THEN** the displayed execution list MUST update without a manual reload

#### Scenario: Modal detail-pane first paint matches the former per-connection fetch

- **GIVEN** two visible connections each running a different task when the shell loads
- **WHEN** the user opens the modal and selects one connection's detail
- **THEN** that connection's running/queued executions MUST be present on first paint, partitioned to the selected connection (not mixed with the other connection's executions)
- **AND** the result MUST be equivalent to what the prior per-connection `execution-state` fetch produced for that connection
