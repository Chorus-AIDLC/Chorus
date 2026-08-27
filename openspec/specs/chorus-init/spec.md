# chorus-init Specification

## Purpose
TBD - created by archiving change chorus-init-foundation. Update Purpose after archive.
## Requirements
### Requirement: Agent detection with dual signal and always-selectable list

The command SHALL detect each supported agent using two signals — its CLI binary on `PATH` and its config directory presence — and treat an agent as detected when either signal holds. Detection MUST only drive the default pre-selection and status hints; an undetected agent MUST remain selectable so a user can configure it anyway.

#### Scenario: Detected agent is pre-selected
- **WHEN** an agent's binary is on `PATH` or its config directory exists
- **THEN** that agent is marked detected and pre-checked in the selection

#### Scenario: Undetected agent is still selectable
- **WHEN** an agent is neither on `PATH` nor has a config directory
- **THEN** it appears unchecked but selectable, and choosing it proceeds to configure it

### Requirement: Idempotent re-run with per-agent diff and backup

Re-running `chorus agents add` SHALL be idempotent: it reads each selected agent's current Chorus install state, reports per-agent status, applies only the missing or repair delta, and backs up any config file before overwriting it. A second run against an already-configured agent MUST report it as already configured and make no destructive change.

#### Scenario: Second run is a no-op for a configured agent
- **WHEN** an agent already has the Chorus plugin installed and enabled
- **THEN** the re-run reports it as `skipped (already configured)` and does not rewrite its config

#### Scenario: Backup before overwrite
- **WHEN** a step must overwrite an existing agent config file
- **THEN** the original is copied to a `.chorus-bak` backup before the new content is written

### Requirement: Scriptable non-interactive surface

The command SHALL support non-interactive use via `--agents <csv>`, `--all`, `--yes`, `--url`, and `--api-key`. When stdin or stdout is not a TTY, the command MUST require an explicit `--agents` or `--all` and abort with a clear message otherwise, rather than guessing which agents to configure. An unknown value in `--agents` MUST be a hard error that lists the valid agent ids.

#### Scenario: CI run with explicit agents
- **WHEN** `chorus agents add --agents claude,codex --url <u> --api-key <k> --yes` runs in a non-TTY environment
- **THEN** it configures exactly Claude Code and Codex without prompting

#### Scenario: Non-TTY without a selection aborts
- **WHEN** `chorus agents add` runs in a non-TTY environment with neither `--agents` nor `--all`
- **THEN** it aborts with a message instructing the caller to pass `--agents` or `--all`, and configures nothing

#### Scenario: Unknown agent id is rejected
- **WHEN** `--agents` contains an id not in the adapter registry
- **THEN** the command exits non-zero and lists the valid agent ids

### Requirement: Pluggable step-orchestration seam

The command SHALL run configuration through an ordered, extensible step registry rather than a hard-coded pipeline. Each step declares an order and a scope (`once` or `per-agent`). This change SHALL register the credential-seed step and the plugin-install step; sibling capabilities MUST be able to register additional steps (MCP proxy, daemon setup) without modifying the command core.

#### Scenario: Steps run in declared order
- **WHEN** `chorus agents add` executes
- **THEN** registered steps run in ascending order, `once`-scoped steps run a single time and `per-agent` steps run once per selected agent

#### Scenario: A new step is added without core changes
- **WHEN** a sibling registers an additional step into the registry
- **THEN** it participates in the ordered run with no edit to the command's orchestration core

### Requirement: Optional daemon auto-start step in `chorus agents add`

`chorus agents add` SHALL run a `once`-scoped daemon-setup step, ordered after the
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
- **WHEN** a user runs `chorus agents add` in a TTY on a platform that supports auto-start with at least one selected agent that will be woken (wakeable backend + daemonWake enabled)
- **THEN** the daemon-setup step prompts whether to auto-start the daemon on boot with a default of No, and installs & enables the boot service only if the user affirmatively accepts, without writing the deprecated top-level cwds/agent

#### Scenario: No selected agent will be woken skips the prompt and install
- **WHEN** a user runs `chorus agents add` in a TTY on a supported platform but no selected agent will be woken (every one is offline, or a wakeable backend with `daemonWake: false`)
- **THEN** the step keeps the `agents[]` entries, skips the auto-start prompt and the service install entirely, and reports that no agent is enabled for daemon waking

