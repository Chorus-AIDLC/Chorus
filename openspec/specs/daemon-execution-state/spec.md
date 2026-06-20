# daemon-execution-state Specification

## Purpose
Defines the daemon execution-state layer that surfaces, in real time, which tasks a
daemon connection is running and which are queued. Covers the persistent
`DaemonTaskExecution` model (one row per connection/task, snapshot-reconciled), the
agent-key `POST /api/daemon/execution-state` ingest endpoint fed from the daemon's
WakeQueue, the additive `execution:{connectionUuid}` SSE push channel, the Agent
Connections detail-pane running/queued view (replacing the prior placeholder),
owner-scoped visibility consistent with the connection registry, and offline
reconciliation that stops rendering a stale/offline connection's rows as active while
retaining them as history — reusing the registry's single `STALE_THRESHOLD_MS`. This is
the execution-state slice (子2) of the daemon dispatch model; the configurable
concurrency cap (子1) and interrupt/resume reverse-control channel (子3) are separate
capabilities.
## Requirements
### Requirement: The server SHALL persist daemon task execution state in a DaemonTaskExecution model

The server SHALL define a Prisma model `DaemonTaskExecution` that stores one row per `(connection, task)` the daemon is running or has queued. The model SHALL carry at least: `uuid` (public id), `companyUuid`, `agentUuid`, `connectionUuid` (referencing `DaemonConnection.uuid`), `taskUuid` (referencing `Task.uuid`), `rootIdeaUuid` (nullable, for a task with no root-idea lineage such as a quick task), `status` (`running` | `queued` | `ended`), `startedAt` (nullable, set when the row is running), `createdAt`, and `updatedAt`. The pair `(connectionUuid, taskUuid)` SHALL be unique so a task appears at most once per connection. The model SHALL be created through a Prisma-CLI-generated migration containing only DDL (no `INSERT`/`UPDATE`/`DELETE` backfill), and the `agent` relation SHALL cascade-delete with its agent, matching existing model conventions. No change SHALL be made to the `DaemonConnection` or `AgentSession` models.

#### Scenario: A running task is persisted as a row

- **GIVEN** a registered daemon connection that begins running a dispatched task
- **WHEN** the server records the execution state
- **THEN** a `DaemonTaskExecution` row MUST exist with `status = "running"`, `startedAt` set, and `connectionUuid`/`taskUuid`/`companyUuid`/`agentUuid` taken from the reported snapshot and authenticated context

#### Scenario: A task appears at most once per connection

- **GIVEN** a `DaemonTaskExecution` row already exists for `(connection C, task T)`
- **WHEN** a later snapshot reports task T again for connection C
- **THEN** the existing row MUST be updated rather than a second row inserted for `(C, T)`

#### Scenario: The migration is DDL-only

- **WHEN** the change is implemented
- **THEN** the generated migration MUST contain only schema DDL
- **AND** it MUST NOT contain data backfill statements

### Requirement: The server SHALL expose an agent-callable REST endpoint that ingests an execution snapshot

The server SHALL expose `POST /api/daemon/execution-state` that accepts, from an authenticated daemon, a full execution snapshot for one connection: the `connectionUuid` and a list of `{ taskUuid, rootIdeaUuid|null, status, startedAt|null }` entries. The endpoint SHALL require authentication by an agent API key, SHALL NOT be implemented as an MCP tool, and SHALL NOT introduce a new permission bit — the writable set is scoped to the authenticated agent's own connections. The endpoint SHALL use the standard API envelope. The endpoint SHALL reject a snapshot whose `connectionUuid` does not belong to the authenticated agent within its company, without revealing that another agent's connection exists.

#### Scenario: An unauthenticated request is rejected

- **GIVEN** a request to `POST /api/daemon/execution-state` with no valid agent key
- **WHEN** the server handles it
- **THEN** the response status MUST be 401 and no execution state MUST be written

#### Scenario: A snapshot for the agent's own connection is accepted

- **GIVEN** an agent key whose agent owns connection C
- **WHEN** the agent POSTs a snapshot for connection C
- **THEN** the response MUST be the standard success envelope
- **AND** the execution rows for C MUST be reconciled to match the snapshot

#### Scenario: A snapshot for a connection the agent does not own is rejected

- **GIVEN** connection C belongs to a different agent
- **WHEN** an agent key that does not own C POSTs a snapshot naming `connectionUuid = C`
- **THEN** the server MUST NOT modify C's execution rows
- **AND** the response MUST NOT confirm the existence of C (it MUST be a not-found, not a forbidden that reveals C)

### Requirement: The ingest endpoint SHALL treat each snapshot as the authoritative state for the connection

The server SHALL reconcile an ingested snapshot as the complete current execution state for the named connection: each task in the snapshot SHALL be upserted to its reported `status` (`running` or `queued`), and any existing `running`/`queued` row for that connection that is **absent** from the snapshot SHALL transition to `ended`. This snapshot-reconcile semantics SHALL make the endpoint idempotent — applying the same snapshot twice SHALL yield the same persisted state — and self-healing, so a dropped or out-of-order update cannot leave a row stuck `running` once a later snapshot omits it.

#### Scenario: A task absent from the new snapshot is ended

- **GIVEN** connection C has a `running` row for task T1 and a `queued` row for task T2
- **WHEN** C posts a new snapshot containing only T2 as `running`
- **THEN** T2's row MUST become `running`
- **AND** T1's row MUST transition to `ended`

#### Scenario: Re-applying the same snapshot is idempotent

