## MODIFIED Requirements

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

## ADDED Requirements

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