#### Scenario: Declining auto-start leaves daemon config in place
- **WHEN** a user runs `chorus agents add` in a TTY and declines the auto-start prompt
- **THEN** `~/.chorus/daemon.json` retains the per-agent `agents[]` config and the step prints the manual `chorus daemon` start command without installing any service

#### Scenario: Non-interactive run requires an explicit flag to install
- **WHEN** `chorus agents add` runs in a non-TTY environment, or with `--yes` in a TTY, WITHOUT `--daemon-autostart`, and at least one selected agent will be woken
- **THEN** the step skips the boot-service install, reporting that `--daemon-autostart` is required to install the service, and does not block on a prompt

#### Scenario: Auto-start install aborts on unvalidated credentials
- **WHEN** the daemon-setup step decides to install (opt-in or `--daemon-autostart`) but the resolved Chorus key fails server validation, or no credentials resolve
- **THEN** the step installs no service and reports a failure, rather than installing a boot service that would fail authentication at boot

#### Scenario: Non-interactive run with the flag installs the service
- **WHEN** `chorus agents add --daemon-autostart` runs in a non-TTY environment on a supported platform with resolvable credentials and at least one selected agent that will be woken
- **THEN** the step installs and enables the boot service without prompting

#### Scenario: Unsupported platform skips the service and prints manual steps
- **WHEN** `chorus agents add` runs on a platform whose auto-start capability is unsupported (e.g. Windows)
- **THEN** the step prints the manual start steps and does not attempt to install a boot service, regardless of `--daemon-autostart`

#### Scenario: Re-run is idempotent when the service is already installed
- **WHEN** a user re-runs `chorus agents add` (opting in, or with `--daemon-autostart`) on a machine where the boot service is already installed
- **THEN** the step reports the daemon as already configured for auto-start and makes no destructive rewrite, repairing only if a drift is detected

#### Scenario: The step never collects provider secrets
- **WHEN** the daemon-setup step runs in any mode
- **THEN** it collects only the Chorus connection credentials, and never prompts for or persists model-provider secrets into `~/.chorus/daemon.json` or any service unit

### Requirement: Per-selected-agent credential seeding into centralized daemon config

The command SHALL seed Chorus credentials into the centralized daemon configuration (`~/.chorus/daemon.json`), capturing **one Chorus API key per selected agent** and writing each as its own `agents[]` entry carrying that agent's `agentType`. Each selected agent's key MUST be validated against the server before it is persisted. The centralized `daemon.json` SHALL remain the single source of truth for every agent's key and for daemon operation; a coding agent's own configuration file (e.g. `~/.claude`, `~/.codex`) MUST NOT receive an API key as a side effect of daemon seeding, EXCEPT through an explicitly-specified, operator-visible convenience write governed by its own requirement (the Claude Code `~/.claude/settings.json` env write, the dsh `$DSH_HOME/.env` channel, or the Codex `~/.codex/.env` dotenv write). Writes MUST merge into existing daemon configuration without clobbering unrelated fields, and the key MUST be written 0600 and never echoed to output.

On a TTY the command captures a key per selected agent (accepting `--api-key`/`CHORUS_API_KEY` as a pre-fill for the first, and prompting for the rest). In a non-interactive run a supplied `--api-key` applies to the selected agent(s); when multiple selected agents need distinct keys and none can be prompted, the command MUST report which agents still need a key rather than silently reusing one.

