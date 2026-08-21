## MODIFIED Requirements

### Requirement: Optional daemon auto-start step in `chorus init`

`chorus init` SHALL run a `once`-scoped daemon-setup step, ordered after the
credential-seed and plugin-install steps, that optionally installs the local Chorus
daemon as a boot-autostart service. With an init selection, each selected agent's
per-agent config (credentials, `agentType`, `cwds`, and `daemonWake`) is already
written into `~/.chorus/daemon.json` `agents[]` by the credential-seed step; the
daemon-setup step therefore SHALL NOT persist the deprecated flat top-level
`cwds`/`agent` (or flat credentials) for a selection. The step SHALL NOT collect or
persist model-provider secrets (e.g. `AWS_*`, `ANTHROPIC_*`, Bedrock) — the
centralized credential model is connection-only (Chorus URL + API key).

**Capability gate (all-not-woken).** The auto-start prompt and the boot-service install
SHALL run only when at least one selected agent WILL BE WOKEN — i.e. a daemon-wakeable
backend (claude-code / codex / kiro) with daemon waking enabled (`daemonWake` not
false). When no selected agent will be woken — every one is either `offline` or a
wakeable backend left opted-out (`daemonWake: false`) — there is nothing for the daemon
to wake, so the step SHALL keep the `agents[]` entries, skip the auto-start prompt and
the service install entirely (regardless of `--daemon-autostart`), and report that no
agent is enabled for daemon waking.

The step SHALL offer the auto-start install **only** on a platform whose auto-start
capability is supported (Linux systemd or macOS launchd). On an unsupported
platform it SHALL still leave `~/.chorus/daemon.json` in place and print the manual
start command, and SHALL NOT attempt to install a service.

In an interactive run (a TTY without `--yes`) with at least one selected agent that will
be woken, the step SHALL prompt whether to install and enable the daemon to auto-start
on boot, **defaulting to No** (opt-in), and SHALL install only on an affirmative answer.
In a non-interactive run (non-TTY, or `--yes`) the step SHALL install the boot service
only when an explicit `--daemon-autostart` flag is passed AND at least one selected agent
will be woken; otherwise it SHALL skip the service install without guessing.

Before installing a boot service, the step SHALL run the same credential
validate-or-abort guarantee as `chorus daemon install`: resolve credentials from the
layered source (for a selection, `resolveCredentials` falls back to the first
`agents[]` entry) and validate the key against the server; for a selection it validates
WITHOUT persisting flat top-level credentials. If credentials cannot be resolved or the
key fails validation, the step SHALL install nothing and report a failure — it SHALL
never install a boot service that would fail authentication and restart-loop at boot.

When the user opts in on a supported platform, the step SHALL install **and enable**
the boot service so the daemon starts immediately and at every boot. The step SHALL be
idempotent: when a boot service is already installed it SHALL report the daemon as
already configured and make no destructive rewrite. A failed install SHALL be reported
visibly with its underlying error (non-zero outcome), never a silent skip.

#### Scenario: Interactive run offers opt-in auto-start defaulting to No
- **WHEN** a user runs `chorus init` in a TTY on a platform that supports auto-start with at least one selected agent that will be woken (wakeable backend + daemonWake enabled)
- **THEN** the daemon-setup step prompts whether to auto-start the daemon on boot with a default of No, and installs & enables the boot service only if the user affirmatively accepts, without writing the deprecated top-level cwds/agent

#### Scenario: No selected agent will be woken skips the prompt and install
- **WHEN** a user runs `chorus init` in a TTY on a supported platform but no selected agent will be woken (every one is offline, or a wakeable backend with `daemonWake: false`)
- **THEN** the step keeps the `agents[]` entries, skips the auto-start prompt and the service install entirely, and reports that no agent is enabled for daemon waking

