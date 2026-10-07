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

The `chorus agents add` registry MUST include a `hermes` adapter descriptor. It MUST detect the `hermes` binary and the `~/.hermes` config directory. Its install step MUST resolve the release tag `v<cli-version>` to its peeled commit SHA with `git ls-remote`, then run `hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus --ref <sha> --enable` and the same for `chorus-mcp`, without prompting. If the tag cannot be resolved, it MUST report `failed` and install nothing. When `CHORUS_URL` is not the loopback default (`http://localhost:8637`), it MUST also write or merge a native `mcp_servers.chorus` entry into the Hermes config (`$HERMES_HOME/config.yaml`, default `~/.hermes/config.yaml`), with `url: <CHORUS_URL>/api/mcp` and header `Authorization: "Bearer ${CHORUS_API_KEY}"` kept as a literal placeholder. It MUST preserve all other config content, and it MUST be idempotent. This entry overrides the portable package's loopback-only server of the same name, so when the target is the loopback default and a literal native entry already exists (left by an earlier run against a remote Chorus), the adapter MUST repoint it to the loopback URL. An entry whose URL follows `${CHORUS_URL}` already tracks the dotenv and MUST be left unchanged. Its credential-seed step MUST write `CHORUS_URL`, `CHORUS_API_KEY` and `CHORUS_AGENT_PROFILE` into the Hermes dotenv file (`$HERMES_HOME/.env`, default `~/.hermes/.env`), exactly as the Codex adapter writes `~/.codex/.env`: merge-preserving (other keys, such as model provider keys, are kept), idempotent, mode 0600, written atomically, and the key MUST never be echoed. Hermes loads this file into the process environment at CLI and gateway startup, so a gateway run as a service reaches Chorus without any shell export. When the file already names a different `CHORUS_AGENT_PROFILE`, the step MUST ask before repointing on a TTY and MUST warn when it repoints without a TTY. A failed write MUST produce a non-secret warning telling the user to add the variables to that file. It MUST also fill in the gateway settings in `$HERMES_HOME/config.yaml`, using the same targeted textual edit that preserves every other line and comment: `terminal.cwd`, `security.approval.transport: chorus`, `security.approval.transport_fallback: builtin` and `approvals.mode: manual` (the default `smart` mode lets Hermes' guardian approve before the owner is asked). It MUST NOT overwrite a value the user already set, and MUST name each kept value that differs from the recommendation in its summary. Because a gateway installed with `hermes gateway install` runs as a service whose working directory is `$HERMES_HOME`, and Hermes falls back to `$HOME`, `terminal.cwd` MUST be resolved at install time in this order: an explicit `--hermes-cwd <path>` (which overrides an existing value); an existing explicit `terminal.cwd` that is a directory (kept); the git repository root of the directory `chorus agents add` runs in (confirmed on a TTY, where the user may type another path; `--yes` skips the confirmation); otherwise a TTY prompt. Without a TTY and outside a repository, it MUST leave the value unset and warn. A path that is not a directory MUST be rejected with a warning. An invocation with `pluginOnly` (`chorus upgrade --plugins`) MUST NOT touch these settings. It MUST then print the remaining step, `hermes gateway install` followed by `hermes gateway start` (or `restart`), and how to change `terminal.cwd` later. No platform-enable step and no allowlist step are required: the platform auto-enables when both env vars are set (`plugins.enabled` alone suffices), and the adapter seeds the allowlist. The selection MUST map to daemon agent type `offline`, because presence comes from the plugin's own connection.  The API key MUST NOT be written anywhere except that 0600 dotenv file: never into `config.yaml`, the plugin package, argv, or logs.

#### Scenario: Hermes detected and installed

- **GIVEN** `hermes` is on PATH
- **WHEN** the user runs `chorus agents add --agents hermes`
- **THEN** both plugin directories MUST be installed at the commit SHA of tag `v<cli-version>` and enabled
- **AND** the stored daemon agent type MUST be `offline`

#### Scenario: Credentials written to the Hermes dotenv

- **GIVEN** `hermes` is on PATH and `HERMES_HOME=/h`
- **WHEN** the user runs `chorus agents add --agents hermes` with a valid key
- **THEN** `/h/.env` MUST contain `CHORUS_URL`, `CHORUS_API_KEY` and `CHORUS_AGENT_PROFILE`, with mode 0600
- **AND** any pre-existing keys in `/h/.env` MUST be preserved
- **AND** the key MUST NOT appear in the command output

#### Scenario: Gateway settings filled in from the current repository

- **GIVEN** `config.yaml` has `terminal.cwd: "."` and no approval settings
- **WHEN** the user runs `chorus agents add --agents hermes` without a TTY inside the git repository `/work/repo`
- **THEN** `config.yaml` MUST contain `terminal.cwd: /work/repo`, `security.approval.transport: chorus`, `security.approval.transport_fallback: builtin` and `approvals.mode: manual`
- **AND** every other line of `config.yaml` MUST be unchanged

#### Scenario: User-set values are kept

- **GIVEN** `config.yaml` already has `approvals.mode: smart` and an explicit `terminal.cwd` directory
- **WHEN** the adapter runs without `--hermes-cwd`
- **THEN** both values MUST remain unchanged
- **AND** the summary MUST say it kept `approvals.mode: smart`

#### Scenario: Remote Chorus gets a native MCP entry

- **GIVEN** `CHORUS_URL=https://chorus.example.com`
- **WHEN** the adapter installs
- **THEN** `$HERMES_HOME/config.yaml` MUST contain `mcp_servers.chorus.url: https://chorus.example.com/api/mcp` and the header placeholder `Bearer ${CHORUS_API_KEY}`
- **AND** re-running the adapter MUST leave the file unchanged

#### Scenario: Switching back to a local Chorus repoints the native MCP entry

- **GIVEN** an earlier run against `https://old.example.com` wrote `mcp_servers.chorus.url: https://old.example.com/api/mcp`
- **WHEN** the adapter runs again with `CHORUS_URL=http://localhost:8637`
- **THEN** `mcp_servers.chorus.url` MUST become `http://localhost:8637/api/mcp`, so the dotenv, the gateway and MCP all reach the same Chorus

#### Scenario: Hermes missing

- **GIVEN** `hermes` is not on PATH
- **WHEN** the user selects hermes
- **THEN** the adapter MUST report it as not detected, with a link to the Hermes install docs, and exit without writing anything, including the dotenv file