- **GIVEN** a connection's execution rows already match a snapshot
- **WHEN** the identical snapshot is posted again
- **THEN** the persisted running/queued set MUST be unchanged

### Requirement: Execution-state changes SHALL be pushed to the UI over a dedicated SSE event

The server SHALL publish an execution-state event keyed per connection (for example `execution:{connectionUuid}`) on the existing event bus (with the existing Redis fan-out for multi-instance deployments) after a snapshot reconcile changes a connection's execution state, and after an offline transition changes it. A subscribed client viewing that connection SHALL re-render the connection's running/queued list in response, without polling on a fast interval and without a manual reload. This SHALL be additive to the existing notification/presence event types and SHALL NOT alter them.

#### Scenario: A reconcile publishes an execution event

- **GIVEN** a client is subscribed to execution updates for connection C
- **WHEN** an ingested snapshot changes C's running/queued set
- **THEN** an execution event for C MUST be published on the event bus
- **AND** the subscribed client MUST update C's displayed execution list without a manual reload

#### Scenario: Existing event types are unaffected

- **WHEN** the execution event type is added
- **THEN** the existing notification and presence event types MUST continue to function unchanged

### Requirement: Execution-state visibility SHALL be owner-scoped consistent with the connection registry

The server SHALL scope execution-state reads so that a user caller sees only the execution of connections whose agent the user owns (`agent.ownerUuid`), and an agent-key caller sees only its own connections' execution, every query `companyUuid`-scoped — identical to the `agent-connection-observability` visibility rule. Execution rows for an agent owned by a different user SHALL NOT be returned to other members of the same company, and visibility SHALL NOT cross company boundaries. No new permission bit SHALL be introduced.

#### Scenario: A user sees only their own agents' execution

- **GIVEN** user U owns agent A and user V owns agent B in the same company, each with a connection running a task
- **WHEN** user U reads execution state
- **THEN** the result MUST include agent A's execution
- **AND** it MUST NOT include agent B's execution

#### Scenario: Execution visibility never crosses company boundaries

- **GIVEN** a connection and its execution belonging to an agent in company C2
- **WHEN** a caller in company C1 reads execution state
- **THEN** the result MUST NOT include that execution

### Requirement: An offline connection SHALL show no active execution while retaining history

When a connection becomes effectively offline — its stream aborts, or its `lastSeenAt` is older than the daemon-connection registry's staleness threshold (`STALE_THRESHOLD_MS`, the same constant the read API applies) — the server SHALL transition that connection's `running` and `queued` rows to the `ended` terminal state, and the UI SHALL NOT render them as running or queued. The rows SHALL be retained (not deleted) so execution history remains queryable. No second staleness constant SHALL be introduced; the offline rule SHALL reuse the registry's threshold so producer and consumer cannot drift.

#### Scenario: Going offline clears the active execution view

- **GIVEN** an online connection with a running task displayed
- **WHEN** the connection becomes effectively offline (abort or staleness threshold exceeded)
- **THEN** the connection's running/queued rows MUST transition to `ended`
- **AND** the connection's detail MUST no longer show any task as running or queued

#### Scenario: History is retained after offline

- **GIVEN** a connection whose execution rows were transitioned to `ended` on going offline
- **WHEN** the execution rows are queried afterward
- **THEN** the previously-active rows MUST still exist with `ended` status rather than having been deleted

#### Scenario: The offline rule reuses the registry threshold

- **WHEN** the offline transition is implemented
- **THEN** it MUST use the daemon-connection registry's existing staleness threshold constant
- **AND** it MUST NOT define a separate execution-specific staleness timeout

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

### Requirement: Ad-hoc conversation executions are visible

The execution-state model SHALL recognize `daemon_session` as a wake-triggering
entity kind, in addition to `task | idea | proposal | document`, so that an ad-hoc
(non-idea) conversation wake is reconciled into a `DaemonExecution` row rather than
being silently dropped. A reported `daemon_session` execution SHALL be validated
for existence against the `DaemonSession` table (company-scoped), not the
task/idea/proposal/document content tables. The ingest endpoint SHALL accept
`daemon_session` at its request boundary. In the execution surfaces (presence
popover, connections/chat views) a `daemon_session` execution SHALL be labeled as a
conversation rather than as an unknown resource, and SHALL NOT render a broken
resource deep link.

#### Scenario: Ad-hoc wake produces a running execution row

- **WHEN** a daemon reports an execution snapshot containing an entry with
  `entityType: "daemon_session"` and an `entityUuid` that resolves to an existing
  `DaemonSession` in the caller's company
- **THEN** the entry is reconciled into a `DaemonExecution` row (it is NOT dropped),
  and the conversation appears in the running/queued execution surfaces

#### Scenario: Non-existent daemon_session entry is dropped, not wedging the snapshot

- **WHEN** a snapshot entry has `entityType: "daemon_session"` but its `entityUuid`
  does not resolve to a `DaemonSession` in the caller's company
- **THEN** that entry is dropped (consistent with the existing dead-reference
  handling for the other entity kinds) while the rest of the snapshot still
  reconciles

#### Scenario: Conversation execution is labeled, not "unknown"

- **WHEN** a `daemon_session` execution is rendered in an execution surface
- **THEN** it is labeled as a conversation (a localized "Conversation" label), and
  no broken resource deep link is shown for it

#### Scenario: Existing entity kinds are unaffected

- **WHEN** a snapshot contains `task | idea | proposal | document` entries
- **THEN** they are validated and reconciled exactly as before (the
  `daemon_session` addition is additive and does not alter existing behavior)

