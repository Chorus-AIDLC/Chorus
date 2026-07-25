# daemon-connection-registry Specification

## Purpose
Defines the server-side registry of long-lived daemon SSE connections: the
`DaemonConnection` model, the register/deregister lifecycle wired into the SSE
routes, heartbeat-driven liveness (abort-primary with a `lastSeenAt` staleness
safety net for instance crashes), and the owner-scoped visibility contract that
binds any future read API. This is the data-collection + liveness layer only —
the read API, the Daemons observability UI, the per-connection session view, and
the `AgentSession` linkage are owned by the consuming capability (idea f2fe9a7f).
## Requirements
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

The SSE route SHALL treat the stream's `abort` event as the primary disconnect signal: on `abort` (graceful client disconnect, process exit, or network close) the server SHALL mark the connection `offline` and set `disconnectedAt`. A daemon advertising `livenessAck=v1` SHALL acknowledge receipt of periodic SSE heartbeat comments through an authenticated endpoint. For such an opted-in stream, only a valid acknowledgment fenced to the active registration generation SHALL update `lastSeenAt`, and the server's outbound heartbeat timer SHALL NOT update connection liveness. A legacy stream with an absent or unknown capability value SHALL retain timer-side `lastSeenAt` updates for rolling compatibility. The model SHALL retain the documented 90-second staleness threshold so a consumer treats a connection as effectively offline when `status = "online"` but `lastSeenAt` is older than that threshold.

#### Scenario: Graceful disconnect marks the row offline immediately

- **GIVEN** a registered `online` `DaemonConnection`
- **WHEN** the client disconnects gracefully and the stream's `abort` event fires
- **THEN** the row MUST be updated to `status = "offline"` with `disconnectedAt` set to the current time

#### Scenario: Valid client acknowledgment advances lastSeenAt

- **GIVEN** a registered `online` connection and its active registration generation
- **WHEN** the authenticated daemon acknowledges receiving an SSE heartbeat for that generation
- **THEN** the row's `lastSeenAt` MUST be advanced to the current time

#### Scenario: Outbound server heartbeat does not prove client liveness

- **GIVEN** an opted-in `livenessAck=v1` SSE route whose remote daemon is silently unreachable
- **WHEN** the server's periodic heartbeat timer emits a comment
- **THEN** the timer MUST NOT advance the connection's `lastSeenAt`

#### Scenario: Legacy daemon retains timer-side liveness during rolling deployment

- **GIVEN** a daemon stream whose self-report omits `livenessAck` or supplies an unknown value
- **WHEN** the server's periodic heartbeat timer emits a comment
- **THEN** the server MUST retain the legacy `lastSeenAt` update for that stream
- **AND** deploying the new server MUST NOT make the legacy daemon stale after 90 seconds

#### Scenario: Obsolete generation cannot refresh a newer registration

- **GIVEN** a connection row has been refreshed by a newer registration generation
- **WHEN** a delayed acknowledgment arrives from an older generation
- **THEN** the update MUST match zero rows and MUST NOT advance `lastSeenAt`

#### Scenario: Silent partition becomes read-only

- **GIVEN** a registered connection whose socket is blackholed without an observable abort
- **WHEN** no valid client acknowledgment arrives for more than 90 seconds
- **THEN** consumers applying the liveness rule MUST treat the connection as effectively offline
- **AND** continuation of a session pinned to that origin MUST return the existing structured read-only 409 before creating a turn

#### Scenario: Authentication and ownership fence the acknowledgment

- **WHEN** an unauthenticated caller or a caller outside the connection's company and agent ownership attempts to acknowledge a heartbeat
- **THEN** the server MUST reject the request
- **AND** it MUST NOT update the connection row

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

### Requirement: Registration SHALL skip and signal a conflict when a live different-process daemon already holds the same (agent, host, cwd)

When registering a connection on the real-cwd path (`cwd` is not null), the server SHALL first check for an existing **effectively-online** `DaemonConnection` at the same `(agentUuid, host, cwd)` identity — **across all `clientType` values**, not only the same `clientType` row — where "effectively online" uses the shared liveness rule (`status = "online"` AND `lastSeenAt` within `STALE_THRESHOLD_MS`). The server SHALL compare the incumbent's self-reported process identity (`startedAt`) against the incoming report and SHALL treat the registration as a **conflict** when a fresh incumbent exists whose `startedAt` differs from the incoming `startedAt` (two `startedAt` values count as differing when one is null and the other is not). On a conflict the server SHALL NOT write, upsert, refresh, or otherwise mutate any `DaemonConnection` or `AgentInstance` row, and SHALL return a conflict result that the caller can distinguish from both a successful registration handle and a failure. A conflict SHALL NOT be reported as a registry write failure.

Because the only discriminator is `startedAt`, a rejected registration writing to the row would corrupt the incumbent's own reconnect comparison; the conflict branch therefore MUST return before any persistence operation.

#### Scenario: A fresh same-process reconnect refreshes, not conflicts

- **GIVEN** an effectively-online `DaemonConnection` for `(agent A, host H, cwd C)` with `startedAt = T`
- **WHEN** a registration arrives for the same `(agent A, host H, cwd C)` reporting the same `startedAt = T`
- **THEN** the existing row MUST be refreshed (status online, `connectedAt` / `lastSeenAt` advanced) exactly as a normal reconnect
- **AND** the call MUST return a success handle, not a conflict

