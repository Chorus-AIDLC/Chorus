## MODIFIED Requirements

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
