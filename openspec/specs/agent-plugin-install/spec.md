# agent-plugin-install Specification

## Purpose
TBD - created by archiving change chorus-init-foundation. Update Purpose after archive.
## Requirements
### Requirement: Pluggable per-agent adapter contract

Chorus SHALL define a per-agent adapter contract and a registry that is the single source of the supported-agent set. Each adapter MUST expose a stable `id`, a display name, a `detect()` returning binary/config-dir signals, a `readInstallState()` for idempotency, and an `installPlugin()` operation. Adding support for a new agent MUST require only adding one adapter to the registry, with no change to the command core.

#### Scenario: Registry drives the supported set
- **WHEN** the command enumerates configurable agents
- **THEN** the list comes from the adapter registry, and each entry reports detection and current install state via its adapter

#### Scenario: New agent added via one adapter
- **WHEN** a new adapter is registered
- **THEN** it appears in detection, selection, and the plugin-install step with no edit to the orchestration core

### Requirement: Plugin-surface install via each agent's native remote marketplace

For each selected agent, the plugin-install step SHALL install or enable the Chorus plugin using that agent's own real install mechanism, whatever form that mechanism takes — a native remote marketplace, a git source, an **npm package** consumed through the agent's plugin CLI, or a **file-template** drop for agents that have no plugin CLI. The step MUST NOT assume a remote marketplace is the only install source. (Header retained verbatim from the pre-existing requirement so this whole-block MODIFIED overwrites it; the body below broadens the mechanism beyond a remote marketplace.) This change SHALL install only the plugin surface (skills, hooks, agents, plugin registration); it MUST NOT write per-agent MCP-server credentials as literals. For Claude Code specifically, the step MUST use the official `claude plugin` CLI (`marketplace add` then `install chorus@chorus-plugins`) and MUST pass the non-interactive acceptance flag when not attached to a TTY, rather than hand-writing Claude Code's on-disk plugin registry.

Every command hardcoded by an installer MUST be verified against that agent's real CLI (recorded in a VERIFIED note); an install path that cannot be verified MUST fall back to a guided message rather than a guessed command.

#### Scenario: Claude Code plugin installed via official CLI
- **WHEN** Claude Code is selected and its plugin is not yet installed
- **THEN** the step registers the Chorus remote marketplace and installs `chorus@chorus-plugins` through the official `claude plugin` CLI with the non-interactive acceptance flag, and the plugin is enabled on next launch

#### Scenario: Install source is not limited to a remote marketplace
- **WHEN** a selected agent has no remote marketplace but exposes another real install command (an npm-package plugin CLI, or a file-template drop)
- **THEN** the step installs the Chorus plugin via that command instead of reporting the agent unsupported

#### Scenario: No per-agent secret is written
- **WHEN** any agent's plugin surface is installed
- **THEN** no Chorus API key is written as a literal into that agent's configuration; where an agent's plugin surface requires an MCP-server entry (kiro), the credential is stored as an environment reference (`${env:...}`), not a resolved value

### Requirement: Idempotent, backed-up plugin installation

The plugin-install step SHALL be idempotent per agent during ordinary repair: it reads current install state, skips agents already installed and enabled when installed-plugin refresh was not accepted, applies only the missing or repair delta for the rest, and backs up any config file before overwriting it. When installed-plugin refresh is accepted, an already-installed automated harness MUST invoke its verified native update/reinstall or template-refresh mechanism to obtain the latest available Chorus plugin payload while preserving the same backup and credential-safety guarantees. A failure for one agent MUST NOT abort configuration of the other selected agents; the step MUST record a per-agent outcome (installed / repaired / skipped / failed) for the final summary, and any failed refresh MUST contribute to a non-zero command exit.

#### Scenario: Already-installed agent is skipped without refresh acceptance
- **WHEN** an agent's Chorus plugin is already installed and enabled and installed-plugin refresh was not accepted
- **THEN** the step reports `skipped` for that agent and performs no plugin-payload write

#### Scenario: Already-installed agent is refreshed after acceptance
- **WHEN** an automated harness's Chorus plugin is already installed and installed-plugin refresh was accepted
- **THEN** the step invokes that harness's verified latest update/reinstall or template-refresh path and reports a visible `repaired` outcome on success

