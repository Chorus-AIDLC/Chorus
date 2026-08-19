# chorus-init Specification

## Purpose
TBD - created by archiving change chorus-init-foundation. Update Purpose after archive.
## Requirements
### Requirement: Interactive `chorus init` command

Chorus SHALL provide a client-mode `chorus init` subcommand, dispatched alongside `daemon` and `login`, that detects the machine's coding agents, lets the user choose which to configure, and runs the ordered configuration steps against the chosen agents. Running `chorus init --help` MUST print usage without starting the server or any configuration side effect.

#### Scenario: Interactive run configures selected agents
- **WHEN** a user runs `chorus init` in a TTY
- **THEN** the command detects agents, presents a selection with detected agents pre-checked, and after confirmation runs the configuration steps only for the selected agents, ending with a per-agent status summary

#### Scenario: Help does nothing else
- **WHEN** a user runs `chorus init --help`
- **THEN** usage text is printed and the process exits 0 without detecting, prompting, writing files, or launching the server

### Requirement: Agent detection with dual signal and always-selectable list

The command SHALL detect each supported agent using two signals — its CLI binary on `PATH` and its config directory presence — and treat an agent as detected when either signal holds. Detection MUST only drive the default pre-selection and status hints; an undetected agent MUST remain selectable so a user can configure it anyway.

#### Scenario: Detected agent is pre-selected
- **WHEN** an agent's binary is on `PATH` or its config directory exists
- **THEN** that agent is marked detected and pre-checked in the selection

#### Scenario: Undetected agent is still selectable
- **WHEN** an agent is neither on `PATH` nor has a config directory
- **THEN** it appears unchecked but selectable, and choosing it proceeds to configure it

### Requirement: One-time credential seeding into centralized daemon config

The command SHALL collect the Chorus URL and API key exactly once per run and persist them to the centralized daemon configuration (`~/.chorus/daemon.json`), reusing the existing login/credential modules. It MUST NOT write the API key into any per-agent configuration. The write MUST merge into existing daemon configuration without clobbering unrelated fields.

#### Scenario: Credentials captured once and centralized
- **WHEN** a user supplies a valid Chorus URL and API key (via prompt or `--url`/`--api-key`)
- **THEN** the values are validated and written once to `~/.chorus/daemon.json`, and no per-agent config file receives the API key

#### Scenario: Existing daemon config is preserved
- **WHEN** `~/.chorus/daemon.json` already contains unrelated fields such as prior credentials or acknowledgement timestamps
- **THEN** seeding updates only the connection fields and leaves the unrelated fields intact

### Requirement: Idempotent re-run with per-agent diff and backup

Re-running `chorus init` SHALL be idempotent: it reads each selected agent's current Chorus install state, reports per-agent status, applies only the missing or repair delta, and backs up any config file before overwriting it. A second run against an already-configured agent MUST report it as already configured and make no destructive change.

#### Scenario: Second run is a no-op for a configured agent
- **WHEN** an agent already has the Chorus plugin installed and enabled
- **THEN** the re-run reports it as `skipped (already configured)` and does not rewrite its config

#### Scenario: Backup before overwrite
- **WHEN** a step must overwrite an existing agent config file
- **THEN** the original is copied to a `.chorus-bak` backup before the new content is written

### Requirement: Scriptable non-interactive surface

The command SHALL support non-interactive use via `--agents <csv>`, `--all`, `--yes`, `--url`, and `--api-key`. When stdin or stdout is not a TTY, the command MUST require an explicit `--agents` or `--all` and abort with a clear message otherwise, rather than guessing which agents to configure. An unknown value in `--agents` MUST be a hard error that lists the valid agent ids.

#### Scenario: CI run with explicit agents
- **WHEN** `chorus init --agents claude,codex --url <u> --api-key <k> --yes` runs in a non-TTY environment
- **THEN** it configures exactly Claude Code and Codex without prompting

#### Scenario: Non-TTY without a selection aborts
- **WHEN** `chorus init` runs in a non-TTY environment with neither `--agents` nor `--all`
- **THEN** it aborts with a message instructing the caller to pass `--agents` or `--all`, and configures nothing

#### Scenario: Unknown agent id is rejected
- **WHEN** `--agents` contains an id not in the adapter registry
- **THEN** the command exits non-zero and lists the valid agent ids

### Requirement: Pluggable step-orchestration seam

The command SHALL run configuration through an ordered, extensible step registry rather than a hard-coded pipeline. Each step declares an order and a scope (`once` or `per-agent`). This change SHALL register the credential-seed step and the plugin-install step; sibling capabilities MUST be able to register additional steps (MCP proxy, daemon setup) without modifying the command core.

#### Scenario: Steps run in declared order
- **WHEN** `chorus init` executes
- **THEN** registered steps run in ascending order, `once`-scoped steps run a single time and `per-agent` steps run once per selected agent

#### Scenario: A new step is added without core changes
- **WHEN** a sibling registers an additional step into the registry
- **THEN** it participates in the ordered run with no edit to the command's orchestration core

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

