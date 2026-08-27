# chorus-init spec delta — Codex credential sink → `~/.codex/.env`

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Codex interactive credentials via `config.toml` `[shell_environment_policy]`

## ADDED Requirements

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
