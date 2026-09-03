# daemon-activity-presence — delta

## ADDED Requirements

### Requirement: Deterministic connect-time reset of client session-activity state

The client session-activity state SHALL be reset on each dashboard event-stream
connect in a way that is deterministically ordered **before** the server's on-connect
replay of currently-running sessions (this state drives the Idea Tracker
active-session marker). The reset MUST NOT be scheduled in a way whose timing can
interleave with, and erase, the replay events for the same connection.

#### Scenario: Reset is delivered in-band on stream open, before any message

- **WHEN** the shared dashboard `EventSource` fires its `open` event
- **THEN** the transport dispatches a synthetic `stream_reset` event to its
  subscribers synchronously within the open handler
- **AND** because the EventSource spec guarantees `open` fires before any `message`,
  every subscriber receives `stream_reset` before any replayed `session_started`
  message of that connection

#### Scenario: Replayed sessions after a reset survive

- **WHEN** a `stream_reset` event is processed and is then followed by the server's
  replayed `session_started` events for the currently-running sessions
- **THEN** the derived active-session set contains exactly those replayed sessions
- **AND** the reset does not run again after the replay to erase them

#### Scenario: openGeneration bump alone does not clear session-activity

- **WHEN** the stream's `openGeneration` changes (used elsewhere for reconnect
  catch-up and the executions self-heal fetch)
- **THEN** the session-activity state is NOT cleared by that generation change alone
- **AND** clearing happens only in response to the in-band `stream_reset` event

### Requirement: Stable Idea Tracker active-session marker across entry paths

The Idea Tracker SHALL stably display the daemon active-session marker for any idea
that has a running, caller-visible daemon session, regardless of how the Tracker was
entered — direct load, full page reload, a `/ideas`→`/dashboard` redirect, a
notification/search deep link, or an in-app navigation that coincides with an
event-stream reconnect. The marker MAY appear shortly after the stream connects
(realtime, sub-second) rather than on the very first frame, but once the connection's
replay has arrived it MUST NOT be spuriously cleared while the session is still
running.

#### Scenario: Marker survives a stream reconnect

- **WHEN** a daemon session is running on an idea and the dashboard event stream
  reconnects (e.g. tab refocus, network blip, or opening/closing the daemon chat)
- **THEN** after the reconnect's replay the idea's active-session marker is shown
- **AND** it is not left blank by a connect-time reset racing the replay

#### Scenario: Live start/stop still updates the marker

- **WHEN** a daemon session starts or ends on an idea while the Tracker is open
- **THEN** the idea's active-session marker appears or disappears accordingly via the
  live `session_started` / `session_ended` events
