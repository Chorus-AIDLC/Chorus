## ADDED Requirements

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
