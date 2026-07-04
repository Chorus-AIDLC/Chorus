# cli-daemon — delta: graceful shutdown finalizes in-flight turns

## ADDED Requirements

### Requirement: Daemon graceful shutdown SHALL interrupt in-flight wakes and report their turn terminal state before exiting

On SIGINT/SIGTERM, the daemon SHALL stop accepting new wakes, interrupt every in-flight wake subprocess via the existing graceful kill escalation (SIGINT first, SIGKILL after the configured escalation window), and flush each interrupted wake's turn terminal report (`running → interrupted`, reason `shutdown`) to the server before the process exits. Shutdown SHALL be bounded — a wake that cannot be killed or reported within the escalation window plus a hard cap SHALL NOT hang the shutdown indefinitely; server-side offline reconcile remains the backstop for anything left behind. The waker's turn exit report SHALL be outcome-aware generally: a clean subprocess exit reports `ended`; a user-interrupted subprocess reports `interrupted(user)`; a shutdown-killed subprocess reports `interrupted(shutdown)`; a dirty exit with no interrupt requested reports `interrupted(crash)`.

During shutdown, the waker SHALL NOT report a `DaemonExecution` interrupt for the subprocesses it killed: a shutdown-kill is a dirty exit with no user-interrupt flag, which the unchanged crash path would record as the STICKY execution state `interrupted(crash)` — a state the execution offline-reconcile deliberately skips, so every graceful shutdown would strand crash-interrupted execution rows. Instead the execution row is left as-is and the existing execution offline-reconcile flips it `ended` when the connection drops. Outside shutdown, `DaemonExecution` reporting semantics (sticky user-interrupt resumability, crash reporting, offline reconcile) SHALL be unchanged.

#### Scenario: Ctrl-C mid-turn leaves no orphan running turn

- **GIVEN** a daemon with one wake subprocess running (its turn is `running`)
- **WHEN** the daemon receives SIGINT and completes shutdown
- **THEN** the subprocess MUST have been killed via the graceful escalation
- **AND** the turn MUST have been reported `interrupted` with reason `shutdown` before the daemon process exits

#### Scenario: Clean exits still report ended

- **GIVEN** a wake subprocess that exits with code 0 during normal operation
- **WHEN** the waker reports the turn's exit
- **THEN** the report MUST be `running → ended` (unchanged behavior)

#### Scenario: A crashed subprocess reports an interrupted turn

- **GIVEN** a wake subprocess that exits non-zero with no interrupt requested and no shutdown in progress
- **WHEN** the waker reports the turn's exit
- **THEN** the report MUST be `running → interrupted` with reason `crash`

#### Scenario: Shutdown does not strand a sticky crash-interrupted execution row

- **GIVEN** a wake subprocess killed by the shutdown escalation (dirty exit, no user interrupt)
- **WHEN** the waker handles the exit during shutdown
- **THEN** it MUST NOT report the execution as `interrupted(crash)`
- **AND** the execution row MUST be left for the existing offline reconcile to flip `ended` when the connection drops

#### Scenario: Shutdown does not hang on an unkillable wake

- **GIVEN** a wake subprocess that survives the kill escalation
- **WHEN** the shutdown's hard cap elapses
- **THEN** the daemon MUST exit anyway
- **AND** the orphaned turn is left to server-side offline reconcile
