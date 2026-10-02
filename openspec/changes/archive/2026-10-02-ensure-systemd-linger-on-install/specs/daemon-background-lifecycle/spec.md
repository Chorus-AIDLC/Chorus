## ADDED Requirements

### Requirement: Linux install ensures systemd user lingering

On **Linux**, after the `systemd --user` unit has been written, reloaded, and enabled,
`chorus daemon install` and the daemon-setup step of `chorus agents add` SHALL
ensure the installing user's lingering is enabled. They SHALL query
`loginctl show-user <user> -p Linger --value` and, when it reports `no`, run
`loginctl enable-linger <user>` without prompting, so the daemon keeps running after
the user's last session ends and starts at boot. The user name SHALL be passed as an
explicit argument (no shell, no `shell:true`). When lingering is already enabled the
CLI SHALL NOT run `enable-linger`.

A failure to determine or enable lingering — `loginctl` missing, a non-zero exit (for
example a polkit denial or no logind), or unparseable output — SHALL NOT fail the
install. The install SHALL still report success and exit 0, and the CLI SHALL print a
prominent warning that the daemon will stop at logout, plus the exact
`sudo loginctl enable-linger <user>` command to fix it. Both entry points SHALL
accept `--no-linger`, which skips the linger step entirely.

When `chorus agents add` finds the systemd unit already installed (its
"already configured for auto-start" path), it SHALL still run the same idempotent
linger check and enablement (unless `--no-linger` is given), without rewriting the unit.

`chorus daemon status`, when the daemon is managed by an installed systemd unit, SHALL
report the linger state and, when it is `no`, SHALL print a warning plus the fix
command. This SHALL NOT change the status exit code.

`chorus daemon uninstall` SHALL NOT disable lingering. macOS (launchd) and other
platforms SHALL NOT invoke `loginctl`.

#### Scenario: install enables lingering when it is off

- **WHEN** the user runs `chorus daemon install` on Linux, the unit installs successfully, and `loginctl show-user <user> -p Linger --value` prints `no`
- **THEN** the CLI runs `loginctl enable-linger <user>`, prints a one-line note that lingering was enabled so the daemon survives logout and starts at boot, and exits 0

#### Scenario: install leaves lingering alone when already enabled

- **WHEN** the user runs `chorus daemon install` on Linux and `loginctl show-user` reports `yes`
- **THEN** the CLI does not run `loginctl enable-linger` and the install succeeds

#### Scenario: linger failure does not fail the install

- **WHEN** the unit installs successfully on Linux but `loginctl enable-linger` exits non-zero, or `loginctl` is missing
- **THEN** the install still reports success with exit 0, and the CLI prints a warning that the daemon will stop at logout plus the `sudo loginctl enable-linger <user>` command

#### Scenario: --no-linger skips the linger step

- **WHEN** the user runs `chorus daemon install --no-linger` or `chorus agents add --no-linger` on Linux
- **THEN** the CLI makes no `loginctl` call during install

#### Scenario: agents add fixes lingering on an already-installed service

- **WHEN** the user re-runs `chorus agents add` and opts into auto-start on a Linux host where the systemd unit is already installed and lingering is `no`
- **THEN** the step leaves the unit unchanged and reports it as already configured, but runs `loginctl enable-linger <user>` and reports that lingering was enabled

#### Scenario: status warns when lingering is off

- **WHEN** the user runs `chorus daemon status` on Linux with the systemd unit installed and lingering `no`
- **THEN** the output includes a warning that the daemon will stop when the user logs out and will not start at boot, plus the command to enable lingering, and the exit code is the same as without the warning

#### Scenario: uninstall keeps lingering

- **WHEN** the user runs `chorus daemon uninstall` on Linux
- **THEN** the CLI removes the unit but makes no `loginctl disable-linger` call
