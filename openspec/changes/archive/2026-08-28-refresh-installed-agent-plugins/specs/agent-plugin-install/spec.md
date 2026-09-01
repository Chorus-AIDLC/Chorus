## MODIFIED Requirements

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

## ADDED Requirements

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
