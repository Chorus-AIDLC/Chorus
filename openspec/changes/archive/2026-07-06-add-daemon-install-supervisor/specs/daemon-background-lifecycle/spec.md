## REMOVED Requirements

### Requirement: OS auto-start provided as documentation templates only

## ADDED Requirements

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

## MODIFIED Requirements

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
