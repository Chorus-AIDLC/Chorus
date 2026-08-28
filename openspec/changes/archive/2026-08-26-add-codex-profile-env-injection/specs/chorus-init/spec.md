## MODIFIED Requirements

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

## ADDED Requirements

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
