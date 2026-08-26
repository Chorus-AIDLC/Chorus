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

The command SHALL seed Chorus credentials into the centralized daemon configuration (`~/.chorus/daemon.json`), capturing **one Chorus API key per selected agent** and writing each as its own `agents[]` entry carrying that agent's `agentType`. Each selected agent's key MUST be validated against the server before it is persisted. The centralized `daemon.json` SHALL remain the single source of truth for every agent's key and for daemon operation; a coding agent's own configuration file (e.g. `~/.claude`, `~/.codex`) MUST NOT receive an API key as a side effect of daemon seeding, EXCEPT through an explicitly-specified, operator-visible convenience write governed by its own requirement (the Claude Code `~/.claude/settings.json` env write, the dsh `$DSH_HOME/.env` channel, or the Codex `~/.codex/config.toml` `[shell_environment_policy]` env write). Writes MUST merge into existing daemon configuration without clobbering unrelated fields, and the key MUST be written 0600 and never echoed to output.

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

Chorus SHALL provide a `chorus agents remove <name|uuid>` subcommand that removes the matching entry from `~/.chorus/daemon.json` `agents[]` with a merge-safe write that preserves every other agent and all top-level fields. The target MUST be matched against an entry's `agentUuid` or `agentName`; an ambiguous name MUST error and instruct the user to use the UUID, and a value matching no configured agent MUST exit non-zero and list the configured agents. The API key MUST NOT be printed. Credential side-files are NOT cleaned up: `$DSH_HOME/.env` (a single shared credential file, not per-agent) MUST be left untouched, `~/.claude/settings.json` (whose `env` may carry a removed Claude Code agent's CHORUS_* keys) MUST be left untouched, and `~/.codex/config.toml` (whose `[shell_environment_policy]` `set` may carry a removed Codex agent's CHORUS_* env, and whose `[mcp_servers.chorus]` carries its literal Bearer) MUST be left untouched — each with a one-line note that the operator may clear it manually.

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
- **WHEN** `chorus agents remove` removes an agent whose CHORUS_* creds were written into a harness config (`~/.claude/settings.json` for Claude Code, or `~/.codex/config.toml` `[shell_environment_policy].set` + `[mcp_servers.chorus]` for Codex)
- **THEN** none of `~/.claude/settings.json`, `~/.codex/config.toml`, or `$DSH_HOME/.env` is modified, and the command prints a one-line note that any CHORUS_* creds may remain and can be cleared manually

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

### Requirement: Codex interactive credentials via `config.toml` `[shell_environment_policy]`

For a selected Codex (`codex`) agent, `chorus agents add` SHALL upsert the Chorus connection credentials — `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` (the agent's UUID) — into the `[shell_environment_policy]` `set` table of that agent's `~/.codex/config.toml` (resolved via `CODEX_HOME`, defaulting to `~/.codex`), so that an INTERACTIVE Codex session's plugin hooks and shell-tool `chorus` calls resolve the correct Chorus identity with no manual `export`. This mirrors the Claude Code `~/.claude/settings.json` env write and the dsh `$DSH_HOME/.env` channel. The write MUST be a targeted upsert that preserves every other section, key, and comment in `config.toml` verbatim — in particular the literal `[mcp_servers.chorus]` `Authorization: Bearer <key>` written by `codex plugin add` MUST be left intact. The file MUST be written `0600` via an atomic replace, the write MUST be idempotent (a re-run with the same values reproduces the file), and the API key MUST NOT be echoed to stdout/stderr or logs.

The write SHALL occur for EVERY selected Codex agent, not only in multi-agent setups: the Codex plugin hooks never make a bare auto-single MCP call (`on-session-start.sh` requires `CHORUS_URL`+`CHORUS_API_KEY` in the environment before it runs, and `chorus-mcp-call.sh` resolves via `CHORUS_AGENT_PROFILE`+CLI OR url+key), so a single-agent interactive Codex also needs these env values present.

The three keys together support the harness's established resolution order (verified against the Claude Code plugin's `chorus-api.sh` and the Codex `chorus-mcp-call.sh`): the hook/CLI layer PREFERS `CHORUS_AGENT_PROFILE` + the `chorus` CLI (>= 0.17.0), which reads the key from `~/.chorus/daemon.json`, and FALLS BACK to `CHORUS_URL`+`CHORUS_API_KEY` when the CLI is absent or too old. Writing all three makes both paths available and satisfies the hooks' url+key preflight; no plugin-hook code change is required. `chorus agents add` MUST NOT introduce a launcher wrapper (e.g. `chorus launch codex`).

`[shell_environment_policy].set` governs the environment of Codex's exec/shell tool, so this write covers the model's own `chorus` shell calls. Whether it also reaches Codex's plugin lifecycle hook subprocesses (a separate spawn path) was verified by the task-2 spike (codex-cli 0.146.1): it does NOT — the hook command runner applies only the hook's static `env` and otherwise inherits Codex's own process env, never `[shell_environment_policy]`. Therefore `chorus agents add` MUST surface the residual interactive-hook gap via an actionable message plus the manual `export CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE` guidance — it MUST NOT introduce a wrapper and MUST NOT silently ignore the gap.

On a successful write the command SHALL suppress the generic profile-only `export CHORUS_AGENT_PROFILE` hint for that agent and instead emit an accurate note: the write wires Codex's shell/exec-tool `chorus` calls, but the plugin lifecycle hooks (SessionStart / PostToolUse) inherit Codex's own process env — so to fire those hooks in an interactive session the operator must start `codex` from a shell exporting the three vars (the daemon-wake path sets them automatically). No config mechanism wires the hooks and no launcher wrapper is added.

If the write fails — `config.toml` is locked/unwritable, or its existing structure cannot be safely edited for the managed keys — the command MUST NOT clobber the file; it SHALL emit an actionable WARNING naming the three env keys the interactive session needs and how to set them (add them under `[shell_environment_policy.set]` in `~/.codex/config.toml`, or `export` them), **referencing the API key without printing its value** so the never-echo invariant holds.

#### Scenario: Codex agent gets creds in config.toml
- **WHEN** `chorus agents add` seeds a Codex agent with a validated key
- **THEN** `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` are upserted into `[shell_environment_policy].set` of that agent's `~/.codex/config.toml` (0600), and the manual `export` hint for that agent is suppressed

#### Scenario: Single Codex agent is still written
- **WHEN** `chorus agents add` seeds a single Codex agent (daemon.json ends up with one agent)
- **THEN** the creds are still written into `config.toml` `[shell_environment_policy].set`, because the Codex hooks do not auto-single and need the env even for one agent

#### Scenario: The literal Bearer is preserved
- **WHEN** the creds are written into a `config.toml` that already contains a literal `[mcp_servers.chorus]` `Authorization: Bearer <key>`
- **THEN** only the managed keys under `[shell_environment_policy].set` are written and the `[mcp_servers.chorus]` block is preserved verbatim

#### Scenario: Existing config.toml is preserved
- **WHEN** `~/.codex/config.toml` already contains other sections, keys, and comments
- **THEN** only the managed CHORUS_* keys are (re)written, every other section/key/comment is left intact, and the file remains mode 0600

#### Scenario: Same values re-write is idempotent
- **WHEN** the values being written equal those already present under `[shell_environment_policy].set`
- **THEN** the file is reproduced with no change and no warning

#### Scenario: Write failure emits an actionable, non-secret warning
- **WHEN** the `config.toml` write fails (locked/unwritable, or an ambiguous existing structure the writer refuses to edit)
- **THEN** the existing file is left unchanged and a WARNING names the three required env keys and how to set them, without ever echoing the API key value, and no launcher wrapper is introduced

#### Scenario: Hook gap is surfaced via the hint, never a wrapper
- **WHEN** the hook-coverage spike determines Codex plugin hooks do NOT inherit `[shell_environment_policy].set`
- **THEN** the shell-tool `chorus` calls still resolve via the injected env, and the residual hook gap is surfaced through an actionable message plus the manual `export` hint — no `chorus launch codex` wrapper is added and the gap is not silently ignored

