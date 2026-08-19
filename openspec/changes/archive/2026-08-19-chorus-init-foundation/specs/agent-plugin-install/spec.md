## ADDED Requirements

### Requirement: Pluggable per-agent adapter contract

Chorus SHALL define a per-agent adapter contract and a registry that is the single source of the supported-agent set. Each adapter MUST expose a stable `id`, a display name, a `detect()` returning binary/config-dir signals, a `readInstallState()` for idempotency, and an `installPlugin()` operation. Adding support for a new agent MUST require only adding one adapter to the registry, with no change to the command core.

#### Scenario: Registry drives the supported set
- **WHEN** the command enumerates configurable agents
- **THEN** the list comes from the adapter registry, and each entry reports detection and current install state via its adapter

#### Scenario: New agent added via one adapter
- **WHEN** a new adapter is registered
- **THEN** it appears in detection, selection, and the plugin-install step with no edit to the orchestration core

### Requirement: Plugin-surface install via each agent's native remote marketplace

For each selected agent, the plugin-install step SHALL install or enable the Chorus plugin using that agent's own mechanism, sourced from that agent's native remote marketplace (the Chorus GitHub repository). This change SHALL install only the plugin surface (skills, hooks, plugin registration) and MUST NOT write per-agent MCP-server configuration or per-agent credentials. For Claude Code specifically, the step MUST use the official `claude plugin` CLI (`marketplace add` then `install chorus@chorus-plugins`) and MUST pass the non-interactive acceptance flag when not attached to a TTY, rather than hand-writing Claude Code's on-disk plugin registry.

#### Scenario: Claude Code plugin installed via official CLI
- **WHEN** Claude Code is selected and its plugin is not yet installed
- **THEN** the step registers the Chorus remote marketplace and installs `chorus@chorus-plugins` through the official `claude plugin` CLI with the non-interactive acceptance flag, and the plugin is enabled on next launch

#### Scenario: No per-agent secret is written
- **WHEN** any agent's plugin surface is installed
- **THEN** no Chorus API key or MCP-server credential is written into that agent's configuration; credentials remain only in the centralized daemon config

### Requirement: Idempotent, backed-up plugin installation

The plugin-install step SHALL be idempotent per agent: it reads current install state, skips agents already installed and enabled, applies only the missing or repair delta for the rest, and backs up any config file before overwriting it. A failure for one agent MUST NOT abort configuration of the other selected agents; the step MUST record a per-agent outcome (installed / repaired / skipped / failed) for the final summary.

#### Scenario: Already-installed agent is skipped
- **WHEN** an agent's Chorus plugin is already installed and enabled
- **THEN** the step reports `skipped` for that agent and performs no write

#### Scenario: One agent's failure is isolated
- **WHEN** installing the plugin for one selected agent fails (e.g. its marketplace is unreachable)
- **THEN** the step records that agent as `failed` with a reason and continues installing the remaining selected agents
