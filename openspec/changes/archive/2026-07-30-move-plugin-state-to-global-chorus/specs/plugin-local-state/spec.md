# Spec delta — plugin-local-state

## ADDED Requirements

### Requirement: Global plugin state root

The Claude Code plugin SHALL store all of its hook-coordination state under a single user-global root `~/.chorus/plugin/`, and SHALL NOT create a `.chorus/` directory inside the project working directory for new sessions. The global root MUST be physically disjoint from the daemon's top-level `~/.chorus/` files (`daemon.json`, `daemon.pid`, `daemon.log`, `*-sessions.json`) so the two never collide.

#### Scenario: State written to global root, not project dir

- **WHEN** a Claude Code session with the Chorus plugin performs any hook action that persists state (checkin caching, sub-agent session mapping, MCP handshake)
- **THEN** the resulting files are created under `~/.chorus/plugin/<cwd-slug>/<sessionId>/`
- **AND** no new `.chorus/` directory is created inside `${CLAUDE_PROJECT_DIR}`

#### Scenario: Daemon files are never touched

- **WHEN** the plugin creates or removes its state directory
- **THEN** the daemon's `~/.chorus/daemon.json`, `~/.chorus/daemon.pid`, `~/.chorus/daemon.log`, and `~/.chorus/*-sessions.json` are neither read nor modified nor deleted

### Requirement: Readable per-project, per-session partitioning

The plugin SHALL partition state by project and by session using the path `~/.chorus/plugin/<cwd-slug>/<sessionId>/`. The `<cwd-slug>` MUST be a human-readable encoding of the absolute project directory (mirroring Claude Code's own `~/.claude/projects/` encoding — non-alphanumeric characters replaced with `-`), NOT an opaque hash. The `<sessionId>` MUST be the Claude Code session id so that concurrent sessions on the same project occupy distinct directories.

#### Scenario: cwd encoded to a legible slug

- **WHEN** the project directory is `/home/ubuntu/dev/ai-pm`
- **THEN** the resolved `<cwd-slug>` is `-home-ubuntu-dev-ai-pm`
- **AND** the slug contains no hash digest

#### Scenario: Concurrent sessions on one project are isolated

- **WHEN** two Claude Code sessions run in the same project directory at the same time
- **THEN** each writes to its own `~/.chorus/plugin/<cwd-slug>/<sessionId>/` directory keyed by its distinct session id
- **AND** neither session's `state.json`, `sessions/`, `pending/`, or `claimed/` files overwrite the other's

#### Scenario: Sub-agent handoff resolves within one session

- **WHEN** the PreToolUse:Task hook writes a pending file and the SubagentStart hook later claims it
- **THEN** both resolve to the same `<sessionId>` directory (they share the session's top-level Claude Code `session_id`)
- **AND** the pending → claimed → sessions handoff completes as before the migration

#### Scenario: Cross-hook state lookups resolve to the writer's partition

- **WHEN** the SubagentStart hook writes `session_<agentId>` / `session_<teammateName>` mappings into its session's `state.json`, and later the TeammateIdle, TaskCompleted, or SubagentStop hook reads those mappings back
- **THEN** the reading hook resolves to the same `<sessionId>` partition as the writing hook (all share the one top-level Claude Code `session_id`)
- **AND** teammate heartbeats and task auto-checkout continue to function — no lookup silently misses because a reader landed in a different partition than the writer

### Requirement: Session-scoped cleanup

On session end the plugin SHALL remove only the current session's directory (`~/.chorus/plugin/<cwd-slug>/<sessionId>/`), and MUST NOT delete directories belonging to other concurrent sessions of the same project.

#### Scenario: End removes own session directory

- **WHEN** a Claude Code session ends and its session id resolved to a real id
- **THEN** its `~/.chorus/plugin/<cwd-slug>/<sessionId>/` directory is removed
- **AND** any sibling session directory under the same `<cwd-slug>/` is left intact

### Requirement: Fail-soft state resolution

Path resolution and session-id acquisition SHALL be fail-soft: any missing input (unset `HOME`, unset or absent session id, unreadable event payload, missing path module) MUST degrade to a safe default and MUST NOT cause a hook to abort or block a development action. A failure to resolve, create, or clean up the state directory MUST at worst leave the session untracked — never fail the underlying user operation.

#### Scenario: Missing session id falls back without failing

- **WHEN** a hook cannot extract a Claude Code session id from its event payload
- **THEN** state resolves to a stable fallback bucket (a `no-session` directory under the project's `<cwd-slug>`)
- **AND** the hook still exits successfully and the development action proceeds

#### Scenario: State directory creation failure does not block work

- **WHEN** the global state directory cannot be created (e.g. read-only `$HOME`)
- **THEN** the hook logs a non-fatal warning and exits 0
- **AND** the sub-agent spawn, task work, or user prompt it was attached to is not blocked
