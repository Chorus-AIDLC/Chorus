# chorus-init Specification (delta)

## ADDED Requirements

### Requirement: Optional daemon auto-start step in `chorus init`

`chorus init` SHALL run a `once`-scoped daemon-setup step, ordered after the
credential-seed and plugin-install steps, that configures the local Chorus daemon
and optionally installs it as a boot-autostart service. The step SHALL reuse the
existing `chorus daemon install` preflight to resolve and persist the served
working-directory set (`cwds`) and the default backend agent into
`~/.chorus/daemon.json` (credentials are already seeded by the credential-seed
step). The step SHALL NOT collect or persist model-provider secrets (e.g. `AWS_*`,
`ANTHROPIC_*`, Bedrock) — the centralized credential model is connection-only
(Chorus URL + API key), and no per-agent secret injection is introduced.

The step SHALL offer the auto-start install **only** on a platform whose auto-start
capability is supported (Linux systemd or macOS launchd). On an unsupported
platform it SHALL still persist `~/.chorus/daemon.json` and print the manual start
command, and SHALL NOT attempt to install a service.

In an interactive run (a TTY without `--yes`) the step SHALL prompt whether to
install and enable the daemon to auto-start on boot, **defaulting to No** (opt-in),
and SHALL install only on an affirmative answer. In a non-interactive run (non-TTY,
or `--yes`) the step SHALL install the boot service only when an explicit
`--daemon-autostart` flag is passed; otherwise it SHALL persist
`~/.chorus/daemon.json` and skip the service install without guessing.

Before installing a boot service, the step SHALL run the same credential
validate-or-abort guarantee as `chorus daemon install`: resolve credentials from
the layered source, validate the key against the server, and persist the
url + key + identity into `~/.chorus/daemon.json`. If credentials cannot be resolved
or the key fails validation, the step SHALL install nothing and report a failure —
it SHALL NOT rely solely on the earlier credential-seed step, and SHALL never
install a boot service that would fail authentication and restart-loop at boot.

When the user opts in on a supported platform, the step SHALL install **and enable**
the boot service so the daemon starts immediately and at every boot (delegating to
the same install path as `chorus daemon install`). The step SHALL be idempotent:
when a boot service is already installed for the platform it SHALL report the
daemon as already configured and make no destructive rewrite, applying only a
missing/drifted delta as a repair. A failed install SHALL be reported visibly with
its underlying error (non-zero outcome), never a silent skip.

#### Scenario: Interactive run offers opt-in auto-start defaulting to No

- **WHEN** a user runs `chorus init` in a TTY on a platform that supports
  auto-start (Linux systemd or macOS launchd)
- **THEN** the daemon-setup step persists the served cwds and backend to
  `~/.chorus/daemon.json`, prompts whether to auto-start the daemon on boot with a
  default of No, and installs & enables the boot service only if the user
  affirmatively accepts

#### Scenario: Declining auto-start still writes daemon config

- **WHEN** a user runs `chorus init` in a TTY and declines the auto-start prompt
- **THEN** `~/.chorus/daemon.json` is written (credentials, cwds, backend) and the
  step prints the manual `chorus daemon` start command without installing any
  service

#### Scenario: Non-interactive run requires an explicit flag to install

- **WHEN** `chorus init` runs in a non-TTY environment, or with `--yes` in a TTY,
  WITHOUT `--daemon-autostart`
- **THEN** the step persists `~/.chorus/daemon.json` and skips the boot-service
  install, reporting that `--daemon-autostart` is required to install the service,
  and does not block on a prompt

#### Scenario: Auto-start install aborts on unvalidated credentials

- **WHEN** the daemon-setup step decides to install (opt-in or `--daemon-autostart`)
  but the resolved Chorus key fails server validation, or no credentials resolve
- **THEN** the step installs no service and reports a failure, rather than
  installing a boot service that would fail authentication at boot

#### Scenario: Non-interactive run with the flag installs the service

- **WHEN** `chorus init --daemon-autostart` runs in a non-TTY environment on a
  supported platform with resolvable credentials
- **THEN** the step installs and enables the boot service without prompting

#### Scenario: Unsupported platform skips the service and prints manual steps

- **WHEN** `chorus init` runs on a platform whose auto-start capability is
  unsupported (e.g. Windows)
- **THEN** the step persists `~/.chorus/daemon.json`, prints the manual start
  steps, and does not attempt to install a boot service, regardless of
  `--daemon-autostart`

#### Scenario: Re-run is idempotent when the service is already installed

- **WHEN** a user re-runs `chorus init` (opting in, or with `--daemon-autostart`)
  on a machine where the boot service is already installed
- **THEN** the step reports the daemon as already configured for auto-start and
  makes no destructive rewrite, repairing only if a drift is detected

#### Scenario: The step never collects provider secrets

- **WHEN** the daemon-setup step runs in any mode
- **THEN** it collects only the Chorus connection credentials and the daemon's
  cwds/backend, and never prompts for or persists model-provider secrets into
  `~/.chorus/daemon.json` or any service unit
