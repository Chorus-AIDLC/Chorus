## ADDED Requirements

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

### Requirement: The Agent Connections detail pane SHALL display the connection's running and queued tasks

The Agent Connections page SHALL replace the connection detail "coming soon" placeholder with a live view of the selected connection's execution state: a list of `running` tasks and a list of `queued` tasks. Each row SHALL identify the task (title and a link to the task) and, when present, the root-idea session the task belongs to. Each `running` row SHALL show a started/elapsed indicator derived from `startedAt`; `queued` rows SHALL be presented as waiting without an elapsed timer. The view SHALL render correct initial state on first paint (fetched from the read API) before any SSE event arrives, and SHALL thereafter update from the execution SSE event. All user-facing strings SHALL be localized in both supported locales. The page SHALL show a clear empty state when the connection has no running or queued tasks.

#### Scenario: Running and queued tasks are listed for a connection

- **GIVEN** a visible connection running task T1 (on a root-idea session) with task T2 queued
- **WHEN** the user opens that connection's detail
- **THEN** the detail MUST show T1 under running with an elapsed indicator and its root-idea session
- **AND** it MUST show T2 under queued without an elapsed timer

#### Scenario: Initial state renders before any SSE event

- **GIVEN** a connection that already has a running task when the page loads
- **WHEN** the user opens that connection's detail
- **THEN** the running task MUST be visible from the initial fetch without waiting for an SSE event

#### Scenario: A connection with no active execution shows an empty state

- **GIVEN** a visible connection with no running or queued tasks
- **WHEN** the user opens that connection's detail
- **THEN** the detail MUST show a localized empty state rather than the old "coming soon" placeholder or fabricated rows

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
