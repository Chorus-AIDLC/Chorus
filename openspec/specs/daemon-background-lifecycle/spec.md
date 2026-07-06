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

The CLI SHALL provide `chorus daemon stop`, `chorus daemon status`, `chorus daemon restart`, and `chorus daemon logs`, and SHALL, when an OS-supervised daemon service is installed, delegate these verbs to the service manager rather than the pidfile. When the CLI detects an installed supervisor unit (on Linux, a `systemd --user` `chorus-daemon.service` unit file present or reported active), `status` SHALL report the service state via `systemctl` (exiting non-zero when installed but not active), `stop` SHALL run `systemctl --user stop` (noting the service remains enabled for next login), `restart` SHALL run `systemctl --user restart`, and `logs` SHALL show the service journal via `journalctl --user`; a supervised daemon SHALL NOT be misreported as "not running". When no supervisor unit is detected, the subcommands SHALL operate on the pidfile/logfile managed by the `-d` path exactly as before: `stop` SHALL terminate the recorded daemon process and clean up the pidfile, `status` SHALL report whether the daemon is running (and its pid), `restart` SHALL stop any running instance and start a new detached one, and `logs` SHALL display `~/.chorus/daemon.log`. Whether a recorded pid counts as "running" on the pidfile path SHALL be decided by the identity-verified liveness probe (see "Identity-verified pidfile liveness"). Each subcommand SHALL behave sanely and report visibly when no daemon is running (no silent failure).

#### Scenario: status delegates to the supervisor when installed

- **WHEN** the user runs `chorus daemon status` while a `systemd --user` `chorus-daemon.service` is installed and active
- **THEN** the CLI reports the daemon is managed by systemd and active (via `systemctl`), and does not consult the pidfile

#### Scenario: stop delegates to the supervisor when installed

- **WHEN** the user runs `chorus daemon stop` while the supervisor unit is installed and active
- **THEN** the CLI runs `systemctl --user stop chorus-daemon.service`, reports the stop (noting the service is still enabled for next login), and does not signal via the pidfile

#### Scenario: restart delegates to the supervisor when installed

- **WHEN** the user runs `chorus daemon restart` while the supervisor unit is installed
- **THEN** the CLI runs `systemctl --user restart chorus-daemon.service` and does not start a detached pidfile instance

#### Scenario: logs delegates to the journal when installed

- **WHEN** the user runs `chorus daemon logs` while the supervisor unit is installed
- **THEN** the CLI shows the service journal via `journalctl --user -u chorus-daemon.service`

#### Scenario: stop terminates the running daemon on the pidfile path

- **WHEN** the user runs `chorus daemon stop` while a `-d` daemon is running and no supervisor unit is installed
- **THEN** the recorded process is terminated and the pidfile is removed

#### Scenario: stop self-heals a recycled-pid pidfile

- **WHEN** the user runs `chorus daemon stop` while the pidfile's pid has been recycled to a process that fails identity verification and no supervisor unit is installed
- **THEN** the CLI clears the stale pidfile and reports the cleanup instead of failing with a signal error

#### Scenario: status reports running state on the pidfile path

- **WHEN** the user runs `chorus daemon status` with no supervisor unit installed
- **THEN** the CLI reports whether a `-d` daemon is running and, if so, its pid

#### Scenario: restart cycles the daemon on the pidfile path

- **WHEN** the user runs `chorus daemon restart` with no supervisor unit installed
- **THEN** any running instance is stopped and a new detached instance is started

#### Scenario: logs shows the daemon output on the pidfile path

- **WHEN** the user runs `chorus daemon logs` with no supervisor unit installed
- **THEN** the CLI displays the contents of `~/.chorus/daemon.log`

#### Scenario: lifecycle commands report when nothing is running

- **WHEN** the user runs `stop`, `status`, `restart`, or `logs` with no daemon running and no supervisor unit installed
- **THEN** the CLI reports the absence clearly and does not fail silently

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

### Requirement: Supervisor service install / uninstall

The CLI SHALL provide `chorus daemon install` and `chorus daemon uninstall` to manage the daemon as an OS-supervised, boot-autostart service, replacing the prior documentation-templates-only posture. On Linux the CLI SHALL generate a `systemd --user` unit that runs the daemon in the **foreground** (`Type=simple`, `ExecStart` invoking `chorus daemon` WITHOUT `-d`, so systemd owns the process directly as `MainPID`), SHALL capture the `--cwd` / `--agent` / `--chorus-only` flags passed to `install` plus absolute node and script paths and the current `PATH`, SHALL write it to `~/.config/systemd/user/chorus-daemon.service`, and SHALL then run `systemctl --user daemon-reload` followed by `systemctl --user enable --now` so the service starts immediately and at every login. The generated unit SHALL use `Restart=on-failure` (so a clean stop stays stopped) and SHALL NOT declare an `ExecStop` (a `Type=simple` stop is SIGTERM to the daemon's existing graceful-shutdown handler). The CLI SHALL NOT generate a `Type=forking` unit or an `ExecStart` containing `-d`. On macOS the CLI SHALL print a correct launchd LaunchAgent plist (foreground, `RunAtLoad` + `KeepAlive`, no `-d`) plus manual install steps and exit 0 without writing any file; on other platforms it SHALL print the foreground command to run under the operator's supervisor of choice. `uninstall` on Linux SHALL `disable --now` the unit, remove the unit file, and `daemon-reload`, reporting clearly when nothing was installed; off Linux it SHALL print the manual removal steps. The implementation SHALL be pure Node with no native-binding dependency and SHALL NOT use `shell:true`.

#### Scenario: install generates a correct systemd unit and starts it

- **WHEN** the user runs `chorus daemon install --cwd /a --cwd /b` on a Linux host with `systemctl --user` available
- **THEN** the CLI writes `~/.config/systemd/user/chorus-daemon.service` with `Type=simple`, an `ExecStart` that runs `chorus daemon --cwd /a --cwd /b` with no `-d`, `Restart=on-failure`, and no `ExecStop`, then runs `daemon-reload` and `enable --now`, so systemd owns the node process as `MainPID` and the service starts at login

#### Scenario: generated unit never self-daemonizes

- **WHEN** the CLI renders the systemd unit for any set of flags
- **THEN** the `ExecStart` line contains neither `-d` nor `--detach`, and the unit is not `Type=forking` — so systemd tracks the daemon directly and the boot-time restart loop cannot occur

#### Scenario: install surfaces a failure instead of reporting success

- **WHEN** `chorus daemon install` on Linux fails to write the unit or a `systemctl --user daemon-reload` / `enable --now` returns non-zero
- **THEN** the CLI reports the failure with the underlying error and exits non-zero (no silent failure)

#### Scenario: install off Linux prints a template and does not write

- **WHEN** the user runs `chorus daemon install` on macOS or Windows
- **THEN** the CLI prints a correct foreground service template (launchd plist on macOS) plus manual steps, writes no service file, and exits 0

#### Scenario: uninstall removes the service or reports nothing to remove

- **WHEN** the user runs `chorus daemon uninstall` on Linux
- **THEN** the CLI disables and stops the unit, removes the unit file, and reloads systemd — or, when no unit is installed, reports that there was nothing to remove — and off Linux prints the manual removal steps

