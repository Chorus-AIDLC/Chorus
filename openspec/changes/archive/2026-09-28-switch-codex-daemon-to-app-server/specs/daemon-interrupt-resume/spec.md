## MODIFIED Requirements

### Requirement: Interrupting SHALL use a two-stage stop with a configurable timeout

On interrupt the daemon SHALL first attempt a graceful stop using a registered process-associated protocol stop hook, or SIGINT when no hook exists. It SHALL escalate to forceful process-tree cleanup if the process/tree remains after the configurable graceful timeout or protocol failure requires cleanup. Protocol cancellation and graceful exit MUST share one deadline rather than each adding another full timeout. The
timeout SHALL default to 10 seconds and SHALL be resolvable through the daemon's layered
configuration (command-line flag, then the `CHORUS_DAEMON_SIGINT_TIMEOUT` environment
variable, then `~/.chorus/daemon.json`, then the default), consistent with the daemon's
existing layered resolution style. The kill procedure SHALL never throw into the wake path and
SHALL log its actions visibly.

#### Scenario: Graceful stop within the timeout

- **GIVEN** a running subprocess without a protocol stop hook that exits after receiving `SIGINT` before the timeout
- **WHEN** an interrupt is processed
- **THEN** the daemon MUST send `SIGINT`, observe the exit, and NOT escalate to a forceful kill

#### Scenario: Escalation after the timeout

- **GIVEN** a running subprocess without a protocol stop hook that does not exit within the configured timeout after `SIGINT`
- **WHEN** the timeout elapses
- **THEN** the daemon MUST escalate to a forceful kill of the subprocess

#### Scenario: The timeout is configurable with layered precedence

- **WHEN** the SIGINT-escalation timeout is resolved
- **THEN** a command-line flag MUST override the environment variable, which MUST override the
  config file, which MUST override the built-in default of 10 seconds

#### Scenario: Protocol stop shares the same timeout
- **WHEN** a child has a protocol stop hook
- **THEN** the daemon MUST attempt protocol cancellation and exit within the same resolved graceful deadline and force tree cleanup if it does not finish

#### Scenario: Shutdown uses the same capability
- **WHEN** daemon shutdown stops a protocol-capable child
- **THEN** it MUST use the same bounded cleanup while preserving the existing shutdown reporting semantics