#### Scenario: One agent's failure is isolated
- **WHEN** installing or refreshing the plugin for one selected agent fails
- **THEN** the step records that agent as `failed` with a reason, continues processing the remaining selected agents, and the overall command exits non-zero

#### Scenario: Refresh preserves secret-storage guarantees
- **WHEN** an installed plugin is refreshed
- **THEN** existing mutable configuration is backed up before overwrite and no Chorus API key is written as a literal into plugin or MCP configuration

### Requirement: dsh plugin installed via its npm-package plugin CLI

For dsh, the plugin-install step SHALL install the published Chorus dsh bundle through dsh's own plugin CLI: `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w`. The step MUST verify `pnpm` is available on PATH before attempting the install (dsh delegates package management to pnpm) and MUST include the mandatory workspace flag. The `--profile <name>` MUST be resolved by detecting the user's existing dsh profiles and letting the user choose; when no TTY is available it MUST require an explicit profile and MUST NOT guess one. The step configures only the interactive dsh profile and MUST NOT modify the daemon-managed dsh composition.

#### Scenario: dsh bundle installed into the chosen profile
- **WHEN** dsh is selected, `pnpm` is on PATH, and the user picks a profile
- **THEN** the step runs `dsh plugin --profile <chosen> add @chorus-aidlc/chorus-dsh -w` and reports `installed`

#### Scenario: pnpm missing
- **WHEN** dsh is selected but `pnpm` is not on PATH
- **THEN** the step reports `failed` with a detail naming the missing `pnpm` prerequisite and runs no install command

#### Scenario: dsh bundle already present is skipped
- **WHEN** the chosen dsh profile already has `@chorus-aidlc/chorus-dsh`
- **THEN** the step reports `skipped` and performs no write

#### Scenario: No profile resolvable without a TTY
- **WHEN** dsh is selected in a non-interactive run and no explicit profile is provided
- **THEN** the step reports `failed` asking for an explicit profile rather than installing into a guessed profile

### Requirement: openclaw plugin installed and enabled via its npm plugin CLI

For openclaw, the plugin-install step SHALL install the published Chorus openclaw plugin via `openclaw plugins install npm:@chorus-aidlc/chorus-openclaw-plugin` and then enable it via `openclaw plugins enable chorus-openclaw-plugin`. The step MUST guard on the plugin package's declared minimum host version and MUST NOT attempt the install when the installed openclaw is older than that floor.

#### Scenario: openclaw plugin installed then enabled
- **WHEN** openclaw is selected, its host version satisfies the plugin's minimum, and the plugin is not yet installed
- **THEN** the step runs install then enable and reports `installed`

#### Scenario: openclaw host too old
- **WHEN** the installed openclaw version is below the plugin's declared minimum host version
- **THEN** the step reports `failed`/`unsupported` naming the required version and runs no install command

#### Scenario: openclaw plugin installed but disabled is repaired
- **WHEN** the Chorus openclaw plugin is installed but not enabled
- **THEN** the step runs only `enable` and reports `repaired`

### Requirement: kiro plugin installed via a native cross-platform file-template

Kiro has no plugin CLI; for kiro the plugin-install step SHALL install the Chorus plugin by dropping the `.kiro/` file template natively in pure JavaScript (no bash, cross-platform), fetching the template assets from the connected Chorus instance at `$CHORUS_URL/kiro-plugin/…`: copy the Chorus skills, the main `chorus` agent and reviewer subagents, the steering document, and the hook scripts, substitute the absolute hook-binary path for the `__CHORUS_BIN__` placeholder, and merge the `chorus` MCP server into `settings/mcp.json` while preserving existing servers and backing up the original first. Each asset fetch MUST be verified; if the instance cannot serve an asset the step MUST report `failed` naming the unreachable URL rather than leaving a partial drop. The artifact manifest (skills, reviewer agents, hook scripts) MUST be owned by this JavaScript installer (`cli/init/file-template.mjs`) as the single source of truth; the legacy `public/install-kiro.sh` is now a deprecation stub that installs nothing (see `chorus-cli-bootstrap-migration`), so there is no second installer to keep the manifest in sync with. The Chorus API key MUST remain an environment reference in the merged server, never a literal.