#### Scenario: Declining auto-start leaves daemon config in place
- **WHEN** a user runs `chorus init` in a TTY and declines the auto-start prompt
- **THEN** `~/.chorus/daemon.json` retains the per-agent `agents[]` config and the step prints the manual `chorus daemon` start command without installing any service

#### Scenario: Non-interactive run requires an explicit flag to install
- **WHEN** `chorus init` runs in a non-TTY environment, or with `--yes` in a TTY, WITHOUT `--daemon-autostart`, and at least one selected agent will be woken
- **THEN** the step skips the boot-service install, reporting that `--daemon-autostart` is required to install the service, and does not block on a prompt

#### Scenario: Auto-start install aborts on unvalidated credentials
- **WHEN** the daemon-setup step decides to install (opt-in or `--daemon-autostart`) but the resolved Chorus key fails server validation, or no credentials resolve
- **THEN** the step installs no service and reports a failure, rather than installing a boot service that would fail authentication at boot

#### Scenario: Non-interactive run with the flag installs the service
- **WHEN** `chorus init --daemon-autostart` runs in a non-TTY environment on a supported platform with resolvable credentials and at least one selected agent that will be woken
- **THEN** the step installs and enables the boot service without prompting

#### Scenario: Unsupported platform skips the service and prints manual steps
- **WHEN** `chorus init` runs on a platform whose auto-start capability is unsupported (e.g. Windows)
- **THEN** the step prints the manual start steps and does not attempt to install a boot service, regardless of `--daemon-autostart`

#### Scenario: Re-run is idempotent when the service is already installed
- **WHEN** a user re-runs `chorus init` (opting in, or with `--daemon-autostart`) on a machine where the boot service is already installed
- **THEN** the step reports the daemon as already configured for auto-start and makes no destructive rewrite, repairing only if a drift is detected

#### Scenario: The step never collects provider secrets
- **WHEN** the daemon-setup step runs in any mode
- **THEN** it collects only the Chorus connection credentials, and never prompts for or persists model-provider secrets into `~/.chorus/daemon.json` or any service unit

## ADDED Requirements

### Requirement: Per-agent daemon-wake defaults off at init with explicit opt-in

`chorus init` SHALL record a per-agent `daemonWake` boolean (defaulting to `false`) on the `agents[]` entry of each selected agent that maps to a daemon-wakeable backend (claude-code / codex / kiro) — the agent is added (its key available to `chorus mcp`) but not woken by the daemon until the operator opts in. A selected agent that maps to
`offline` (a backend that cannot be daemon-woken) SHALL NOT be given a `daemonWake` field
(it can never wake). The opt-in SHALL be explicit: on a TTY the command asks, per
daemon-wakeable selected agent, whether to enable daemon waking for that agent
(defaulting to No); in a non-interactive run the agent is left `daemonWake: false` unless
it is named by `--daemon-wake <ids>` or `--daemon-wake-all` is passed. init MUST write the
resolved `daemonWake` value explicitly (true or false) on each wakeable agent's entry.

#### Scenario: Wakeable agent added without opting in
- **WHEN** a user selects a daemon-wakeable agent (e.g. kiro) and does not enable daemon waking for it
- **THEN** its `agents[]` entry is written with `daemonWake: false` — the key is present for `chorus mcp`, but the daemon will not wake it

#### Scenario: Wakeable agent opted in
- **WHEN** the operator answers Yes to the daemon-waking prompt for a selected agent (or names it in `--daemon-wake` / passes `--daemon-wake-all`)
- **THEN** its `agents[]` entry is written with `daemonWake: true`

#### Scenario: Offline agent gets no daemonWake field
- **WHEN** a selected agent maps to `offline` (opencode / openclaw / pi / dormant dsh)
- **THEN** its `agents[]` entry carries no `daemonWake` field, since it can never be woken

#### Scenario: Non-interactive default is off
- **WHEN** `chorus init --agents kiro --yes` runs with neither `--daemon-wake kiro` nor `--daemon-wake-all`
- **THEN** the kiro entry is written `daemonWake: false` without prompting
