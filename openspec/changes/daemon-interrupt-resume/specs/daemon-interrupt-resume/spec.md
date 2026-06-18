# daemon-interrupt-resume Specification

## ADDED Requirements

### Requirement: Control commands SHALL travel a reverse channel that is distinct from the wake path

The system SHALL provide a server→daemon control channel that reuses the existing
notification SSE transport but is NOT the wake path. A control command SHALL be delivered as
a dedicated SSE event whose `type` is `control` (not a persisted `Notification`), and the
daemon SHALL route it to a control handler WITHOUT enqueuing any wake. The control command
action SHALL NOT be a member of the daemon's `WAKE_ACTIONS` set, and receiving a control
event SHALL NOT spawn a new Claude subprocess. The server-side publish step SHALL be hidden
behind a single control-dispatch function so a future dedicated bidirectional channel can
replace the transport without changing callers.

#### Scenario: A control event does not produce a wake

- **WHEN** the daemon receives an SSE event with `type = "control"`
- **THEN** it MUST route the event to its control handler
- **AND** it MUST NOT enqueue anything on the WakeQueue or spawn a new subprocess

#### Scenario: Control commands are not persisted notifications

- **WHEN** an interrupt is issued
- **THEN** the delivered control event MUST NOT be created as a `Notification` row
- **AND** its action MUST NOT appear in `WAKE_ACTIONS`

#### Scenario: The transport is isolated behind a dispatch seam

- **WHEN** the control endpoint publishes a command
- **THEN** it MUST do so through a single control-dispatch function that encapsulates the
  notification-stream transport, so the transport can be swapped without changing the
  endpoint or its callers

### Requirement: The server SHALL expose an agent/user-callable endpoint that issues a daemon control command

The server SHALL expose `POST /api/daemon/control` that accepts a control command targeting a
specific daemon connection: `{ command, targetConnectionUuid, entityType, entityUuid }`. The
endpoint SHALL require authentication, SHALL NOT be implemented as an MCP tool, and SHALL NOT
introduce a new permission bit. It SHALL use the standard API envelope. The endpoint SHALL
validate the request body and SHALL reject an unknown `command`. On success it SHALL publish
the control event to the target connection and return without waiting for the kill to
complete; the resulting task state transition SHALL be reported asynchronously by the daemon.

#### Scenario: An unauthenticated control request is rejected

- **GIVEN** a request to `POST /api/daemon/control` with no valid auth
- **WHEN** the server handles it
- **THEN** the response status MUST be 401 and no control event MUST be published

#### Scenario: A well-formed interrupt is accepted and published

- **GIVEN** an authorized caller and a `targetConnectionUuid` that exists in the caller's company
- **WHEN** the caller POSTs `{ command: "interrupt", targetConnectionUuid, entityType, entityUuid }`
- **THEN** the response MUST be the standard success envelope
- **AND** a control event for that connection MUST be published on the event bus

#### Scenario: An unknown command is rejected

- **WHEN** the caller POSTs a `command` outside the accepted set
- **THEN** the server MUST reject the request with a client error and publish nothing

### Requirement: Only the daemon agent's owner or a task:admin caller SHALL be authorized to interrupt

The control endpoint SHALL authorize the caller against the agent that owns the target
connection: it SHALL resolve `targetConnectionUuid` to its `DaemonConnection` within the
caller's company, resolve that connection's agent and the agent's owner, and SHALL allow the
command only when the caller is that owner OR the caller holds `task:admin`. A connection that
does not exist within the caller's company SHALL yield a not-found response that does not
reveal another company's or another owner's connection. A caller who is neither the owner nor
a `task:admin` SHALL be forbidden. Authorization SHALL NOT cross company boundaries.

#### Scenario: The owner may interrupt their agent's subprocess

- **GIVEN** user U owns the agent behind connection C
- **WHEN** U issues an interrupt targeting C
- **THEN** the command MUST be authorized and published

#### Scenario: A task:admin may interrupt

- **GIVEN** a caller holding `task:admin` in the same company as connection C
- **WHEN** the caller issues an interrupt targeting C
- **THEN** the command MUST be authorized

#### Scenario: A non-owner without task:admin is forbidden

- **GIVEN** a caller who neither owns the agent behind connection C nor holds `task:admin`
- **WHEN** the caller issues an interrupt targeting C
- **THEN** the response MUST be 403 and no control event MUST be published

#### Scenario: Targeting another company's connection does not disclose it

