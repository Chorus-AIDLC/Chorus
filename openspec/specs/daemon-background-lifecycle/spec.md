# daemon-background-lifecycle Specification

## Purpose
TBD - created by archiving change improve-daemon-cli-ux. Update Purpose after archive.
## Requirements
### Requirement: Background run via `-d` with pidfile and logfile

The CLI SHALL accept `chorus daemon -d` to run the daemon detached in the
background. On a `-d` start the CLI SHALL spawn the long-lived daemon as a
detached child whose stdout/stderr are redirected to a logfile at
`~/.chorus/daemon.log`, SHALL write the child's process id to a pidfile at
`~/.chorus/daemon.pid`, and SHALL return control to the foreground shell. The
implementation SHALL be pure Node with no native-binding dependency and SHALL work
on Linux, macOS, and Windows without relying on `shell:true`. If a daemon already
appears to be running (a live pid in the pidfile), `-d` SHALL NOT start a second
one; it SHALL report the existing instance instead.

#### Scenario: `-d` starts the daemon in the background

- **WHEN** the user runs `chorus daemon -d` with resolvable credentials and a
  recorded yolo ack (or restricted mode)
- **THEN** the daemon runs detached, its output goes to `~/.chorus/daemon.log`, its
  pid is written to `~/.chorus/daemon.pid`, and the foreground shell returns

#### Scenario: `-d` refuses to double-start

- **WHEN** the user runs `chorus daemon -d` while a daemon recorded in
  `~/.chorus/daemon.pid` is still alive
- **THEN** the CLI does not start a second daemon and reports the running instance

### Requirement: Foreground preflight before detaching

The CLI SHALL, on a first `-d` start that still needs interactive credential
completion and/or the yolo TTY confirmation, perform that interaction in the
foreground parent process (which holds the TTY) and persist the resulting
credentials and `yoloAckAt` **before** detaching the background child. The
detached background child SHALL start non-interactively from the persisted
credentials/ack and SHALL NOT attempt to prompt.

#### Scenario: First `-d` run completes confirmation in the foreground

- **WHEN** the user runs `chorus daemon -d` on a TTY with no credentials and/or no
  yolo ack
- **THEN** the foreground parent completes the credential prompts and the yolo
  `y/N` confirmation, persists them, and only then detaches the background child —
  which starts without prompting

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

### Requirement: OS auto-start provided as documentation templates only

Boot/login auto-start SHALL be provided as **documentation templates only** — a
launchd `.plist` template (macOS) and a systemd `--user` `.service` template
(Linux) in the README / skill docs that a user can install manually. This change
SHALL NOT generate, install, or manage OS service definitions in code, and SHALL
NOT add Windows Task Scheduler integration.

#### Scenario: Auto-start templates are documented, not code

- **WHEN** a user wants the daemon to start at boot/login
- **THEN** the documentation provides launchd and systemd user-service templates
  to install manually, and the CLI ships no install/uninstall service command

### Requirement: Identity-verified pidfile liveness

The CLI SHALL verify process identity, not merely pid existence, when deciding whether the pid recorded in `~/.chorus/daemon.pid` is the running daemon. On a `-d` start the CLI SHALL write the pidfile as JSON carrying the pid plus identity metadata (process start time and a command-line hint), preserving read compatibility with the legacy plain-number format. When the liveness probe finds the pid exists (including when signaling it yields `EPERM`), the CLI SHALL query the occupying process's command line and start time via a single cross-platform, pure-JS subprocess query (POSIX `ps`, Windows PowerShell; no native bindings, no `shell:true`) and compare them against the recorded identity. When the record carries a command-line hint, that comparison SHALL be decided by the hint alone: a live command line containing the hint classifies the process as the running daemon regardless of the recorded start time (process start-time strings are clock-derived — e.g. POSIX `lstart` is recomputed from boot time plus start ticks — so an NTP clock step after spawn legitimately shifts them for the same process), and a live command line not containing the hint classifies the pidfile as stale. Only when the record carries no command-line hint SHALL the recorded start time decide, with a mismatch classifying the pidfile as stale. For a legacy pidfile with no recorded identity, the CLI SHALL fall back to checking that the live command line contains the chorus daemon marker, classifying it stale otherwise; when the probe on a legacy pidfile yields `EPERM` and the identity query fails, the CLI SHALL classify it stale (EPERM already proves the process belongs to another user, and the CLI and daemon always run as the same user). When a POSIX `ps` rejects the start-time column (e.g. busybox), the CLI SHALL retry with a command-line-only query so cmdline verification still functions. In all other query-failure cases (an identity-carrying pidfile, or a pid the CLI can signal) the CLI SHALL retain the prior conservative behavior (the pid counts as running) so an unverifiable live daemon is never misclassified. The identity check SHALL live in the shared liveness probe so `start -d`, `status`, `stop`, and `restart` all use the same verdict.

#### Scenario: Clock step after spawn does not misclassify a live daemon as stale

- **WHEN** the pidfile records a command-line hint and a start time, the recorded pid is the still-running chorus daemon whose command line contains the hint, but the queried start-time string differs because the system clock was stepped (e.g. boot-time NTP correction) after the daemon spawned
- **THEN** the probe reports running — `stop` signals the daemon and removes the pidfile only after a successful signal, and never clears the pidfile of the live daemon as stale

#### Scenario: Command-line hint mismatch is stale regardless of start time

- **WHEN** the pidfile records a command-line hint and the occupying process's command line does not contain it, even if the queried start-time string equals the recorded one
- **THEN** the pidfile is classified stale

#### Scenario: Start time still decides when no command-line hint was recorded

- **WHEN** the pidfile records a start time but no command-line hint, and the occupying process's queried start-time string differs from the recorded one
- **THEN** the pidfile is classified stale

#### Scenario: Reboot-recycled pid is classified stale, not running

- **WHEN** `~/.chorus/daemon.pid` records identity metadata for a daemon that died at reboot, the pid has been recycled to another user's process (probe yields EPERM), and the user runs any lifecycle command
- **THEN** the identity comparison fails, the pidfile is treated as stale — `stop` clears it and reports the stale cleanup, `status` reports not running, and `-d` starts a fresh daemon instead of refusing

#### Scenario: Live daemon still matches its recorded identity

- **WHEN** the recorded pid is the still-running chorus daemon whose command line contains the recorded hint
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

