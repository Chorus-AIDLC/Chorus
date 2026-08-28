# daemon-background-lifecycle Specification (delta)

## MODIFIED Requirements

### Requirement: Supervisor service install / uninstall

The CLI SHALL provide `chorus daemon install` and `chorus daemon uninstall` to
manage the daemon as an OS-supervised, boot-autostart service, replacing the prior
documentation-templates-only posture. On **Linux** the CLI SHALL generate a
`systemd --user` unit that runs the daemon in the **foreground** (`Type=simple`,
`ExecStart` invoking `chorus daemon` WITHOUT `-d`, so systemd owns the process
directly as `MainPID`), SHALL capture the `--agent` / `--chorus-only` flags passed
to `install` plus absolute node and script paths and the current `PATH`, SHALL
write it to `~/.config/systemd/user/chorus-daemon.service`, and SHALL then run
`systemctl --user daemon-reload` followed by `systemctl --user enable --now` so the
service starts immediately and at every login. On **macOS** the CLI SHALL perform a
**real** launchd install: render the foreground LaunchAgent plist (`RunAtLoad` +
`KeepAlive`, no `-d`, no embedded `--cwd`), back up any existing file, write it to
`~/Library/LaunchAgents/com.chorus.daemon.plist`, and run `launchctl load -w
<plist>` (preceded by a best-effort `launchctl unload` of any prior copy) so the
service starts immediately and at every login — it SHALL NOT merely print a
template. On **other platforms** (e.g. Windows) the CLI SHALL print the foreground
command to run under the operator's supervisor of choice and write no file.