- **GIVEN** connection C belongs to an agent in a different company
- **WHEN** a caller issues an interrupt naming `targetConnectionUuid = C`
- **THEN** the response MUST be a not-found that does not confirm C exists
- **AND** no control event MUST be published

### Requirement: The control event SHALL be delivered to the targeted connection and verified twice on the daemon

The control event SHALL be keyed per connection (`control:{connectionUuid}`) so it reaches
only the daemon stream holding that connection, not every connection of the agent. The
daemon's SSE route SHALL subscribe the per-connection handler to this key (only for a
registered daemon connection) and tear it down on disconnect. The daemon SHALL act on a
control command only when BOTH hold: the event's `targetConnectionUuid` equals the daemon's
own registered connection uuid, AND the daemon's in-memory execution registry confirms it
currently holds a running subprocess for the command's `{entityType, entityUuid}`. If either
check fails, the daemon SHALL ignore the command (logged, no action), so a stale or recycled
connection uuid can never cause the wrong subprocess to be killed.

#### Scenario: Both checks pass — the command acts

- **GIVEN** a daemon registered as connection C currently running a subprocess for entity E
- **WHEN** it receives a control event with `targetConnectionUuid = C` and entity E
- **THEN** it MUST proceed to interrupt that subprocess

#### Scenario: Connection-uuid mismatch is ignored

- **GIVEN** a daemon registered as connection C
- **WHEN** it receives a control event whose `targetConnectionUuid` is not C
- **THEN** it MUST ignore the command and MUST NOT touch any subprocess

#### Scenario: Entity not held is ignored

- **GIVEN** a daemon registered as connection C with no running subprocess for entity E
- **WHEN** it receives a control event for `targetConnectionUuid = C` and entity E
- **THEN** it MUST ignore the command (logged) and MUST NOT kill an unrelated subprocess

#### Scenario: The control subscription is removed on disconnect

- **WHEN** a daemon connection's stream aborts
- **THEN** its `control:{connectionUuid}` subscription MUST be torn down alongside its
  notification subscription

### Requirement: The daemon SHALL map an interrupt target to its running subprocess via the execution registry

The daemon SHALL resolve a control command's `{entityType, entityUuid}` to the concrete
running subprocess by extending the existing in-memory execution registry (the same
`entityType:entityUuid`-keyed map that produces the execution snapshot) to also hold the live
child process handle for a running wake. The uploaded execution snapshot SHALL continue to
carry only its serializable fields and SHALL NOT include the child handle. A queued (not yet
running) entry SHALL carry no child handle.

#### Scenario: An interrupt resolves to the running child via the registry

- **GIVEN** a wake for entity E is running and its registry entry holds the child handle
- **WHEN** an authorized interrupt for E is verified
- **THEN** the daemon MUST obtain the child handle from the registry entry for E and target it

#### Scenario: The child handle never leaks into the snapshot

- **WHEN** the daemon builds an execution snapshot for upload
- **THEN** the snapshot entries MUST contain only the serializable execution fields
- **AND** MUST NOT contain the child process handle

### Requirement: Interrupting SHALL use a two-stage stop with a configurable timeout

On interrupt the daemon SHALL first attempt a graceful stop by sending `SIGINT` to the
running subprocess, giving it the opportunity to flush in-progress work, and SHALL escalate to
a forceful kill only if the subprocess has not exited within a configurable timeout. The
timeout SHALL default to 10 seconds and SHALL be resolvable through the daemon's layered
configuration (command-line flag, then the `CHORUS_DAEMON_SIGINT_TIMEOUT` environment
variable, then `~/.chorus/daemon.json`, then the default), consistent with the daemon's
existing layered resolution style. The kill procedure SHALL never throw into the wake path and
SHALL log its actions visibly.

#### Scenario: Graceful stop within the timeout

- **GIVEN** a running subprocess that exits after receiving `SIGINT` before the timeout
- **WHEN** an interrupt is processed
- **THEN** the daemon MUST send `SIGINT`, observe the exit, and NOT escalate to a forceful kill

#### Scenario: Escalation after the timeout

- **GIVEN** a running subprocess that does not exit within the configured timeout after `SIGINT`
- **WHEN** the timeout elapses
- **THEN** the daemon MUST escalate to a forceful kill of the subprocess

#### Scenario: The timeout is configurable with layered precedence

- **WHEN** the SIGINT-escalation timeout is resolved
- **THEN** a command-line flag MUST override the environment variable, which MUST override the
  config file, which MUST override the built-in default of 10 seconds

### Requirement: The forceful kill SHALL terminate the whole process tree cross-platform without native dependencies