#### Scenario: A fresh different-process daemon is a conflict and writes nothing

- **GIVEN** an effectively-online `DaemonConnection` for `(agent A, host H, cwd C)` with `startedAt = T1`
- **WHEN** a registration arrives for the same `(agent A, host H, cwd C)` reporting a different `startedAt = T2`
- **THEN** the call MUST return a conflict result
- **AND** no `DaemonConnection` or `AgentInstance` row MUST be created, upserted, or refreshed — the incumbent row's `connectedAt`, `lastSeenAt`, and `status` MUST be unchanged

#### Scenario: A stale incumbent is taken over, never treated as a conflict

- **GIVEN** a `DaemonConnection` for `(agent A, host H, cwd C)` that is not effectively online (status not `online`, or `lastSeenAt` older than `STALE_THRESHOLD_MS`)
- **WHEN** a registration arrives for the same `(agent A, host H, cwd C)` with any `startedAt`
- **THEN** the registration MUST proceed as a normal takeover (refresh / upsert), regardless of `startedAt`
- **AND** the call MUST return a success handle

#### Scenario: Conflict detection is cross-clientType at the same (agent, host, cwd)

- **GIVEN** an effectively-online `DaemonConnection` for `(agent A, clientType claude_code, host H, cwd C)` with `startedAt = T1`
- **WHEN** a registration arrives for `(agent A, clientType codex, host H, cwd C)` with a different `startedAt = T2`
- **THEN** the call MUST return a conflict result and MUST NOT write a second row
- **AND** running two backends in the same cwd under the same agent is thereby treated as a conflict, not two coexisting connections

#### Scenario: A fresh incumbent with a null startedAt conflicts with a self-reporting daemon

- **GIVEN** an effectively-online `DaemonConnection` for `(agent A, host H, cwd C)` whose `startedAt` is null
- **WHEN** a registration arrives for the same `(agent A, host H, cwd C)` reporting a non-null `startedAt`
- **THEN** the call MUST return a conflict result and MUST NOT mutate the incumbent row

### Requirement: The cwd-null registration branch SHALL be exempt from conflict detection

The legacy compatibility branch for an old daemon that does not self-report `cwd` (the `cwd = null` row, HARD-1) SHALL retain its existing find-then-update-or-create refresh/takeover behavior unchanged and SHALL NOT apply conflict detection. A daemon carrying this feature always self-reports a real cwd and never reaches the null branch; an old daemon neither sends `startedAt` nor can act on a conflict signal, so applying detection there would only break its reconnect.

#### Scenario: An old cwd-null daemon reconnects without conflict

- **GIVEN** a `DaemonConnection` row for `(agent A, clientType claude_code, host H, cwd = null)`
- **WHEN** an old daemon that does not self-report cwd reconnects for the same `(agent A, clientType claude_code, host H, cwd = null)`
- **THEN** the existing null-cwd row MUST be refreshed exactly as before this change
- **AND** no conflict result MUST be produced for the null-cwd branch

### Requirement: The SSE notification route SHALL emit a connection_conflict event instead of connection_registered on a conflict

When `registerConnection` returns a conflict result, the `/api/events/notifications` route SHALL send a single SSE data event of the form `{ "type": "connection_conflict", "host": <host>, "cwd": <cwd> }` to the connecting stream and SHALL NOT send a `connection_registered` event for that stream. For a conflicted stream the route SHALL NOT subscribe the per-connection reverse-control channel and SHALL NOT run the per-connection heartbeat touch or disconnect/reconcile lifecycle, because no row was registered. The same conflict handling SHALL be applied symmetrically by the `/api/events` route. Browser `EventSource` clients, which ignore unrecognized event `type` values, SHALL be unaffected.

#### Scenario: Conflict emits connection_conflict and omits connection_registered

- **GIVEN** a daemon opens the notification SSE stream for an identity that conflicts with a fresh different-process incumbent
- **WHEN** the server processes the registration
- **THEN** the stream MUST receive a `connection_conflict` data event carrying the `host` and `cwd`
- **AND** the stream MUST NOT receive a `connection_registered` event
- **AND** no per-connection control subscription or heartbeat-driven row touch MUST be wired up for that stream

### Requirement: The server SHALL emit a structured log when it rejects a conflicting registration

On each rejected (conflicting) registration the server SHALL emit a single structured log at warn level carrying at least `companyUuid`, `agentUuid`, `host`, `cwd`, and both the incumbent and incoming `startedAt` values, so a duplicate-daemon conflict is diagnosable server-side even when the second daemon's local stderr is captured in a separate journal. This log SHALL be distinct from the error log used for genuine registry write failures (a conflict is an expected outcome, not a failure).

#### Scenario: A rejected conflict is logged with identifying fields

- **WHEN** the server rejects a registration as a conflict
- **THEN** a structured warn log MUST be written including `companyUuid`, `agentUuid`, `host`, `cwd`, and the incumbent-vs-incoming `startedAt`
- **AND** the conflict MUST NOT be logged via the registry write-failure error path

