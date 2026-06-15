# daemon-connection-registry Specification

## ADDED Requirements

### Requirement: The server SHALL persist registered daemon connections in a DaemonConnection model

The server SHALL define a Prisma model `DaemonConnection` that stores one row per
registered long-lived SSE connection from a daemon client. The model SHALL carry
at least: `uuid` (public id), `companyUuid`, `agentUuid`, `clientType`,
`clientVersion` (nullable), `host` (nullable), `startedAt` (nullable),
`status` (defaulting to `online`), `connectedAt`, `lastSeenAt`, and
`disconnectedAt` (nullable). The model SHALL be persisted in the database (not an
in-memory structure) so that a connection registered by one server instance is
readable by another instance, and SHALL be created through a Prisma-CLI-generated
migration (no hand-written SQL). The `agent` relation SHALL cascade-delete with
its agent, matching the existing `AgentSession` model conventions.

#### Scenario: A daemon connection is persisted on registration

- **GIVEN** an authenticated agent opens the notification SSE stream and
  self-reports a recognized daemon `clientType`
- **WHEN** the server registers the connection
- **THEN** a `DaemonConnection` row MUST be persisted with `status = "online"`,
  `connectedAt` and `lastSeenAt` set to the current time, and `companyUuid` /
  `agentUuid` taken from the authenticated context
- **AND** the row MUST be readable by a query executed on a different server
  instance than the one holding the socket

#### Scenario: The agent relation cascade-deletes

- **GIVEN** a `DaemonConnection` row for some agent
- **WHEN** that agent is deleted
- **THEN** the agent's `DaemonConnection` rows MUST be deleted as well

### Requirement: SSE connections SHALL self-report client metadata via query parameters

The SSE endpoints `/api/events/notifications` and `/api/events` SHALL accept
optional query parameters `clientType`, `clientVersion`, `host`, and `startedAt`
that a connecting client uses to self-report its identity. The server SHALL read
these parameters only after authentication succeeds and SHALL NOT use them for
any authorization decision — authentication remains via Bearer API key or session
cookie. Query parameters (not request headers) SHALL be the contract, so a future
browser `EventSource` client (which cannot set custom headers) can use the same
mechanism. A connection that supplies none of these parameters SHALL be served
exactly as before this change.

#### Scenario: Self-reported metadata populates the registry row

- **WHEN** a client connects with `?clientType=claude_code&clientVersion=0.11.0&host=mac.local&startedAt=2026-06-15T03:00:00.000Z`
- **THEN** the registered `DaemonConnection` row MUST record `clientType="claude_code"`,
  `clientVersion="0.11.0"`, `host="mac.local"`, and `startedAt` parsed from the
  supplied timestamp

#### Scenario: Self-reported metadata is never used for authorization

- **GIVEN** a connection whose query parameters claim an arbitrary `clientType` or `host`
- **WHEN** the server processes the connection
- **THEN** the authorization outcome MUST depend only on the Bearer key / session
  cookie, identical to a connection that supplied no query parameters

#### Scenario: A connection with no self-report params is served unchanged

- **WHEN** a client connects to the SSE endpoint with no `clientType` (or related) query parameters
- **THEN** the stream MUST be established exactly as before this change
- **AND** no `DaemonConnection` row MUST be written for it

### Requirement: Only recognized daemon client types SHALL be registered

The server SHALL register a `DaemonConnection` row only when the self-reported
`clientType` is a recognized daemon client type (`claude_code` or `openclaw`).
The `clientType` column SHALL nonetheless permit the values `browser` and `other`
so that registering browser connections can be added later without a schema
migration, but in this change a `clientType` of `browser`, `other`, an
unrecognized value, or an absent value SHALL NOT cause a row to be written.

#### Scenario: A claude_code connection is registered

- **WHEN** a connection self-reports `clientType=claude_code`
- **THEN** a `DaemonConnection` row MUST be written

#### Scenario: An openclaw connection is registered

- **WHEN** a connection self-reports `clientType=openclaw`
- **THEN** a `DaemonConnection` row MUST be written

#### Scenario: A browser connection is not registered in this change

- **WHEN** a connection self-reports `clientType=browser`
- **THEN** no `DaemonConnection` row MUST be written
- **AND** the SSE stream MUST still be established normally

#### Scenario: An unrecognized client type is not registered

- **WHEN** a connection self-reports a `clientType` that is neither `claude_code` nor `openclaw`
- **THEN** no `DaemonConnection` row MUST be written

### Requirement: A reconnecting daemon SHALL refresh its existing row rather than accumulate rows

