# openclaw-event-bridge Specification

## ADDED Requirements

### Requirement: The plugin SHALL capture its own connectionUuid from the connection_registered event

The OpenClaw plugin's SSE listener SHALL expose an `onConnectionId` callback and the server's post-handshake `connection_registered` event (carrying `connectionUuid`) SHALL be routed to it and stored as the connection's identity, rather than being discarded as an unhandled event. The stored `connectionUuid` SHALL be made available to the daemon reporting client and the control handler. On reconnect, the listener SHALL refresh the stored `connectionUuid` from the new `connection_registered` event. The `connection_registered` event SHALL NOT enter the wake path.

#### Scenario: connection_registered populates the stored connectionUuid

- **WHEN** the server sends a `connection_registered` event after the SSE handshake
- **THEN** the plugin MUST store the supplied `connectionUuid` as its connection identity
- **AND** that value MUST be readable by the daemon reporting client and the control handler

#### Scenario: connection_registered is not treated as a wake

- **WHEN** the `connection_registered` event is dispatched
- **THEN** it MUST NOT enqueue a wake or spawn an agent run
- **AND** it MUST NOT be logged as an ignored/unhandled event

#### Scenario: Reconnect refreshes the connectionUuid

- **GIVEN** an established connection whose stream drops and reconnects
- **WHEN** the server sends a new `connection_registered` on reconnect
- **THEN** the plugin MUST replace its stored `connectionUuid` with the new value

### Requirement: The plugin SHALL subscribe and route the reverse control channel without entering the wake path

The OpenClaw plugin's SSE listener SHALL expose an `onControl` callback and SHALL fork SSE events whose `type` is `control` to a control handler, distinct from the `new_notification` wake path. The control handler SHALL act on a command only when the event's `targetConnectionUuid` equals the plugin's stored `connectionUuid` (and, for `interrupt`, only when the plugin currently holds a running entity matching the command), and SHALL otherwise log and ignore the command. A control event SHALL NEVER enqueue a wake or spawn a new agent run for the control event itself. The handler SHALL route `interrupt`, `resume`, and `deliver_turn` to their respective behaviors (defined by the `openclaw-daemon-client` capability).

#### Scenario: A control event is forked to the control handler, not the wake path

- **WHEN** the plugin receives an SSE event with `type = "control"`
- **THEN** it MUST route the event to the control handler via `onControl`
- **AND** it MUST NOT enqueue a wake or spawn an agent run for the control event

#### Scenario: A control command for another connection is ignored

- **GIVEN** the plugin's stored `connectionUuid` is C
- **WHEN** it receives a control command whose `targetConnectionUuid` is not C
- **THEN** it MUST log and ignore the command and MUST NOT abort, resume, or deliver anything

#### Scenario: The three control commands are routed

- **WHEN** the control handler receives a verified `interrupt`, `resume`, or `deliver_turn` command for its own connection
- **THEN** it MUST route `interrupt` to abort the matching in-flight run, `resume` to re-dispatch the entity's wake, and `deliver_turn` to the connection-scoped pending-turns sweep
