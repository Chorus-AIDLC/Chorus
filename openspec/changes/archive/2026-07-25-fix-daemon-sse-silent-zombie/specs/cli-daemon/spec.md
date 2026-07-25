## MODIFIED Requirements

### Requirement: Reconnect with backfill

When the notification subscription drops, ends, errors, or delivers no bytes for 75 seconds, the daemon SHALL abort that stream, reconnect with its existing bounded backoff, fetch notifications that arrived while it was disconnected, and re-fire any wakes that were missed. Any non-empty byte chunk, including an SSE comment heartbeat or partial frame, SHALL refresh the 75-second deadline. Reconnect and explicit disconnect SHALL clear the prior connection's watchdog so an obsolete timer cannot affect a replacement stream.

#### Scenario: Missed dispatch is recovered on reconnect

- **WHEN** the subscription drops, a `task_assigned` notification is created during the gap, and the subscription then reconnects
- **THEN** the daemon backfills the unhandled notification and wakes Claude Code for it

#### Scenario: Silent stream triggers deterministic reconnect

- **GIVEN** an established notification stream that remains open at the API level
- **WHEN** no bytes arrive for 75 seconds
- **THEN** the daemon MUST abort that stream and enter the normal reconnect flow
- **AND** a successful reconnect MUST invoke notification backfill

#### Scenario: Heartbeat bytes refresh the watchdog

- **GIVEN** an established notification stream
- **WHEN** an SSE comment heartbeat arrives before the 75-second deadline
- **THEN** the daemon MUST refresh the deadline even though the comment is not forwarded as a notification

#### Scenario: Obsolete watchdog cannot abort a replacement stream

- **WHEN** a stream is replaced by reconnect or closed by explicit daemon shutdown
- **THEN** its watchdog MUST be cleared
- **AND** a later callback from that obsolete generation MUST NOT abort the current stream or schedule another reconnect

## ADDED Requirements

### Requirement: Daemon acknowledges notification heartbeat receipt

The daemon SHALL advertise `livenessAck=v1` when opening its SSE subscription. After the handshake identifies the registered connection generation, the daemon SHALL send a best-effort authenticated liveness acknowledgment after receiving each `: heartbeat` comment. The acknowledgment SHALL identify both the connection UUID and registration generation, SHALL NOT be forwarded into the notification or wake pipeline, and SHALL NOT be retried by the generic daemon REST client.

#### Scenario: Upgraded daemon opts into acknowledgment liveness

- **WHEN** an upgraded daemon opens or reopens its notification subscription
- **THEN** the request URL MUST include `livenessAck=v1`
- **AND** all existing self-report and authentication fields MUST remain unchanged

#### Scenario: Received heartbeat is acknowledged but not routed

- **GIVEN** a daemon has received a valid connection registration handshake
- **WHEN** it receives an SSE heartbeat comment
- **THEN** it MUST send one liveness acknowledgment for that connection generation
- **AND** it MUST NOT pass the heartbeat to `onEvent` or create a wake

#### Scenario: Failed acknowledgment does not crash the listener

- **WHEN** a liveness acknowledgment fails because the network or server is unavailable
- **THEN** the listener MUST remain non-throwing and log the failure
- **AND** the failed acknowledgment MUST NOT advance server-side liveness