#### Scenario: kiro template installed
- **WHEN** kiro is selected and the Chorus `.kiro/` template is not yet installed
- **THEN** the step copies the skills/agents/steering/hooks, substitutes `__CHORUS_BIN__` with the resolved absolute path, merges the `chorus` server into `settings/mcp.json` (other servers preserved, original backed up), and reports `installed`

#### Scenario: __CHORUS_BIN__ placeholder must not survive
- **WHEN** the main agent's hook commands are written
- **THEN** the installer fails loudly if any `__CHORUS_BIN__` placeholder remains unsubstituted

#### Scenario: kiro template already present is skipped
- **WHEN** the Chorus skills, `agents/chorus.json`, and the `chorus` MCP server are all already present
- **THEN** the step reports `skipped` (or repairs only the missing delta) and preserves unrelated user configuration

### Requirement: Honest guided fallback for still-unsupported agents

An agent with no verified automated install path MUST report `unsupported` with an accurate guided message describing the real next step; a guided message MUST NOT claim an agent lacks a plugin surface when it has one. In particular, the dsh guided message that predates dsh's npm plugin install MUST be removed, and pi (deferred) MUST carry copy that accurately points at its manual install rather than a stale or misleading instruction.

#### Scenario: pi remains guided with accurate copy
- **WHEN** pi is selected
- **THEN** the step reports `unsupported` with a message pointing at pi's real manual install path, without claiming pi cannot host the Chorus plugin

#### Scenario: no stale "not a plugin surface" claim
- **WHEN** an agent that does have a real install mechanism is described in guided copy anywhere in the installer
- **THEN** the copy MUST NOT state the agent has no plugin surface or that `chorus agents add` cannot install it

### Requirement: Harness-native latest plugin refresh

When installed-plugin refresh is accepted, Chorus SHALL refresh every already-installed automated harness using its verified native latest-resolution mechanism: Claude Code plugin update, Codex marketplace upgrade followed by plugin add, opencode forced global plugin install, dsh profile-scoped package add, OpenClaw npm plugin install plus enable, and Kiro template download. Refresh MUST retain harness-specific prerequisites and repair behavior, including the OpenClaw host-version guard, dsh profile resolution, Codex keyless MCP normalization, and Kiro merge-preserving MCP configuration.

#### Scenario: Claude Code refreshes through plugin update
- **WHEN** Claude Code is selected, its Chorus plugin is installed, and refresh is accepted
- **THEN** Chorus runs `claude plugin update chorus@chorus-plugins -y`

#### Scenario: Codex refreshes marketplace and plugin cache
- **WHEN** Codex is selected, its Chorus plugin is installed, and refresh is accepted
- **THEN** Chorus backs up `config.toml`, upgrades the `chorus-plugins` marketplace snapshot, reruns `codex plugin add chorus@chorus-plugins --json`, and normalizes the keyless Chorus MCP block

#### Scenario: opencode forces global plugin replacement
- **WHEN** opencode is selected, its Chorus plugin is installed, and refresh is accepted
- **THEN** Chorus backs up `opencode.json` and runs the global plugin install with `--force`

#### Scenario: dsh refreshes the selected profile package
- **WHEN** dsh is selected, its Chorus bundle is installed in the resolved profile, `pnpm` is available, and refresh is accepted
- **THEN** Chorus reruns the profile-scoped `dsh plugin ... add @chorus-aidlc/chorus-dsh -w` command

#### Scenario: OpenClaw reinstalls and enables the npm plugin
- **WHEN** OpenClaw is selected, its Chorus plugin is installed, the host satisfies the minimum version, and refresh is accepted
- **THEN** Chorus reruns the npm plugin install and ensures the plugin is enabled

#### Scenario: Kiro replaces Chorus-owned template assets
- **WHEN** Kiro is selected, its complete Chorus template is installed, and refresh is accepted
- **THEN** Chorus redownloads the current template, replaces Chorus-owned skills, agents, steering, and hooks, and merge-preserves unrelated MCP configuration

