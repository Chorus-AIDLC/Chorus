# daemon-background-lifecycle delta — fix-daemon-stale-pid-identity

## ADDED Requirements

### Requirement: Identity-verified pidfile liveness

The CLI SHALL verify process identity, not merely pid existence, when deciding whether the pid recorded in `~/.chorus/daemon.pid` is the running daemon. On a `-d` start the CLI SHALL write the pidfile as JSON carrying the pid plus identity metadata (process start time and a command-line hint), preserving read compatibility with the legacy plain-number format. When the liveness probe finds the pid exists (including when signaling it yields `EPERM`), the CLI SHALL query the occupying process's command line and start time via a single cross-platform, pure-JS subprocess query (POSIX `ps`, Windows PowerShell; no native bindings, no `shell:true`) and compare them against the recorded identity: any mismatch SHALL classify the pidfile as stale rather than the daemon as running. For a legacy pidfile with no recorded identity, the CLI SHALL fall back to checking that the live command line contains the chorus daemon marker, classifying it stale otherwise; when the probe on a legacy pidfile yields `EPERM` and the identity query fails, the CLI SHALL classify it stale (EPERM already proves the process belongs to another user, and the CLI and daemon always run as the same user). When a POSIX `ps` rejects the start-time column (e.g. busybox), the CLI SHALL retry with a command-line-only query so cmdline verification still functions. In all other query-failure cases (an identity-carrying pidfile, or a pid the CLI can signal) the CLI SHALL retain the prior conservative behavior (the pid counts as running) so an unverifiable live daemon is never misclassified. The identity check SHALL live in the shared liveness probe so `start -d`, `status`, `stop`, and `restart` all use the same verdict.

#### Scenario: Reboot-recycled pid is classified stale, not running

- **WHEN** `~/.chorus/daemon.pid` records identity metadata for a daemon that died at reboot, the pid has been recycled to another user's process (probe yields EPERM), and the user runs any lifecycle command
- **THEN** the identity comparison fails, the pidfile is treated as stale — `stop` clears it and reports the stale cleanup, `status` reports not running, and `-d` starts a fresh daemon instead of refusing

#### Scenario: Live daemon still matches its recorded identity

- **WHEN** the recorded pid is the still-running chorus daemon whose start time and command line match the pidfile metadata
- **THEN** the probe reports running and lifecycle commands behave as for a live daemon (stop signals it, `-d` refuses to double-start)

#### Scenario: Legacy plain-number pidfile self-heals via cmdline fallback

- **WHEN** the pidfile contains only a bare pid written by an older CLI and the occupying process's command line does not contain the chorus daemon marker
- **THEN** the pidfile is classified stale and cleaned up, without requiring identity metadata to have been recorded

#### Scenario: Unverifiable identity on an identity-carrying pidfile keeps conservative behavior

- **WHEN** the pidfile carries recorded identity metadata but the identity query fails (e.g. `ps` unavailable or unparsable output)
- **THEN** the CLI treats the daemon as running — it never auto-cleans an identity-carrying pidfile it could not verify

#### Scenario: Legacy pidfile with EPERM self-heals even when the query fails

- **WHEN** the pidfile is legacy (no identity metadata), signaling its pid yields EPERM, and the identity query fails (e.g. minimal busybox `ps`)
- **THEN** the CLI classifies the pidfile stale and self-heals — the original stuck state does not survive on systems with a minimal `ps`

### Requirement: Forced stop escape hatch

The CLI SHALL accept `chorus daemon stop --force`, which best-effort signals the recorded pid and then removes the pidfile unconditionally, reporting the forced cleanup. When a non-forced `stop` reaches the actual termination signal and that signal fails, the CLI SHALL NOT remove the pidfile automatically; its error message SHALL state that the pid may have been recycled by the operating system and SHALL name `chorus daemon stop --force` as the recovery command. `restart` SHALL keep non-forced stop semantics. `stop` SHALL exit 0 whenever it leaves the system with no daemon running and no pidfile (stopped, stale-cleared, or forced) and SHALL exit non-zero for not-running and signal-failure outcomes.

#### Scenario: stop --force clears a stuck pidfile

- **WHEN** the user runs `chorus daemon stop --force` while the pidfile records a pid the CLI cannot signal
- **THEN** the pidfile is removed, the CLI reports the forced cleanup, and a subsequent `chorus daemon -d` starts normally

#### Scenario: failed SIGTERM guides to --force without auto-cleanup

- **WHEN** a non-forced `chorus daemon stop` passes the liveness probe but the termination signal fails (e.g. a probe race)
- **THEN** the pidfile is left in place and the error message explains the pid may have been recycled and points to `chorus daemon stop --force`

## MODIFIED Requirements

### Requirement: Lifecycle subcommands stop / status / restart / logs

The CLI SHALL provide `chorus daemon stop`, `chorus daemon status`,
`chorus daemon restart`, and `chorus daemon logs` operating on the pidfile/logfile
managed by the `-d` path. `stop` SHALL terminate the recorded daemon process and
clean up the pidfile. `status` SHALL report whether the daemon is running (and
basic info such as pid). `restart` SHALL stop any running instance and start a new
detached one. `logs` SHALL display the daemon logfile. Each subcommand SHALL
behave sanely and report visibly when no daemon is running (no silent failure).
Whether a recorded pid counts as "running" SHALL be decided by the
identity-verified liveness probe (see "Identity-verified pidfile liveness"), so a
stale pidfile whose pid was recycled to a foreign process is cleaned up and
reported as such rather than producing a signal error.

#### Scenario: stop terminates the running daemon

- **WHEN** the user runs `chorus daemon stop` while a daemon is running
- **THEN** the recorded process is terminated and the pidfile is removed

#### Scenario: stop self-heals a recycled-pid pidfile

- **WHEN** the user runs `chorus daemon stop` while the pidfile's pid has been recycled to a process that fails identity verification
- **THEN** the CLI clears the stale pidfile and reports the cleanup instead of failing with a signal error

#### Scenario: status reports running state

- **WHEN** the user runs `chorus daemon status`
- **THEN** the CLI reports whether a daemon is running and, if so, its pid

#### Scenario: restart cycles the daemon

- **WHEN** the user runs `chorus daemon restart`
- **THEN** any running instance is stopped and a new detached instance is started

#### Scenario: logs shows the daemon output

- **WHEN** the user runs `chorus daemon logs`
- **THEN** the CLI displays the contents of `~/.chorus/daemon.log`

#### Scenario: lifecycle commands report when nothing is running

- **WHEN** the user runs `stop`, `status`, `restart`, or `logs` with no daemon
  running
- **THEN** the CLI reports the absence clearly and does not fail silently
