# hermes-agents-add Specification

## Purpose
TBD - created by archiving change add-hermes-plugin. Update Purpose after archive.

## Requirements

### Requirement: The server SHALL accept hermes as a daemon client type

`DAEMON_CLIENT_TYPES` in `src/services/daemon-connection.service.ts` MUST include `"hermes"`, together with every validator, label, and test that enumerates client types. A `hermes` connection MUST obey the same liveness rule, AgentInstance upsert, and wake routing as other client types.

#### Scenario: Hermes connection registers

- **WHEN** a client opens `/api/events/notifications` with `clientType=hermes`
- **THEN** the server MUST register the connection and emit `connection_registered`
- **AND** the owning agent MUST be reported online while heartbeats continue

### Requirement: chorus agents add SHALL support Hermes

The `chorus agents add` registry MUST include a `hermes` adapter descriptor. It MUST detect the `hermes` binary and the `~/.hermes` config directory. Its install step MUST resolve the release tag `v<cli-version>` to its peeled commit SHA with `git ls-remote`, then run `hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus --ref <sha> --enable` and the same for `chorus-mcp`, without prompting. If the tag cannot be resolved, it MUST report `failed` and install nothing. When `CHORUS_URL` is not the loopback default (`http://localhost:8637`), it MUST also write or merge a native `mcp_servers.chorus` entry into the Hermes config (`$HERMES_HOME/config.yaml`, default `~/.hermes/config.yaml`), with `url: <CHORUS_URL>/api/mcp` and header `Authorization: "Bearer ${CHORUS_API_KEY}"` kept as a literal placeholder. It MUST preserve all other config content, and it MUST be idempotent. This entry overrides the portable package's loopback-only server of the same name. It MUST print the follow-up configuration: export `CHORUS_URL` / `CHORUS_API_KEY`, set `terminal.cwd` to the repository, set `security.approval.transport: chorus`, `security.approval.transport_fallback: builtin` and `approvals.mode: manual` (the default `smart` mode lets Hermes' guardian approve before the owner is asked), and run `hermes gateway install`. No platform-enable step and no allowlist step are required: the platform auto-enables when both env vars are set (`plugins.enabled` alone suffices), and the adapter seeds the allowlist. The selection MUST map to daemon agent type `offline`, because presence comes from the plugin's own connection. The adapter MUST NOT write any secret to disk.

#### Scenario: Hermes detected and installed

- **GIVEN** `hermes` is on PATH
- **WHEN** the user runs `chorus agents add --agents hermes`
- **THEN** both plugin directories MUST be installed at the commit SHA of tag `v<cli-version>` and enabled
- **AND** the stored daemon agent type MUST be `offline`

#### Scenario: Remote Chorus gets a native MCP entry

- **GIVEN** `CHORUS_URL=https://chorus.example.com`
- **WHEN** the adapter installs
- **THEN** `$HERMES_HOME/config.yaml` MUST contain `mcp_servers.chorus.url: https://chorus.example.com/api/mcp` and the header placeholder `Bearer ${CHORUS_API_KEY}`
- **AND** re-running the adapter MUST leave the file unchanged

#### Scenario: Hermes missing

- **GIVEN** `hermes` is not on PATH
- **WHEN** the user selects hermes
- **THEN** the adapter MUST report it as not detected, with a link to the Hermes install docs, and exit without writing anything
