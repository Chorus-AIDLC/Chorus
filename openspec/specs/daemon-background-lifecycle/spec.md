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

### Requirement: Supervisor service install / uninstall

The CLI SHALL provide `chorus daemon install` and `chorus daemon uninstall` to manage the daemon as an OS-supervised, boot-autostart service, replacing the prior documentation-templates-only posture. On Linux the CLI SHALL generate a `systemd --user` unit that runs the daemon in the **foreground** (`Type=simple`, `ExecStart` invoking `chorus daemon` WITHOUT `-d`, so systemd owns the process directly as `MainPID`), SHALL capture the `--agent` / `--chorus-only` flags passed to `install` plus absolute node and script paths and the current `PATH`, SHALL write it to `~/.config/systemd/user/chorus-daemon.service`, and SHALL then run `systemctl --user daemon-reload` followed by `systemctl --user enable --now` so the service starts immediately and at every login. The generated unit SHALL NOT embed `--cwd` arguments: the set of working directories the daemon serves is persisted to `~/.chorus/daemon.json` `cwds` at install time (see "Install configures the served working directory set") and read from there by the daemon, so a boot-time service and a plain `chorus daemon` serve the same paths and cannot drift. The generated unit SHALL use `Restart=on-failure` (so a clean stop stays stopped) and SHALL NOT declare an `ExecStop` (a `Type=simple` stop is SIGTERM to the daemon's existing graceful-shutdown handler). The CLI SHALL NOT generate a `Type=forking` unit or an `ExecStart` containing `-d`. Before writing any service unit the CLI SHALL complete the install credential guarantee (see "Install guarantees resolvable credentials for the clean-env boot service") and the working-directory configuration (see "Install configures the served working directory set"); if the credential guarantee cannot be satisfied the CLI SHALL abort without writing a unit. On macOS the CLI SHALL print a correct launchd LaunchAgent plist (foreground, `RunAtLoad` + `KeepAlive`, no `-d`, no embedded `--cwd`) plus manual install steps and exit 0 without writing any file; on other platforms it SHALL print the foreground command to run under the operator's supervisor of choice. `uninstall` on Linux SHALL `disable --now` the unit, remove the unit file, and `daemon-reload`, reporting clearly when nothing was installed; off Linux it SHALL print the manual removal steps. The implementation SHALL be pure Node with no native-binding dependency and SHALL NOT use `shell:true`.

#### Scenario: install generates a correct systemd unit and starts it

- **WHEN** the user runs `chorus daemon install` on a Linux host with `systemctl --user` available, resolvable credentials, and a configured cwd set
- **THEN** the CLI writes `~/.config/systemd/user/chorus-daemon.service` with `Type=simple`, an `ExecStart` that runs `chorus daemon` with no `-d` and no `--cwd` argument, `Restart=on-failure`, and no `ExecStop`, then runs `daemon-reload` and `enable --now`, so systemd owns the node process as `MainPID` and the service starts at login

#### Scenario: install persists cwds to daemon.json rather than the unit

- **WHEN** the user runs `chorus daemon install --cwd /a --cwd /b` on a Linux host
- **THEN** the generated unit's `ExecStart` contains no `--cwd` argument, and `~/.chorus/daemon.json` `cwds` contains `/a` and `/b`, so the boot service reads the served paths from the config file

#### Scenario: generated unit never self-daemonizes

- **WHEN** the CLI renders the systemd unit for any set of flags
- **THEN** the `ExecStart` line contains neither `-d` nor `--detach`, and the unit is not `Type=forking` — so systemd tracks the daemon directly and the boot-time restart loop cannot occur

#### Scenario: install surfaces a failure instead of reporting success

- **WHEN** `chorus daemon install` on Linux fails to write the unit or a `systemctl --user daemon-reload` / `enable --now` returns non-zero
- **THEN** the CLI reports the failure with the underlying error and exits non-zero (no silent failure)

#### Scenario: install off Linux prints a template and does not write

- **WHEN** the user runs `chorus daemon install` on macOS or Windows
- **THEN** the CLI prints a correct foreground service template (launchd plist on macOS) carrying no embedded `--cwd`, plus manual steps, writes no service file, and exits 0

#### Scenario: uninstall removes the service or reports nothing to remove

- **WHEN** the user runs `chorus daemon uninstall` on Linux
- **THEN** the CLI disables and stops the unit, removes the unit file, and reloads systemd — or, when no unit is installed, reports that there was nothing to remove — and off Linux prints the manual removal steps

### Requirement: Install guarantees resolvable credentials for the clean-env boot service

The CLI SHALL, before writing any service unit during `chorus daemon install`, guarantee that the supervised daemon can authenticate from a source its clean boot environment can read. Because a `systemd --user` unit (and a launchd LaunchAgent) starts in a clean environment that does NOT inherit the operator's shell-exported `CHORUS_URL` / `CHORUS_API_KEY`, install SHALL resolve credentials via the layered resolver (flags > env > `~/.chorus/daemon.json` > plugin fallback) and, when they resolve from ANY source, SHALL persist the `url` + `cho_` API key into `~/.chorus/daemon.json` using the same owner-only field-level merge as `chorus login` (preserving `cwds`, `yoloAckAt`, and `sigintTimeoutMs`). When credentials do NOT resolve and standard input is a TTY (and the non-interactive skip flag is absent), install SHALL prompt login-style for the server URL and a masked API key. Install SHALL always validate the resolved or entered key against the server (fetching the authenticated agent identity) before writing the unit, and SHALL persist the identity (`agentUuid`, `agentName`) alongside the credentials on success. If credentials cannot be obtained, or validation fails, install SHALL abort non-zero and SHALL NOT write a service unit — it SHALL never install a service that would fail to authenticate and restart-loop at boot. Credentials SHALL NOT be baked into the service unit as environment lines (a 0600 `daemon.json` is the persistence surface).

#### Scenario: Exported env credentials are persisted so the clean boot env can read them

- **WHEN** the operator has `CHORUS_URL` / `CHORUS_API_KEY` exported in their shell but no `~/.chorus/daemon.json`, and runs `chorus daemon install` on a Linux host
- **THEN** install resolves the credentials from the environment, validates the key against the server, writes them (with the fetched identity) into `~/.chorus/daemon.json` at 0600, and only then writes the unit — so the boot service authenticates from the file rather than the un-inherited environment

#### Scenario: No resolvable credentials on a TTY prompts login-style

- **WHEN** the operator runs `chorus daemon install` on a TTY with no resolvable credentials and no skip flag
- **THEN** install prompts for the URL and a masked API key, validates them, persists them to `~/.chorus/daemon.json`, and proceeds to write the unit

#### Scenario: Invalid key aborts the install without writing a unit

- **WHEN** the credentials resolved or entered during `chorus daemon install` fail server validation
- **THEN** install reports the authentication failure, writes no service unit, does not run `enable --now`, and exits non-zero

#### Scenario: No credentials and no way to prompt aborts with the multi-source hint

- **WHEN** `chorus daemon install` cannot resolve credentials and either stdin is not a TTY or the skip flag is set
- **THEN** install emits the single multi-source actionable credential error, writes no service unit, and exits non-zero

#### Scenario: Credentials are never baked into the unit file

- **WHEN** install writes a systemd unit or prints a launchd template after resolving credentials
- **THEN** the unit/template contains no `CHORUS_API_KEY` or `CHORUS_URL` environment line — the credentials live only in the 0600 `~/.chorus/daemon.json`

### Requirement: Install configures the served working directory set

The CLI SHALL, during `chorus daemon install`, determine the set of working directories the daemon serves and persist it to `~/.chorus/daemon.json` `cwds` as the single source of truth, rather than embedding `--cwd` arguments in the service unit. Install SHALL treat the cwd set as already configured when a `--cwd` flag was passed OR `~/.chorus/daemon.json` already contains a non-empty `cwds` array, and in that case SHALL use that set without prompting. When the cwd set is unconfigured AND standard input is a TTY AND the non-interactive skip flag is absent, install SHALL run an interactive wizard that pre-seeds the current directory as the suggested first entry and then repeatedly prompts "add a working directory (blank to finish)", accumulating one or more paths until a blank line ends the loop. Each entered path SHALL be normalized and de-duplicated using the same rules as the daemon's layered cwd resolver (`~` expansion, resolution to an absolute path, first-seen de-duplication). Install SHALL persist the resulting set to `~/.chorus/daemon.json` `cwds` via the owner-only field-level merge (preserving credentials and other fields). When the set is unconfigured and no wizard runs (non-TTY or skip), install SHALL fall back to the daemon's existing single-path default (the process working directory) without prompting.

#### Scenario: Interactive wizard collects multiple working directories

- **WHEN** the operator runs `chorus daemon install` on a TTY with no `--cwd` flag and no `cwds` in `~/.chorus/daemon.json`
- **THEN** install pre-seeds the current directory, prompts repeatedly for additional directories until a blank line, and persists the accumulated, normalized, de-duplicated set to `~/.chorus/daemon.json` `cwds`

#### Scenario: Explicit configuration skips the wizard

- **WHEN** the operator runs `chorus daemon install --cwd /a` or already has a non-empty `cwds` array in `~/.chorus/daemon.json`
- **THEN** install does not prompt for working directories and persists/uses the explicitly configured set

#### Scenario: Configured cwds are the single source of truth, not the unit

- **WHEN** install has determined the served cwd set
- **THEN** the set is written to `~/.chorus/daemon.json` `cwds` and the generated service unit carries no `--cwd` argument, so a plain `chorus daemon` and the boot service read the same paths

### Requirement: Non-interactive install skip flag

The CLI SHALL accept a `--yes` / `-y` flag on `chorus daemon install` that suppresses all interactive prompts, and SHALL treat a non-TTY standard input as equivalent to that flag. In skip mode install SHALL still resolve and persist credentials, still validate the key against the server, and still abort non-zero when credentials cannot be obtained or validated — the flag suppresses prompting, not the "never install a broken service" guarantee. In skip mode install SHALL NOT run the interactive cwd wizard; it SHALL use the `--cwd` flags, an existing `cwds` array, or the single-path process-cwd default.

#### Scenario: Skip flag installs without prompting when credentials resolve

- **WHEN** the operator runs `chorus daemon install --yes` (or install runs with a non-TTY stdin) and credentials resolve from flags, env, or `~/.chorus/daemon.json`
- **THEN** install persists and validates the credentials, configures cwds from flags/config/default without prompting, writes the unit, and starts the service — with no interactive prompt

#### Scenario: Skip flag still validates the key against the server

- **WHEN** `chorus daemon install --yes` runs with credentials that fail server validation
- **THEN** install reports the authentication failure, writes no unit, and exits non-zero — skip mode does not bypass validation

#### Scenario: Skip flag aborts when no credentials resolve

- **WHEN** `chorus daemon install --yes` (or a non-TTY install) cannot resolve credentials from any source
- **THEN** install emits the multi-source actionable error, writes no unit, and exits non-zero instead of prompting