The daemon SHALL terminate the entire subprocess tree (the spawned Claude and any
grandchildren it spawned), not only the direct child pid, using only platform commands and
Node built-ins — no npm package with native bindings. On POSIX the daemon SHALL spawn the
subprocess in its own process group (detached) and signal the group, so a group kill reaches
descendants. On Windows the daemon SHALL terminate the tree via the platform `taskkill`
facility targeting the pid with tree and force flags. Spawning in a process group SHALL NOT
change prompt delivery over stdin or the parsing of the subprocess's stream-json output.

#### Scenario: POSIX group kill reaches descendants

- **GIVEN** a POSIX daemon whose subprocess was spawned in its own process group and spawned a grandchild
- **WHEN** the daemon forcefully kills the subprocess
- **THEN** it MUST signal the process group so the grandchild is also terminated, leaving no orphan

#### Scenario: Windows terminates the tree via taskkill

- **GIVEN** a Windows daemon running a subprocess tree
- **WHEN** the daemon forcefully kills it
- **THEN** it MUST terminate the whole tree by pid using the platform tree-and-force termination, without a native-binding dependency

#### Scenario: Process-group spawn does not regress IO

- **WHEN** the subprocess is spawned in its own process group on POSIX
- **THEN** the prompt MUST still be delivered over stdin and the stream-json output MUST still parse line by line

### Requirement: The execution row SHALL carry an interrupted state distinguishing user interrupts from crashes

The interrupted state SHALL live on the daemon EXECUTION record (`DaemonExecution`, keyed by
connection + entity), NOT on the `Task` model — because the daemon executes task, idea,
proposal, and document wakes, so interruption is an execution-lifecycle fact that MUST apply to
any wake-triggering resource, not only tasks. The `DaemonExecution` model SHALL support an
`interrupted` status and SHALL carry an `interruptedReason` that is `user` when an authorized
user requested the interrupt and `crash` when the subprocess exited unexpectedly without an
interrupt request. Both causes SHALL share the single `interrupted` status, distinguished only
by `interruptedReason`. The `Task` model SHALL NOT gain an interrupted status or reason field.
The new field SHALL be delivered by a Prisma-CLI-generated migration containing only DDL (no
data backfill).

`interrupted` SHALL be a STICKY status: snapshot reconcile and offline reconcile (which transition
`running`/`queued` rows to `ended` when no longer justified) SHALL NOT transition an `interrupted`
row to `ended` — so an interrupted, resumable row keeps showing after the killed subprocess drops
out of the daemon's next snapshot. The reason SHALL be cleared (back to null, status back to
`running`) only when a resume re-dispatch reports the entity active again.

#### Scenario: A user interrupt marks the execution row interrupted with reason user

- **GIVEN** a running execution row for an entity whose subprocess is interrupted on an authorized user request
- **WHEN** the daemon reports the outcome
- **THEN** that connection+entity execution row's status MUST become `interrupted` with `interruptedReason = "user"`

#### Scenario: A crash marks the execution row interrupted with reason crash

- **GIVEN** a running execution row whose subprocess exits unexpectedly with no interrupt requested
- **WHEN** the daemon reports the outcome
- **THEN** the execution row status MUST become `interrupted` with `interruptedReason = "crash"`

#### Scenario: An interrupted row is sticky across reconcile

- **GIVEN** an `interrupted` execution row that is absent from the daemon's next snapshot
- **WHEN** snapshot reconcile (or offline reconcile) runs
- **THEN** the row MUST remain `interrupted` and MUST NOT be transitioned to `ended`

#### Scenario: Interruption applies to a non-task wake

- **GIVEN** a running execution row whose entity is an idea (an @-mention/elaboration wake)
- **WHEN** its subprocess is interrupted
- **THEN** the idea's execution row MUST become `interrupted` — the interrupted state is not task-only

#### Scenario: The Task model is unchanged

- **WHEN** the schema change is implemented
- **THEN** the `Task` model MUST NOT gain an `interrupted` status value or an `interruptedReason` field
- **AND** the generated migration MUST contain only schema DDL and MUST NOT contain data backfill statements

### Requirement: A server endpoint SHALL resume a user-interrupted execution via the control channel

