## MODIFIED Requirements

### Requirement: Per-selected-agent credential seeding into centralized daemon config

The command SHALL seed Chorus credentials into the centralized daemon configuration (`~/.chorus/daemon.json`), capturing **one Chorus API key per selected agent** and writing each as its own `agents[]` entry carrying that agent's `agentType`. Each selected agent's key MUST be validated against the server before it is persisted. The centralized `daemon.json` SHALL remain the single source of truth for every agent's key and for daemon operation; a coding agent's own configuration file (e.g. `~/.claude`, `~/.codex`) MUST NOT receive an API key as a side effect of daemon seeding, EXCEPT through an explicitly-specified, operator-visible convenience write governed by its own requirement (the Claude Code `~/.claude/settings.json` env write, or the dsh `$DSH_HOME/.env` channel). Writes MUST merge into existing daemon configuration without clobbering unrelated fields, and the key MUST be written 0600 and never echoed to output.

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

Chorus SHALL provide a `chorus agents remove <name|uuid>` subcommand that removes the matching entry from `~/.chorus/daemon.json` `agents[]` with a merge-safe write that preserves every other agent and all top-level fields. The target MUST be matched against an entry's `agentUuid` or `agentName`; an ambiguous name MUST error and instruct the user to use the UUID, and a value matching no configured agent MUST exit non-zero and list the configured agents. The API key MUST NOT be printed. Credential side-files are NOT cleaned up: `$DSH_HOME/.env` (a single shared credential file, not per-agent) MUST be left untouched, and `~/.claude/settings.json` (whose `env` may carry a removed Claude Code agent's CHORUS_* keys) MUST be left untouched — each with a one-line note that the operator may clear it manually.

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
- **WHEN** `chorus agents remove` removes a Claude Code agent whose CHORUS_* env was written into `~/.claude/settings.json`
- **THEN** neither `~/.claude/settings.json` nor `$DSH_HOME/.env` is modified, and the command prints a one-line note that any CHORUS_* keys may remain and can be cleared manually

## ADDED Requirements

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