#### Scenario: A key is captured and validated per selected agent
- **WHEN** a user selects multiple agents and supplies a valid Chorus key for each (prompt or flag/env)
- **THEN** each key is validated and written as its own `agents[]` entry in `~/.chorus/daemon.json` with that agent's `agentType`, and `daemon.json` remains the source of truth for every agent's key (any coding-agent config write happens only via that agent's own convenience-write requirement)

#### Scenario: Existing daemon config is preserved
- **WHEN** `~/.chorus/daemon.json` already contains unrelated fields (prior agents, acknowledgement timestamps)
- **THEN** seeding updates only the connection/agents fields for the selected agents and leaves unrelated fields intact

#### Scenario: Key never echoed
- **WHEN** a key is captured or written
- **THEN** it is written with 0600 permissions and never printed to stdout/stderr or logs

### Requirement: Daemon backend agentType derived from the init selection, not re-prompted

The daemon-setup step SHALL derive each agent's `daemon.json` backend `agentType` from the agents already chosen in the `chorus agents add` selection step, and SHALL NOT render a separate "which agent backend?" selection prompt. The step-1 selection is the single point at which the agent set is chosen; the credential-seed and daemon-setup steps consume that same selection.

The mapping from an init selection id to a `daemon.json` `agentType` SHALL be explicit and total: the init id `claude` maps to `agentType: "claude-code"`; `codex` → `codex`; `kiro` → `kiro`; and any selected agent whose backend is not daemon-wakeable (`opencode`, `openclaw`, `pi`, and `dsh` while its daemon backend is de-advertised) maps to `agentType: "offline"`. The mapping MUST NOT pass an init id through verbatim when it differs from the daemon backend name (notably `claude` ≠ `claude-code`).

#### Scenario: No second backend prompt
- **WHEN** `chorus agents add` proceeds from agent selection into the daemon-setup step on a TTY
- **THEN** the step derives each agent's `agentType` from the selection and does not display an agent-backend menu again

#### Scenario: claude selection maps to the claude-code agentType
- **WHEN** the init selection includes the `claude` adapter id
- **THEN** its `agents[]` entry records `agentType: "claude-code"` (not `claude`), matching the daemon's `KNOWN_AGENTS` vocabulary

#### Scenario: Non-wakeable selection maps to offline
- **WHEN** the init selection includes an agent with no daemon-wakeable backend (e.g. `opencode` or `pi`)
- **THEN** its `agents[]` entry records `agentType: "offline"`

### Requirement: Per-agent daemon-wake defaults off at init with explicit opt-in

`chorus agents add` SHALL record a per-agent `daemonWake` boolean (defaulting to `false`) on the `agents[]` entry of each selected agent that maps to a daemon-wakeable backend (claude-code / codex / kiro) — the agent is added (its key available to `chorus mcp`) but not woken by the daemon until the operator opts in. A selected agent that maps to
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
- **WHEN** `chorus agents add --agents kiro --yes` runs with neither `--daemon-wake kiro` nor `--daemon-wake-all`
- **THEN** the kiro entry is written `daemonWake: false` without prompting

### Requirement: Interactive `chorus agents add` command

Chorus SHALL provide a client-mode `chorus agents add` subcommand (dispatched under the `chorus agents` group, alongside `daemon` / `login` / `mcp`) that detects the machine's coding agents, lets the user choose which to configure, and runs the ordered configuration steps against the chosen agents. It SHALL carry exactly the prior `chorus init` behavior and flags (`--agents <csv>` / `--all` / `--yes` / `--url` / `--api-key` / `--dsh-profile` / `--daemon-wake[-all]`). Running `chorus agents add --help` (and `chorus agents --help`) MUST print usage without starting the server or any configuration side effect. The bare `chorus init` command MUST NOT exist.

#### Scenario: Interactive run configures selected agents
- **WHEN** a user runs `chorus agents add` in a TTY
- **THEN** the command detects agents, presents a selection with detected agents pre-checked, and after confirmation runs the configuration steps only for the selected agents, ending with a per-agent status summary

#### Scenario: Scriptable non-interactive run
- **WHEN** `chorus agents add --agents claude,codex --url <u> --api-key <k> --yes` runs in a non-TTY environment
- **THEN** it configures exactly Claude Code and Codex without prompting, and a non-TTY run with neither `--agents` nor `--all` aborts with a message to pass one of them

#### Scenario: Help does nothing else
- **WHEN** a user runs `chorus agents add --help`
- **THEN** usage text is printed and the process exits 0 without detecting, prompting, writing files, or launching the server

### Requirement: Agent removal via `chorus agents remove`

Chorus SHALL provide a `chorus agents remove <name|uuid>` subcommand that removes the matching entry from `~/.chorus/daemon.json` `agents[]` with a merge-safe write that preserves every other agent and all top-level fields. The target MUST be matched against an entry's `agentUuid` or `agentName`; an ambiguous name MUST error and instruct the user to use the UUID, and a value matching no configured agent MUST exit non-zero and list the configured agents. The API key MUST NOT be printed. Credential side-files are NOT cleaned up: `$DSH_HOME/.env` (a single shared credential file, not per-agent) MUST be left untouched, `~/.claude/settings.json` (whose `env` may carry a removed Claude Code agent's CHORUS_* keys) MUST be left untouched, and `~/.codex/.env` (which may carry a removed Codex agent's CHORUS_* env) plus `~/.codex/config.toml` (whose `[mcp_servers.chorus]` references the key by `bearer_token_env_var`, holding no literal key) MUST be left untouched — each with a one-line note that the operator may clear it manually.

#### Scenario: Remove by uuid
- **WHEN** `chorus agents remove <uuid>` names a configured agent
- **THEN** that entry is dropped from `agents[]`, the file is rewritten preserving the other agents, and success is reported without printing any key

#### Scenario: No match is a loud error
- **WHEN** `chorus agents remove <value>` matches no `agents[]` entry
- **THEN** the command exits non-zero and lists the configured agent names/UUIDs

#### Scenario: Ambiguous name requires the uuid
- **WHEN** the given name matches more than one agent
- **THEN** the command errors and instructs the user to disambiguate with the agent UUID

#### Scenario: Credential side-files are left untouched with a note
- **WHEN** `chorus agents remove` removes an agent whose CHORUS_* creds were written into a harness config (`~/.claude/settings.json` for Claude Code, or `~/.codex/.env` plus the keyless `~/.codex/config.toml` `[mcp_servers.chorus]` block for Codex)
- **THEN** none of `~/.claude/settings.json`, `~/.codex/.env`, `~/.codex/config.toml`, or `$DSH_HOME/.env` is modified, and the command prints a one-line note that any CHORUS_* creds may remain and can be cleared manually

### Requirement: `chorus agents` groups list / add / remove

The `chorus agents` command SHALL act as an agent-management group: with no sub-verb (or `list`) it lists the configured agents (unchanged), `add` runs the configuration flow, and `remove` deletes an entry. An unknown sub-verb MUST print the `chorus agents` usage and exit non-zero. Every `--help` path under `chorus agents` MUST NOT start the embedded server.

#### Scenario: Bare command lists agents
- **WHEN** a user runs `chorus agents`
- **THEN** the configured agents are listed and no server is started

#### Scenario: Unknown sub-verb shows usage
- **WHEN** a user runs `chorus agents bogus`
- **THEN** the command prints the `chorus agents` usage and exits non-zero

### Requirement: Claude Code interactive credentials via `~/.claude/settings.json` env

For a selected Claude Code (`claude`) agent, `chorus agents add` SHALL write the Chorus connection credentials into the **user-global** `~/.claude/settings.json` `env` block so that an INTERACTIVE Claude Code session authenticates with no manual `export`. It SHALL upsert exactly the three managed keys `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` (the agent's UUID) into the `env` object, preserving every other `env` key and every other top-level settings field verbatim. The file MUST be written with `0600` permissions via an atomic replace, and the API key MUST NOT be echoed to stdout/stderr or logs. The write SHALL target ONLY the user-global `~/.claude/settings.json` — never a project-level `.claude/settings.json` (which is commonly git-tracked) and never `.claude/settings.local.json`.

Because `settings.json` `env` is injected at session start before the MCP client connects and is inherited by hook and Bash/CLI subprocesses, this single write covers the plugin `.mcp.json` `${CHORUS_URL}` / `${CHORUS_API_KEY}` interpolation, the plugin hooks, and the skill `chorus` CLI at once.

A single `chorus agents add` run configures the `claude` agent at most once, so multiple Claude Code identities arise only across repeated runs and the user-global `env` block can carry only one. The command SHALL detect a **repoint** — an existing `env.CHORUS_AGENT_PROFILE` in `~/.claude/settings.json` that differs (by UUID) from the identity being written — and MUST NOT silently overwrite it: on a TTY it MUST prompt before repointing (declining leaves the existing identity in place), and in a non-interactive run it MUST overwrite and emit a WARNING naming the old and new identity. A write whose identity equals the one already present is an idempotent no-op re-write. The repoint comparison MUST use the agent UUID, never the API key.

On a successful write the command SHALL suppress the manual `export CHORUS_AGENT_PROFILE` hint for that agent (the `env` block already carries it), mirroring the dsh `$DSH_HOME/.env` behavior.

If the write fails — the file is locked/unwritable, or an existing `settings.json` contains malformed JSON that cannot be safely merged — or a TTY repoint is declined, the command MUST NOT clobber the file; it SHALL emit an actionable WARNING that names the three env keys the interactive session needs (`CHORUS_URL`, `CHORUS_API_KEY`, `CHORUS_AGENT_PROFILE`), **referencing the API key without printing its value** so the never-echo invariant holds. The remediation the WARNING offers depends on the sub-case: on a **write failure** (no `CHORUS_*` sits in `settings.json` `env`) it MAY offer adding them to `~/.claude/settings.json`'s `env` block OR exporting them in the shell; on a **declined repoint** (a different identity remains in `settings.json`) it MUST direct the operator to edit `~/.claude/settings.json` and MUST NOT suggest a shell export, because — per the precedence below — the retained `settings.json` value would override a shell export. The optional `CHORUS_AGENT_PROFILE` export hint MAY still print, but it MUST NOT be presented as sufficient to connect the native MCP client (which requires the interpolated `CHORUS_URL` and `CHORUS_API_KEY`).

Because `settings.json` `env` OVERRIDES the ambient shell environment (Claude Code replaces the shell-inherited value at session start), the command SHALL print a one-line heads-up when it detects that the ambient shell it runs under already exports a DIFFERENT `CHORUS_*` identity than the one being written — so the operator knows their shell export will be overridden for interactive Claude Code. This detection MUST NOT print any secret, though an in-memory equality check is permitted: the primary signal is comparing the `CHORUS_AGENT_PROFILE` UUID to the identity being written, and `CHORUS_API_KEY` (when present) MAY additionally be compared in memory to the key being written — the heads-up fires when either differs, and neither value is ever printed. Nothing is printed when no different identity is exported. This precedence MUST also be stated in the user-facing documentation.

#### Scenario: Single Claude Code agent gets settings.json env
- **WHEN** `chorus agents add` seeds a Claude Code agent with a validated key and no prior CHORUS_* env is present in `~/.claude/settings.json`
- **THEN** `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` are upserted into `~/.claude/settings.json` `env` (0600), and the manual `export` hint for that agent is suppressed

#### Scenario: Existing settings.json is preserved
- **WHEN** `~/.claude/settings.json` already contains other `env` keys and other top-level fields
- **THEN** only the three managed keys are (re)written, every other key/field is left intact, and the file remains mode 0600

#### Scenario: Same identity re-write is idempotent
- **WHEN** the identity being written equals the `CHORUS_AGENT_PROFILE` already present in `~/.claude/settings.json`
- **THEN** the file is reproduced with no prompt and no warning

#### Scenario: Repointing to a different identity is never silent
- **WHEN** `~/.claude/settings.json` env already carries a different `CHORUS_AGENT_PROFILE` and a new Claude Code identity is written in a non-interactive run
- **THEN** the file is overwritten to the new identity AND a WARNING naming the old and new identity is emitted — while on a TTY the command instead prompts before repointing and leaves the existing identity in place if declined

#### Scenario: Write failure emits an actionable, non-secret warning
- **WHEN** the `settings.json` write fails (locked/unwritable file, or existing malformed JSON)
- **THEN** the existing file is left unchanged and a WARNING names the three required env keys and how to set them in `settings.json` — without ever echoing the API key value

#### Scenario: Ambient-shell conflict prints a non-secret heads-up
- **WHEN** `chorus agents add` writes a Claude Code identity while the ambient shell it runs under already exports a different `CHORUS_AGENT_PROFILE` (or a `CHORUS_API_KEY` that differs on an in-memory compare)
- **THEN** a one-line heads-up notes that `settings.json` `env` overrides the shell for interactive Claude Code — using the profile-UUID compare as the primary signal and never printing the API key value

#### Scenario: Project-level settings are never targeted
- **WHEN** `chorus agents add` writes Claude Code credentials
- **THEN** only the user-global `~/.claude/settings.json` is written — a project-level `.claude/settings.json` or `.claude/settings.local.json` in any working directory is never created or modified

### Requirement: Codex interactive credentials via `~/.codex/.env`

For a selected Codex (`codex`) agent, `chorus agents add` SHALL upsert the Chorus connection credentials — `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` (the agent's UUID) — into the `~/.codex/.env` dotenv file (resolved via `CODEX_HOME`, defaulting to `~/.codex`), so that an INTERACTIVE Codex session's plugin lifecycle hooks (SessionStart check-in / PostToolUse) AND its shell-tool `chorus` calls resolve the correct Chorus identity with no manual `export`. Codex loads `~/.codex/.env` into its own process environment at process startup (the arg0 dotenv loader), filtering only keys prefixed `CODEX_`; that process environment is snapshotted into every hook subprocess and inherited by the exec/shell tool, so a single dotenv write covers both surfaces. This mirrors the Claude Code `~/.claude/settings.json` env write and the dsh `$DSH_HOME/.env` channel; the bare `CHORUS_API_KEY` it writes is ALSO the value that the `config.toml` `[mcp_servers.chorus]` `bearer_token_env_var` block (see the next requirement) resolves at connect time for the native MCP client. Together they make interactive Codex fully export-free — plugin hooks, shell tool, and native MCP — with the API key living in exactly ONE place (`~/.codex/.env`).

The write MUST be a merge-preserving dotenv upsert: it replaces only the three managed keys in place (dropping any duplicate, tolerating an `export ` prefix) and preserves every other line verbatim. The file MUST be written `0600` via an atomic replace, the write MUST be idempotent (a re-run with the same values reproduces the file), and the API key MUST NOT be echoed to stdout/stderr or logs. The write SHALL occur for EVERY selected Codex agent (single- and multi-agent alike), because the Codex plugin hooks never make a bare auto-single MCP call (`on-session-start.sh` requires `CHORUS_URL`+`CHORUS_API_KEY` present before it runs).

`chorus agents add` MUST NOT write the credentials into `config.toml` `[shell_environment_policy]` (superseded by the dotenv sink) and MUST NOT introduce a launcher wrapper (e.g. `chorus launch codex`). The `config.toml` `[mcp_servers.chorus]` native-MCP block is governed by its own requirement below (a keyless `bearer_token_env_var` reference); the API key MUST NOT appear in `config.toml`.

Because `~/.codex/.env` is loaded with override semantics (the arg0 loader `set_var`s each key, so it wins over an ambient shell `CHORUS_*`), the command SHALL detect a repoint — an existing `CHORUS_AGENT_PROFILE` in `~/.codex/.env` that differs (by UUID) from the identity being written — and MUST NOT silently overwrite it: on a TTY it MUST prompt before repointing (declining leaves the existing identity in place and directs the operator to edit `~/.codex/.env` rather than export), and in a non-interactive run it MUST overwrite and emit a WARNING naming the old and new identity. A write whose identity equals the one already present is an idempotent no-op re-write. The repoint comparison MUST use the agent UUID, never the API key.

On a successful write the command SHALL suppress the manual `export CHORUS_AGENT_PROFILE` hint for that agent, because the dotenv file already carries all three vars and reaches both the hooks and the shell tool.

If the write fails — `~/.codex/.env` is locked or unwritable — the command MUST NOT clobber the file; it SHALL emit an actionable WARNING naming the three env keys the interactive session needs and how to set them (add them to `~/.codex/.env`, or `export` them), **referencing the API key without printing its value** so the never-echo invariant holds, and it SHALL NOT introduce a launcher wrapper.

#### Scenario: Codex agent gets creds in ~/.codex/.env
- **WHEN** `chorus agents add` seeds a Codex agent with a validated key
- **THEN** `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` are upserted into `~/.codex/.env` (0600), and the manual `export` hint for that agent is suppressed

#### Scenario: Single Codex agent is still written
- **WHEN** `chorus agents add` seeds a single Codex agent (daemon.json ends up with one agent)
- **THEN** the creds are still written into `~/.codex/.env`, because the Codex hooks do not auto-single and need the env even for one agent

#### Scenario: No API key is written into config.toml
- **WHEN** the Codex credential seed writes `~/.codex/.env`
- **THEN** the API key is written only into `~/.codex/.env`, no `config.toml` `[shell_environment_policy]` write occurs, and any `config.toml` `[mcp_servers.chorus]` block references the key via `bearer_token_env_var` (per the next requirement) rather than a literal

#### Scenario: Existing ~/.codex/.env is preserved
- **WHEN** `~/.codex/.env` already contains other keys
- **THEN** only the three managed CHORUS_* keys are (re)written in place, every other line is left intact, and the file remains mode 0600

#### Scenario: Same values re-write is idempotent
- **WHEN** the values being written equal those already present in `~/.codex/.env`
- **THEN** the file is reproduced with no change and no warning

#### Scenario: Repointing to a different identity is never silent
- **WHEN** `~/.codex/.env` already carries a different `CHORUS_AGENT_PROFILE` and a new Codex identity is written in a non-interactive run
- **THEN** the file is overwritten to the new identity AND a WARNING naming the old and new identity is emitted — while on a TTY the command instead prompts before repointing and, if declined, leaves the existing identity in place and directs the operator to edit `~/.codex/.env`

#### Scenario: Write failure emits an actionable, non-secret warning
- **WHEN** the `~/.codex/.env` write fails (locked or unwritable file)
- **THEN** the existing file is left unchanged and a WARNING names the three required env keys and how to set them, without ever echoing the API key value, and no launcher wrapper is introduced

#### Scenario: Interactive hooks are export-free
- **WHEN** an interactive Codex session starts after the write, in a shell that exports none of the CHORUS_* vars
- **THEN** the SessionStart check-in hook resolves `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` from `~/.codex/.env` (via Codex's process environment) and runs, rather than early-exiting as "not configured"

### Requirement: Codex native MCP credentials via `config.toml` `bearer_token_env_var`

For a selected Codex (`codex`) agent, `chorus agents add` SHALL write the Chorus native-MCP server block `[mcp_servers.chorus]` into `~/.codex/config.toml` with `url` set to the Chorus MCP endpoint and `bearer_token_env_var = "CHORUS_API_KEY"` — a keyless reference that Codex resolves from its process environment (which `~/.codex/.env` populates) into `Authorization: Bearer <key>` at connect time. The API key MUST NOT be written into `config.toml`; the literal key lives only in `~/.codex/.env`.

This is required because `codex plugin add` does NOT itself write `[mcp_servers.chorus]` (its `ON_INSTALL` authentication policy is metadata only), so absent this write the native MCP server would be unconfigured. The write SHALL run after `codex plugin add` (so it is authoritative over anything the plugin install wrote) and SHALL also run on the idempotent already-installed path so a re-run normalizes the block. The `url` SHALL be normalized to the MCP endpoint (a bare host gains `/api/mcp`, matching the hook wrapper's normalization).

The write MUST be a targeted upsert that preserves every other section, key, and comment in `config.toml` verbatim. If an existing `[mcp_servers.chorus]` carries a literal `[mcp_servers.chorus.http_headers]` `Authorization` header, the writer SHALL remove that `Authorization` line (dropping the `http_headers` subtable when it becomes empty, preserving any other header) so no plaintext key and no duplicate `Authorization` remain. The file MUST be written `0600` via an atomic replace, the write MUST be idempotent, and the API key value MUST NOT be echoed to stdout/stderr or logs. When no Chorus URL can be resolved, the command SHALL skip the MCP-block write with a note rather than fail the plugin install.

Because the key is now sourced from an env var, a daemon-woken Codex (whose spawner exports `CHORUS_API_KEY` into the child environment) also authenticates to the native MCP server — closing the prior gap where a literal `config.toml` Bearer made the daemon-exported key unreachable by Codex MCP.

#### Scenario: A fresh config.toml gets a keyless [mcp_servers.chorus]
- **WHEN** `chorus agents add --agents codex` runs and `~/.codex/config.toml` has no `[mcp_servers.chorus]`
- **THEN** a `[mcp_servers.chorus]` block is written with `url` (normalized to the `/api/mcp` endpoint) and `bearer_token_env_var = "CHORUS_API_KEY"`, at mode 0600, containing no literal API key

#### Scenario: An existing literal Authorization is migrated to bearer_token_env_var
- **WHEN** `~/.codex/config.toml` already has `[mcp_servers.chorus]` with a literal `[mcp_servers.chorus.http_headers]` `Authorization = "Bearer <key>"`
- **THEN** the writer sets `bearer_token_env_var = "CHORUS_API_KEY"` and removes the literal `Authorization` line (dropping an emptied `http_headers` subtable, keeping any other header), leaving no plaintext key and no duplicate `Authorization`

#### Scenario: The MCP block write is idempotent and preserves the rest of the file
- **WHEN** `chorus agents add --agents codex` is re-run against an already-normalized `config.toml`
- **THEN** the `[mcp_servers.chorus]` block is reproduced with no change, every other section/key/comment is preserved verbatim, and the file remains mode 0600

#### Scenario: No URL resolves — the MCP write is skipped, not failed
- **WHEN** no Chorus URL can be resolved for the Codex agent (no `--url`, no `CHORUS_URL`)
- **THEN** the `[mcp_servers.chorus]` write is skipped with a note and the plugin install still succeeds, rather than the command failing

