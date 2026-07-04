# daemon-session-conversation — delta: orphan running turns get a terminal `interrupted` state

## MODIFIED Requirements

### Requirement: Every daemon wake SHALL be recorded as a turn on its DaemonSession

The server SHALL define a Prisma model `DaemonSessionTurn` representing one wake on a conversation. It SHALL carry at least: `uuid`, `sessionUuid` (referencing `DaemonSession.uuid`), `seq` (monotonic per session), `trigger` (one of `task_assigned`, `mentioned`, `elaboration`, `elaboration_verified`, `start_development`, `resume`, `human_instruction`), `promptText` (nullable — the free-text instruction body for a `human_instruction` turn, null for autonomous triggers), `status` (`pending` | `running` | `ended` | `interrupted`), `interruptedReason` (nullable — `user` | `crash` | `shutdown` | `offline`, set if and only if `status = "interrupted"`), `startedAt` (nullable), `endedAt` (nullable), and `createdAt`. Every wake-triggering event — whether an autonomous dispatch (task assignment, @mention, elaboration request, elaboration verified, start development, resume) or a human-typed instruction — SHALL produce exactly one turn on the corresponding `DaemonSession`, distinguished only by `trigger`. A turn SHALL reference the live execution it corresponds to (so the conversation turn and the `DaemonExecution` row are linked) without altering `DaemonExecution` reconcile semantics. The `trigger` field is a free-form string column; extending the enumeration SHALL NOT require a data-mutating migration.

The turn status state machine SHALL be: `pending → running`, `running → ended`, `running → interrupted`; `ended` and `interrupted` are terminal. Skips (including `pending → interrupted` — a pending turn is recoverable via backfill and stays pending), backward moves, and same-status re-application SHALL be rejected as invalid transitions that write nothing. The `interrupted` transition SHALL record `endedAt` (an interrupted turn has a definite end time) and persist the supplied `interruptedReason`. An interrupted turn SHALL NOT be automatically re-dispatched or reverted to `pending` — resending is a human decision.

#### Scenario: An autonomous task dispatch records a turn

- **GIVEN** a task is assigned to a daemon agent, producing a wake on session I
- **WHEN** the server records the wake
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "task_assigned"`

#### Scenario: A human instruction records a turn carrying its text

- **GIVEN** a human submits a free-text instruction to session I
- **WHEN** the server records it
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "human_instruction"` and `promptText` set to the submitted text

#### Scenario: An elaboration-verified wake records a turn

- **GIVEN** a human verifies the elaboration of an idea-anchored session I
- **WHEN** the server records the wake
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "elaboration_verified"`

#### Scenario: A start-development wake records a turn

- **GIVEN** a human clicks Start Development for an idea anchored to session I
- **WHEN** the server records the wake
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "start_development"`

#### Scenario: Turn trigger distinguishes wake kinds on one conversation

- **GIVEN** session I has received a task assignment, an @mention, and a human instruction
- **WHEN** the session's turns are listed
- **THEN** all three MUST appear as turns on the same `DaemonSession`, distinguished by their `trigger` values

#### Scenario: A turn links to its execution without changing execution semantics

- **WHEN** a turn begins running and a `DaemonExecution` row reflects the running entity
- **THEN** the turn MUST reference that execution
- **AND** the `DaemonExecution` snapshot-reconcile behavior MUST be unchanged by the turn linkage

#### Scenario: A running turn can be finalized as interrupted with a reason

- **GIVEN** a turn in status `running`
- **WHEN** it is advanced to `interrupted` with reason `shutdown`
- **THEN** the turn MUST persist `status = "interrupted"`, `interruptedReason = "shutdown"`, and a non-null `endedAt`
- **AND** the `turn_status_changed` SSE trigger MUST be published exactly as for an `ended` transition

#### Scenario: Interrupted and ended are both terminal

- **GIVEN** a turn in status `interrupted` (or `ended`)
- **WHEN** any further status transition is attempted (including a late `running → ended` report from a daemon that reconnected after the server already finalized the turn)
- **THEN** the transition MUST be rejected as invalid, writing nothing
- **AND** the rejection MUST be logged visibly, never crash the reporting side

#### Scenario: A pending turn is never interrupted

- **GIVEN** a turn in status `pending` whose connection goes offline
- **WHEN** orphan reconcile runs
- **THEN** the turn MUST remain `pending` (it stays recoverable via reconnect backfill)

## ADDED Requirements

### Requirement: The server SHALL finalize a running turn whose origin connection is stale

The server SHALL reconcile orphaned `running` turns — turns whose owning session's `originConnectionUuid` resolves to a connection whose `lastSeenAt` is older than the registry's single staleness threshold — by finalizing them to `interrupted` with `interruptedReason = "offline"`, routing through the same status-transition chokepoint (legality check + SSE emission) as every other transition. Orphan eligibility SHALL be judged by `lastSeenAt` age ONLY — never by the connection's stored `status` alone — because `status` flips to `offline` the instant an SSE stream aborts, and a read landing in a transient abort→reconnect gap would otherwise falsely interrupt a genuinely live turn. Two triggers SHALL exist: (1) an event-driven trigger armed from the daemon SSE stream's abort path that runs after the staleness window elapses and re-verifies age-based staleness before writing (so a transient reconnect, whose heartbeat refreshed `lastSeenAt`, makes it a no-op), and (2) a read-time fallback on the daemon-session read paths that detects and finalizes such turns inline when a session is read, so daemon deaths that never fired an abort (hard kill, server restart losing the timer) and pre-existing dirty rows converge without any data-mutating migration. Both triggers SHALL be idempotent through the state machine (a concurrent daemon report or duplicate reconcile loses the race as a logged invalid transition, harmless). Reconcile failures on fire-and-forget paths SHALL be logged, never thrown into stream teardown.

#### Scenario: Daemon killed hard, turn converges on next read

- **GIVEN** a daemon is killed with SIGKILL while a turn is `running`, so no abort fires and no daemon report will ever arrive
- **WHEN** the session is next read after the connection's `lastSeenAt` has aged past the staleness threshold
- **THEN** the turn MUST be finalized `interrupted` with reason `offline` and the read MUST return it in that state

#### Scenario: Transient SSE reconnect does not interrupt a live turn

- **GIVEN** a daemon's SSE stream aborts while a turn is `running` and the daemon reconnects within the staleness window
- **WHEN** the deferred reconcile armed by the abort runs
- **THEN** it MUST re-verify age-based staleness and write nothing (the turn stays `running`)

#### Scenario: A session read during the abort→reconnect gap does not interrupt a live turn

- **GIVEN** a daemon's SSE stream just aborted (connection `status` = `offline`) but its `lastSeenAt` is younger than the staleness threshold
- **WHEN** the session is read
- **THEN** the read-time fallback MUST NOT finalize the running turn (age-only rule; `status` alone is not evidence of death)

#### Scenario: Legacy dirty rows converge without migration DML

- **GIVEN** turns left permanently `running` by daemon exits that predate this change
- **WHEN** their sessions are read
- **THEN** the read-time fallback MUST finalize them `interrupted(offline)`
- **AND** no data-mutating migration is required for this convergence

#### Scenario: Reconcile loses the race to the daemon's own report

- **GIVEN** the daemon reports `running → ended` at the same moment the server reconcile attempts `running → interrupted`
- **WHEN** both writes reach the transition chokepoint
- **THEN** exactly one MUST win and the loser MUST be rejected as an invalid transition that writes nothing
