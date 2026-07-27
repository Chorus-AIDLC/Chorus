## MODIFIED Requirements

### Requirement: Codex MCP comes from the user config with the daemon key via env

The daemon SHALL NOT synthesize a Codex MCP configuration. It SHALL rely on the user's existing `~/.codex/config.toml` to declare the Chorus MCP server (`[mcp_servers.chorus]`). To make the woken Codex authenticate as the daemon's own agent and allow startup hooks to inspect the same resolved connection context, the spawner SHALL export both the daemon's resolved Chorus URL as `CHORUS_URL` and its resolved API key as `CHORUS_API_KEY` into the child process environment. The API key SHALL be passed through the environment and SHALL NOT appear in process arguments or logs. When the complete context is present and Chorus is reachable, the SessionStart hook SHALL complete check-in without emitting a not-configured warning. When configuration is genuinely incomplete or check-in fails, the existing generic warning SHALL remain visible. Equivalent Chorus configuration warnings SHALL appear at most once during one headless startup, while an independent later startup SHALL be able to emit its own warning. When the user's config declares no Chorus MCP server, the woken Codex SHALL still run (without Chorus tools), and the daemon SHALL log this rather than fail.

#### Scenario: Complete daemon connection context reaches the Codex child

- **WHEN** the daemon has resolved a Chorus URL and API key and wakes the Codex backend
- **THEN** the spawned Codex receives the resolved values as `CHORUS_URL` and `CHORUS_API_KEY`
- **AND** the API key does not appear in process arguments or logs

#### Scenario: Configured and reachable Chorus does not produce a false warning

- **WHEN** a Codex headless child receives the complete daemon connection context and Chorus check-in succeeds
- **THEN** the SessionStart hook MUST NOT report that the Chorus environment is unconfigured
- **AND** Chorus MCP remains available through the user's Codex configuration

#### Scenario: Genuine missing configuration retains the generic warning

- **WHEN** the SessionStart hook runs without a complete Chorus URL and API key pair
- **THEN** it emits the existing generic not-configured warning
- **AND** it exits without attempting an authenticated check-in

#### Scenario: Genuine connection failure retains the generic warning

- **WHEN** the SessionStart hook receives complete configuration but Chorus check-in fails
- **THEN** it emits the existing generic connection-failure warning

#### Scenario: Equivalent startup warning is emitted once

- **WHEN** the same Chorus configuration warning is triggered more than once during one Codex headless startup
- **THEN** the user-visible warning appears at most once
- **AND** an independent later startup can emit the warning again if the failure still exists

#### Scenario: No Chorus MCP configured still runs

- **WHEN** the user's Codex config declares no Chorus MCP server
- **THEN** the wake still spawns and completes, the woken Codex simply lacks Chorus tools, and the daemon logs the absence instead of crashing
