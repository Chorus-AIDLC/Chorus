## ADDED Requirements

### Requirement: The plugin SHALL expose Chorus tools by registering the remote MCP server, not by hand-wrapping tools

The plugin MUST make Chorus's tools available to the agent by ensuring a `mcp.servers.chorus` entry exists in OpenClaw config, so OpenClaw connects to the remote Chorus MCP server and auto-exposes its tools. All hand-wrapped tool modules (`src/tools/pm-tools.ts`, `src/tools/dev-tools.ts`, `src/tools/admin-tools.ts`, `src/tools/common-tools.ts`) MUST be deleted, and the entry MUST NOT call `api.registerTool` to re-declare any Chorus tool.

#### Scenario: Hand-wrapped tool modules are gone

- **WHEN** the `packages/openclaw-plugin/src/tools/` directory is listed
- **THEN** it MUST NOT exist, or MUST contain no `*-tools.ts` modules
- **AND** a grep for `registerTool(` across `packages/openclaw-plugin/src/` MUST return zero matches

#### Scenario: Chorus tools surface via the MCP server connection

- **GIVEN** a configured plugin on OpenClaw 2026.5.x with a valid `chorusUrl` and `apiKey`
- **WHEN** the plugin has loaded in `"full"` mode and OpenClaw has connected to `mcp.servers.chorus`
- **THEN** Chorus tools MUST be available to the agent under the `chorus__` namespace prefix (e.g. `chorus__chorus_checkin`)
- **AND** these tools MUST NOT be individually registered by the plugin code

### Requirement: The plugin SHALL write a streamable-http MCP server entry with Bearer auth on activation

On `"full"` activation, the plugin MUST resolve its `chorusUrl` and `apiKey` and ensure `mcp.servers.chorus` equals `{ url: "<chorusUrl>/api/mcp", transport: "streamable-http", headers: { Authorization: "Bearer <apiKey>" } }` by calling `api.runtime.config.mutateConfigFile`. The write MUST be idempotent — skipped when the existing entry already matches the desired entry.

#### Scenario: Missing config skips registration with a warning

- **GIVEN** a plugin whose `pluginConfig` is missing `chorusUrl` or `apiKey`
- **WHEN** `register(api)` runs in `"full"` mode
- **THEN** the plugin MUST NOT call `mutateConfigFile`
- **AND** it MUST log a warning naming the missing field(s)

#### Scenario: First activation writes the chorus MCP server entry

- **GIVEN** a valid config and an OpenClaw config with no `mcp.servers.chorus` entry
- **WHEN** the plugin activates in `"full"` mode
- **THEN** it MUST call `api.runtime.config.mutateConfigFile` to add `mcp.servers.chorus`
- **AND** the written entry's `url` MUST be `chorusUrl` joined with `/api/mcp`
- **AND** its `transport` MUST be `"streamable-http"`
- **AND** its `headers.Authorization` MUST be `"Bearer "` followed by the configured `apiKey`

#### Scenario: Re-activation with an unchanged entry does not rewrite config

- **GIVEN** an OpenClaw config whose `mcp.servers.chorus` already equals the desired entry
- **WHEN** the plugin activates again
- **THEN** it MUST NOT call `mutateConfigFile`
- **AND** it MUST NOT trigger a config reload

#### Scenario: Changed credentials update the entry

- **GIVEN** an existing `mcp.servers.chorus` entry whose `apiKey` or `chorusUrl` differs from the current config
- **WHEN** the plugin activates
- **THEN** it MUST call `mutateConfigFile` to overwrite the entry with the current values
- **AND** the resulting entry MUST reflect the new `chorusUrl`/`apiKey`

### Requirement: A registration failure SHALL be surfaced, never silently swallowed

If ensuring the MCP server entry fails (config write error, unreachable runtime API), the plugin MUST log the error at error level and continue loading the rest of its surfaces; it MUST NOT crash the gateway and MUST NOT silently ignore the failure.

#### Scenario: Config write failure is logged, not fatal

- **GIVEN** a plugin where `api.runtime.config.mutateConfigFile` rejects
- **WHEN** registration runs
- **THEN** the plugin MUST log the failure at error level with the underlying message
- **AND** the SSE service and `/chorus` command MUST still be registered
- **AND** the gateway MUST NOT crash