The server SHALL expose `POST /api/daemon/resume` (keyed by `connectionUuid` + entity, the same
daemon surface as interrupt — NOT a Task-level endpoint) that resumes a user-interrupted
execution. It SHALL require the execution row to be `interrupted` with `interruptedReason =
"user"` and SHALL reject a row that is not (in particular a `crash`-interrupted row, which is
auto-recovered and SHALL NOT be manually resumable). It SHALL authorize the caller with the same
rule as interrupt (the connection agent's owner or a `task:admin` caller; a connection absent
within the caller's company → 404 non-disclosure). On success it SHALL transition the row
`interrupted → running` (clearing `interruptedReason`) and SHALL dispatch a `resume` control
command on the reverse control channel to the holding connection. The daemon SHALL re-dispatch
the wake for that entity, continuing the existing session via `claude --resume <directIdeaUuid>`
(the on-disk transcript already exists). Resume SHALL be entity-generic (task / idea / proposal /
document).

#### Scenario: Resuming a user-interrupted execution re-dispatches it

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "user"`
- **WHEN** an authorized caller POSTs to `/api/daemon/resume` with that connection + entity
- **THEN** the row MUST transition to `running` with `interruptedReason` cleared
- **AND** a `resume` control command MUST be dispatched to the holding connection

#### Scenario: A crash-interrupted execution is not manually resumable

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "crash"`
- **WHEN** a caller POSTs to `/api/daemon/resume`
- **THEN** the request MUST be rejected and no `resume` control command MUST be dispatched

#### Scenario: Resume to an offline daemon is refused, leaving the row resumable

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "user"` whose daemon connection is effectively offline
- **WHEN** an authorized caller POSTs to `/api/daemon/resume`
- **THEN** the request MUST be rejected (the transient `resume` control event would otherwise be dropped and silently lost), the row MUST remain `interrupted` (still resumable once the daemon reconnects), and no `resume` control command MUST be dispatched

#### Scenario: The resume control command re-enters the wake path

- **WHEN** the daemon receives a `resume` control command for an entity it is registered to hold
- **THEN** it MUST re-dispatch a wake for that entity (a synthetic `resource_resumed` wake) so the existing wake path continues the session via `--resume`

### Requirement: Resume SHALL be driven by intent — manual for user interrupts, automatic for crashes

A user-requested interrupt SHALL be resumed only by an explicit user action: resuming
re-dispatches work for the same direct-idea session, and the daemon SHALL continue the
existing Claude session (`claude --resume <directIdeaUuid>`) because its on-disk transcript
already exists. An unexpected crash (`interruptedReason = crash`) SHALL be recovered
automatically by the daemon's existing reconnect-backfill mechanism, with no user action. A
user-requested interrupt SHALL NOT be auto-resumed, so an intentional stop is never silently
restarted against the user's intent.

#### Scenario: A user interrupt waits for an explicit resume

- **GIVEN** an execution row that is `interrupted` with `interruptedReason = "user"`
- **WHEN** no user resume action has been taken
- **THEN** the daemon MUST NOT automatically restart the session

#### Scenario: Resuming continues the same session

- **GIVEN** a user resumes an interrupted execution whose direct-idea transcript exists on disk
- **WHEN** the wake is re-dispatched
- **THEN** the daemon MUST continue the existing session via `--resume <directIdeaUuid>` rather than starting a new session

#### Scenario: A crash is auto-recovered

- **GIVEN** an execution row interrupted with `interruptedReason = "crash"`
- **WHEN** the daemon's reconnect-backfill path next runs
- **THEN** the missed wake MUST be re-fired automatically without a user action

### Requirement: The Agent Connections UI SHALL offer interrupt and resume controls

The Agent Connections detail pane SHALL present an interrupt control on each running execution
row of a connection the viewer is authorized to control, and a resume control on each execution
row that is `interrupted` with `interruptedReason = "user"`. A `crash`-interrupted row SHALL
show no resume control (only a static "auto-recovers" hint). Issuing an interrupt SHALL call the
control endpoint, and issuing a resume SHALL call the resume endpoint, with the connection and
entity already known from the execution-state view. All user-facing strings SHALL be localized
in both supported locales, and the design file SHALL be updated to reflect the new controls.

#### Scenario: Interrupt control on a running row

- **GIVEN** a viewer authorized to control connection C which is running entity E
- **WHEN** the viewer opens C's detail pane
- **THEN** the running row for E MUST present an interrupt control that issues the control command for C and E

#### Scenario: Resume control on a user-interrupted row

- **GIVEN** an execution row interrupted with `interruptedReason = "user"`
- **WHEN** the viewer views it
- **THEN** a resume control MUST be offered that calls the resume endpoint
- **AND** a `crash`-interrupted row MUST show no resume control

#### Scenario: Control strings are localized

- **WHEN** the interrupt and resume controls render
- **THEN** every user-facing string MUST be present in both supported locales