The generated systemd unit and the launchd plist SHALL NOT embed `--cwd`
arguments: the set of working directories the daemon serves is persisted to
`~/.chorus/daemon.json` `cwds` at install time (see "Install configures the served
working directory set") and read from there by the daemon, so a boot-time service
and a plain `chorus daemon` serve the same paths and cannot drift. The generated
systemd unit SHALL use `Restart=on-failure` (so a clean stop stays stopped) and
SHALL NOT declare an `ExecStop` (a `Type=simple` stop is SIGTERM to the daemon's
existing graceful-shutdown handler). The CLI SHALL NOT generate a `Type=forking`
unit or an `ExecStart` containing `-d`.

Before writing any service unit or plist the CLI SHALL complete the install
credential guarantee (see "Install guarantees resolvable credentials for the
clean-env boot service") and the working-directory configuration (see "Install
configures the served working directory set"); if the credential guarantee cannot
be satisfied the CLI SHALL abort without installing. On any install failure —
failing to write the unit/plist, or a `systemctl` / `launchctl` command returning
non-zero — the CLI SHALL report the underlying error and exit non-zero (no silent
failure). Credentials SHALL NOT be baked into the service unit or plist as
environment lines (a 0600 `daemon.json` is the persistence surface).

`uninstall` on **Linux** SHALL `disable --now` the unit, remove the unit file, and
`daemon-reload`; on **macOS** SHALL `launchctl unload -w <plist>` and remove the
plist file; on both platforms SHALL report clearly when nothing was installed. On
**other platforms** it SHALL print the manual removal steps. The implementation
SHALL be pure Node with no native-binding dependency and SHALL NOT use `shell:true`.

#### Scenario: install generates a correct systemd unit and starts it

- **WHEN** the user runs `chorus daemon install` on a Linux host with `systemctl --user` available, resolvable credentials, and a configured cwd set
- **THEN** the CLI writes `~/.config/systemd/user/chorus-daemon.service` with `Type=simple`, an `ExecStart` that runs `chorus daemon` with no `-d` and no `--cwd` argument, `Restart=on-failure`, and no `ExecStop`, then runs `daemon-reload` and `enable --now`, so systemd owns the node process as `MainPID` and the service starts at login

#### Scenario: install performs a real launchd install on macOS

- **WHEN** the user runs `chorus daemon install` on a macOS host with resolvable credentials and a configured cwd set
- **THEN** the CLI writes the foreground LaunchAgent plist to `~/Library/LaunchAgents/com.chorus.daemon.plist` (RunAtLoad + KeepAlive, no `-d`, no embedded `--cwd`) and runs `launchctl load -w` on it, so the daemon starts immediately and at every login — no manual template step is required

#### Scenario: install persists cwds to daemon.json rather than the unit

- **WHEN** the user runs `chorus daemon install --cwd /a --cwd /b` on a Linux or macOS host
- **THEN** the generated unit/plist contains no `--cwd` argument, and `~/.chorus/daemon.json` `cwds` contains `/a` and `/b`, so the boot service reads the served paths from the config file

#### Scenario: generated unit never self-daemonizes

- **WHEN** the CLI renders the systemd unit or the launchd plist for any set of flags
- **THEN** the `ExecStart` / `ProgramArguments` contains neither `-d` nor `--detach`, and the systemd unit is not `Type=forking` — so the supervisor tracks the daemon directly and the boot-time restart loop cannot occur

#### Scenario: install surfaces a failure instead of reporting success

- **WHEN** `chorus daemon install` fails to write the unit/plist, or a `systemctl --user daemon-reload` / `enable --now` (Linux) or a `launchctl load -w` (macOS) returns non-zero
- **THEN** the CLI reports the failure with the underlying error and exits non-zero (no silent failure)

#### Scenario: install on an unsupported platform prints a template and does not write

- **WHEN** the user runs `chorus daemon install` on Windows or another unsupported platform
- **THEN** the CLI prints a correct foreground service template plus manual steps, writes no service file, and exits 0

#### Scenario: uninstall removes the service or reports nothing to remove

- **WHEN** the user runs `chorus daemon uninstall` on Linux or macOS
- **THEN** on Linux the CLI disables and stops the unit, removes the unit file, and reloads systemd; on macOS it unloads the LaunchAgent and removes the plist — or, when nothing is installed, reports that there was nothing to remove — and on an unsupported platform prints the manual removal steps

## ADDED Requirements

### Requirement: Platform auto-start capability classification

The CLI SHALL expose a single capability classifier that reports whether the
current host supports installing a real boot-autostart daemon service, returning
`systemd` on Linux where `systemctl --user` is available, `launchd` on macOS, and
`unsupported` on every other platform. The `chorus init` daemon-setup step SHALL
consult this classifier to decide whether to offer/perform a real service install
on the current host, and `chorus daemon install` SHALL perform the
platform-appropriate install (systemd on Linux, launchd on macOS, printed template
otherwise) consistent with the classifier's verdict, so the two paths cannot
disagree about what "supported" means. Supervisor detection SHALL recognize an
installed service for the classified capability — a `systemd --user`
`chorus-daemon.service` on Linux, or a loaded `com.chorus.daemon` LaunchAgent on
macOS — so lifecycle commands do not misclassify a supervised daemon.

#### Scenario: Capability reflects the platform

- **WHEN** the classifier runs on Linux with `systemctl --user` available, on macOS, and on Windows respectively
- **THEN** it returns `systemd`, `launchd`, and `unsupported` respectively

#### Scenario: Linux without systemctl is unsupported for auto-start

- **WHEN** the classifier runs on Linux where `systemctl --user` is not available
- **THEN** it returns `unsupported`, so no systemd install is attempted

#### Scenario: Supervisor detection recognizes a loaded launchd agent

- **WHEN** supervisor detection runs on macOS and the `com.chorus.daemon` LaunchAgent plist exists and `launchctl` reports the label loaded
- **THEN** detection reports an installed launchd supervisor rather than "none"

### Requirement: macOS launchd lifecycle delegation

The CLI SHALL delegate `chorus daemon status` / `stop` / `restart` / `logs` to
`launchctl` and the service log file rather than the pidfile when a
`com.chorus.daemon` LaunchAgent is installed and loaded on macOS, so a real macOS
boot service is manageable through the CLI and is never misreported as "not
running". `status`
SHALL report the loaded state via `launchctl list` (exiting non-zero when installed
but not loaded); `stop` SHALL `launchctl unload` the agent (noting it re-loads at
next login unless uninstalled); `restart` SHALL `launchctl unload` then
`launchctl load` the agent; `logs` SHALL display `~/.chorus/daemon.log`. When no
launchd agent is installed, the subcommands SHALL operate on the pidfile/logfile
exactly as before.

#### Scenario: status delegates to launchctl when the agent is loaded

- **WHEN** the user runs `chorus daemon status` on macOS while the `com.chorus.daemon` LaunchAgent is loaded
- **THEN** the CLI reports the daemon is managed by launchd (via `launchctl list`) and does not consult the pidfile

#### Scenario: stop delegates to launchctl unload when the agent is loaded

- **WHEN** the user runs `chorus daemon stop` on macOS while the LaunchAgent is loaded
- **THEN** the CLI runs `launchctl unload` on the plist, reports the stop (noting it re-loads at next login unless uninstalled), and does not signal via the pidfile

#### Scenario: restart delegates to launchctl when the agent is loaded

- **WHEN** the user runs `chorus daemon restart` on macOS while the LaunchAgent is loaded
- **THEN** the CLI runs `launchctl unload` then `launchctl load` on the plist and does not start a detached pidfile instance

#### Scenario: pidfile path is unchanged when no launchd agent is installed

- **WHEN** the user runs `chorus daemon status` / `stop` / `restart` / `logs` on macOS with no `com.chorus.daemon` LaunchAgent installed
- **THEN** the subcommands operate on the pidfile/logfile managed by the `-d` path exactly as before