Registration SHALL be idempotent per logical daemon, keyed on
`(agentUuid, clientType, host)`. When a daemon reconnects (for example after an
SSE drop and backoff reconnect), the server SHALL refresh the existing matching
row — setting `status = "online"` and updating `connectedAt` / `lastSeenAt` —
rather than inserting a new row. Two daemons reporting different `host` values
SHALL be distinct rows.

#### Scenario: Reconnect refreshes the same row

- **GIVEN** a `DaemonConnection` row exists for `(agent A, claude_code, host H)` in `offline` status
- **WHEN** the same daemon reconnects self-reporting the same `clientType` and `host`
- **THEN** the existing row MUST be flipped to `status = "online"` with a refreshed `connectedAt`
- **AND** no second row for `(agent A, claude_code, host H)` MUST exist

#### Scenario: Different hosts are distinct connections

- **GIVEN** agent A runs the daemon on two machines with different hostnames
- **WHEN** both connect self-reporting `clientType=claude_code` with their respective `host` values
- **THEN** two distinct `DaemonConnection` rows MUST exist, one per host

### Requirement: Connection liveness SHALL use abort as the primary signal with a heartbeat-driven staleness safety net

The SSE route SHALL treat the stream's `abort` event as the primary
disconnect signal: on `abort` (graceful client disconnect, process exit, or
network close) the server SHALL mark the connection `offline` and set
`disconnectedAt`. As a safety net for the case where the server instance itself
dies (and therefore cannot run its `abort` handler), the SSE route's existing
periodic heartbeat interval SHALL also update the connection's `lastSeenAt` on
each tick. No client-to-server heartbeat SHALL be added — the daemon sends
nothing after connecting, and the server-side interval is the sole liveness
updater. The model SHALL define a documented staleness threshold (approximately
three heartbeat intervals) such that a consumer treats a connection as
effectively offline when `status = "online"` but `lastSeenAt` is older than that
threshold.

#### Scenario: Graceful disconnect marks the row offline immediately

- **GIVEN** a registered `online` `DaemonConnection`
- **WHEN** the client disconnects gracefully and the stream's `abort` event fires
- **THEN** the row MUST be updated to `status = "offline"` with `disconnectedAt` set to the current time

#### Scenario: Heartbeat tick advances lastSeenAt

- **GIVEN** a registered `online` `DaemonConnection`
- **WHEN** the SSE route's periodic heartbeat interval fires for that connection
- **THEN** the row's `lastSeenAt` MUST be advanced to the current time

#### Scenario: An instance crash leaves a row that reads as stale

- **GIVEN** a registered `online` `DaemonConnection` whose holding instance hard-crashes so its `abort` never fires
- **WHEN** more than the staleness threshold elapses with no heartbeat tick
- **THEN** the row MUST remain `status = "online"` with a `lastSeenAt` no longer being advanced
- **AND** a consumer applying the liveness rule (`status = "online"` AND `lastSeenAt` fresh) MUST treat it as effectively offline

#### Scenario: No client-to-server heartbeat is introduced

- **WHEN** the change is implemented
- **THEN** the daemon clients MUST NOT send any periodic request to the server after the initial SSE connection
- **AND** `lastSeenAt` MUST be advanced solely by the server-side heartbeat interval

### Requirement: A registry write SHALL never block or break SSE event delivery

The server SHALL perform all `DaemonConnection` registry operations (register,
touch, mark-disconnected) without blocking the establishment or operation of the
SSE stream, and a registry write SHALL NOT delay event delivery. A failure of any
registry operation SHALL be logged and otherwise ignored;
it SHALL NOT prevent the stream from being established, SHALL NOT interrupt event
delivery, and SHALL NOT propagate an error to the client.

#### Scenario: A failed registry write still serves the stream

- **GIVEN** the registry persistence layer is failing (e.g. a transient DB error)
- **WHEN** a client opens the SSE stream
- **THEN** the stream MUST still be established and events MUST still be delivered
- **AND** the failure MUST be logged rather than surfaced to the client

### Requirement: Connection metadata visibility SHALL be owner-scoped

The server SHALL make the self-reported metadata of a `DaemonConnection` (notably
`host` and `clientVersion`) visible only to the user who owns the agent that holds
the connection. Any future read API or UI built on this registry SHALL enforce
owner-scoped visibility and SHALL NOT expose another agent's connection metadata
to other members of the same company. This change introduces no read endpoint;
the requirement binds the consumer (`f2fe9a7f`) that adds one.

#### Scenario: Owner-scoped visibility is the binding contract

- **GIVEN** a `DaemonConnection` belonging to an agent owned by user U
- **WHEN** a future read API returns connection metadata
- **THEN** it MUST return that connection only to user U (the agent's owner)
- **AND** it MUST NOT return that connection's `host` or `clientVersion` to other members of U's company
