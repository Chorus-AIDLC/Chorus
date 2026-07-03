# daemon-interrupt-resume — delta: crash-exited executions are one-click resumable

## MODIFIED Requirements

### Requirement: A server endpoint SHALL resume a user-interrupted execution via the control channel

The server SHALL expose `POST /api/daemon/resume` (keyed by `connectionUuid` + entity, the same
daemon surface as interrupt — NOT a Task-level endpoint) that resumes an interrupted
execution. It SHALL require the execution row to be `interrupted` with `interruptedReason`
equal to `"user"` OR `"crash"`, and SHALL reject any row that is not (a `running`, `queued`,
or `ended` row is not resumable). It SHALL authorize the caller with the same rule as
interrupt (the connection agent's owner or a `task:admin` caller; a connection absent within
the caller's company → 404 non-disclosure). On success it SHALL transition the row
`interrupted → running` (clearing `interruptedReason`) and SHALL dispatch a `resume` control
command on the reverse control channel to the holding connection, carrying the row's PRIOR
`interruptedReason` as a `resumeReason` field so the daemon can distinguish a crash resume
from a user resume. The daemon SHALL re-dispatch the wake for that entity, continuing the
existing session (Claude Code via `claude --resume <directIdeaUuid>`, codex via its persisted
thread-id mapping — the resume path SHALL be spawner-agnostic). Resume SHALL be
entity-generic (task / idea / proposal / document / daemon_session).

#### Scenario: Resuming a user-interrupted execution re-dispatches it

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "user"`
- **WHEN** an authorized caller POSTs to `/api/daemon/resume` with that connection + entity
- **THEN** the row MUST transition to `running` with `interruptedReason` cleared
- **AND** a `resume` control command with `resumeReason = "user"` MUST be dispatched to the holding connection

#### Scenario: Resuming a crash-interrupted execution re-dispatches it

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "crash"`
- **WHEN** an authorized caller POSTs to `/api/daemon/resume` with that connection + entity
- **THEN** the row MUST transition to `running` with `interruptedReason` cleared
- **AND** a `resume` control command with `resumeReason = "crash"` MUST be dispatched to the holding connection

#### Scenario: A non-interrupted execution is not resumable

- **GIVEN** an execution row whose status is `running`, `queued`, or `ended`
- **WHEN** a caller POSTs to `/api/daemon/resume`
- **THEN** the request MUST be rejected and no `resume` control command MUST be dispatched

#### Scenario: Resume to an offline daemon is refused, leaving the row resumable

- **GIVEN** an `interrupted` execution row (either reason) whose daemon connection is effectively offline
- **WHEN** an authorized caller POSTs to `/api/daemon/resume`
- **THEN** the request MUST be rejected (the transient `resume` control event would otherwise be dropped and silently lost), the row MUST remain `interrupted` (still resumable once the daemon reconnects), and no `resume` control command MUST be dispatched

#### Scenario: The resume control command re-enters the wake path

- **WHEN** the daemon receives a `resume` control command for an entity it is registered to hold
- **THEN** it MUST re-dispatch a wake for that entity (a synthetic `resource_resumed` wake) so the existing wake path continues the session via the active spawner's session-resume mechanism

### Requirement: Resume SHALL be driven by intent — manual for user interrupts, automatic for crashes

A user-requested interrupt SHALL be resumed only by an explicit user action: resuming
re-dispatches work for the same direct-idea session, and the daemon SHALL continue the
existing session (Claude Code `claude --resume <directIdeaUuid>`; codex via its thread-id
mapping) because the session's persisted context already exists. A user-requested interrupt
SHALL NOT be auto-resumed, so an intentional stop is never silently restarted against the
user's intent.

A crash (`interruptedReason = "crash"`) SHALL be recoverable through BOTH paths: manually,
via the same explicit resume action as a user interrupt (covering the case where the daemon
stays online after the subprocess crash, which reconnect-backfill never reaches); and
automatically, by the daemon's existing reconnect-backfill mechanism when the daemon
reconnects. A crash resume that was performed manually SHALL NOT cause the same wake to run
twice when reconnect-backfill later fires: the existing notification/turn dedup (`seen` set)
and per-session queue serialization SHALL bound duplicate delivery.

#### Scenario: A user interrupt waits for an explicit resume

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "user"`
- **WHEN** no user resume action has been taken
- **THEN** the daemon MUST NOT automatically restart the session

#### Scenario: Resuming continues the same session

- **GIVEN** a user resumes an interrupted execution whose session context (on-disk transcript or codex thread mapping) exists
- **WHEN** the wake is re-dispatched
- **THEN** the daemon MUST continue the existing session via the active spawner's resume mechanism rather than starting a new session

#### Scenario: A crash is auto-recovered on reconnect

- **GIVEN** an execution row interrupted with `interruptedReason = "crash"` and a daemon that went offline
- **WHEN** the daemon's reconnect-backfill path next runs
- **THEN** the missed wake MUST be re-fired automatically without a user action

#### Scenario: A crash while the daemon stays online is manually resumable

- **GIVEN** an execution row interrupted with `interruptedReason = "crash"` whose daemon connection remains online
- **WHEN** the user clicks the resume control
- **THEN** the session MUST be resumed via the manual resume path without waiting for a reconnect

### Requirement: The Agent Connections UI SHALL offer interrupt and resume controls

The Agent Connections detail pane AND the daemon chat window's composer action row SHALL
present an interrupt control on each running execution of a connection the viewer is
authorized to control, and a resume control on each execution row that is `interrupted` —
with `interruptedReason = "user"` OR `interruptedReason = "crash"`. A `crash`-interrupted
row SHALL additionally present a concise error indication (that the previous run exited
abnormally) alongside its resume control, and SHALL NOT claim the crash auto-recovers
without user action. Issuing an interrupt SHALL call the control endpoint, and issuing a
resume SHALL call the resume endpoint, with the connection and entity already known from the
execution-state view. The resumed run SHALL continue in the SAME conversation stream in the
chat window (crash → resume → continuation visible in one transcript). All user-facing
strings SHALL be localized in both supported locales, and the design file SHALL be updated
to reflect the new controls.

#### Scenario: Interrupt control on a running row

- **GIVEN** a viewer authorized to control connection C which is running entity E
- **WHEN** the viewer opens C's detail pane
- **THEN** the running row for E MUST present an interrupt control that issues the control command for C and E

#### Scenario: Resume control on a user-interrupted row

- **GIVEN** an execution row interrupted with `interruptedReason = "user"`
- **WHEN** the viewer views it
- **THEN** a resume control MUST be offered that calls the resume endpoint

#### Scenario: Resume control and error indication on a crash-interrupted row

- **GIVEN** an execution row interrupted with `interruptedReason = "crash"`
- **WHEN** the viewer views it in the chat composer action row or the connection detail pane
- **THEN** a resume control MUST be offered that calls the resume endpoint
- **AND** an error indication MUST be shown stating the run exited abnormally
- **AND** no static "auto-recovers" claim MUST be shown

#### Scenario: The resumed run continues the same conversation

- **GIVEN** a crash-interrupted execution resumed from the chat window
- **WHEN** the resumed run produces transcript output
- **THEN** the output MUST appear in the same conversation stream, after the failed run's records

#### Scenario: Control strings are localized

- **WHEN** the interrupt and resume controls render
- **THEN** every user-facing string MUST be present in both supported locales

## ADDED Requirements

### Requirement: A crash resume SHALL inject a crash-specific continue instruction into the resumed wake

The daemon SHALL build the synthetic `resource_resumed` wake prompt according to the resume
kind carried on the control event. When `resumeReason = "crash"`, the prompt SHALL be a
fixed, generated continue instruction that (1) states the previous run on this entity exited
abnormally, (2) instructs the agent to first re-check the current state (via the appropriate
`chorus_get_*` tools and inspection of any partial local work), and (3) instructs it to then
continue the unfinished work. When `resumeReason = "user"` or the field is absent (an older
server), the daemon SHALL use the existing user-resume prompt unchanged — a missing or
unknown `resumeReason` SHALL degrade gracefully and SHALL NOT fail the resume. No user input
SHALL be required to compose the crash instruction, and the instruction SHALL NOT be
persisted as a separate human-instruction turn.

#### Scenario: A crash resume wakes with the crash-specific instruction

- **GIVEN** a daemon receiving a `resume` control command with `resumeReason = "crash"`
- **WHEN** it re-dispatches the wake
- **THEN** the wake prompt MUST state the previous run exited abnormally and instruct the agent to verify current state before continuing

#### Scenario: A user resume keeps the existing prompt

- **GIVEN** a daemon receiving a `resume` control command with `resumeReason = "user"`
- **WHEN** it re-dispatches the wake
- **THEN** the wake prompt MUST be the existing user-resume continue instruction

#### Scenario: A resume without a reason degrades to the user-resume prompt

- **GIVEN** a daemon receiving a `resume` control command with no `resumeReason` field
- **WHEN** it re-dispatches the wake
- **THEN** it MUST resume successfully using the existing user-resume prompt
