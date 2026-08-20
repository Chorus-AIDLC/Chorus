# daemon-multi-agent Specification

## Purpose
TBD - created by archiving change daemon-multi-agent-configs. Update Purpose after archive.
## Requirements
### Requirement: Multiple independent agent configurations in daemon.json

The daemon SHALL accept an optional `agents` array in `~/.chorus/daemon.json`, where each element is a complete, independent agent configuration containing at minimum an `apiKey` and optionally `url`, `agentType`, `cwds`, `permissionMode`, `maxConcurrency`, `sigintTimeoutMs`, and `browseRoots`. Every existing top-level field SHALL act as a **default**, and any field present on an individual agent SHALL override that default for that agent only. The daemon SHALL validate that each agent has a non-empty `apiKey` and a resolvable `url`, and that each `agentType` is a known backend; on a violation it SHALL exit non-zero naming the offending agent and SHALL NOT silently drop or fall back.

#### Scenario: Each agent merges its fields over top-level defaults

- **WHEN** `daemon.json` has a top-level `url` and `sigintTimeoutMs` and an `agents[]` where one agent omits `url` but sets its own `cwds` and `maxConcurrency`
- **THEN** that agent resolves with the top-level `url` and `sigintTimeoutMs` as defaults and its own `cwds` and `maxConcurrency` as overrides

#### Scenario: Invalid agent entry fails visibly

- **WHEN** an `agents[]` entry has no `apiKey`, or an unresolvable `url`, or an unknown `agentType`
- **THEN** the daemon exits non-zero with an error naming the offending agent and does not start, rather than silently skipping it

### Requirement: Backward-compatible single-agent configuration

When `daemon.json` contains no `agents` array (or an empty one), the daemon SHALL synthesize exactly one agent from the existing flat top-level resolution (`url` / `apiKey` / `cwds` / agent type / etc.) and SHALL behave identically to the current single-agent daemon. Existing installs SHALL require zero edits to keep working, and CLI flags and environment variables (`--url`, `--api-key`, `--agent`, `--cwd`, `CHORUS_*`) SHALL continue to resolve the flat/default layer as they do today.

#### Scenario: Flat config runs as one agent unchanged

- **WHEN** an existing `daemon.json` with only top-level `url` + `apiKey` (+ optional `cwds`) and no `agents[]` starts the daemon
- **THEN** the daemon runs exactly one agent with today's behavior — same identity, connections, wake dispatch — with no configuration changes required

#### Scenario: Flags and env still resolve the default layer

- **WHEN** the daemon is started with `--url` / `--api-key` / `--agent` / `--cwd` (or the corresponding `CHORUS_*` env) and no `agents[]` is present
- **THEN** those values resolve the single synthesized agent exactly as before

### Requirement: One daemon serves multiple independent agents concurrently

The daemon SHALL, when multiple agents are configured, run each agent as an independent runtime: each agent SHALL authenticate with its **own** `apiKey` to obtain its **own** agent identity (`agentUuid` via checkin), open its own Server-Sent Events subscription(s) for its own working directories, and dispatch its own wakes. Each agent's identity SHALL be shown in the startup output. A failure (auth error, crashed wake, dropped stream) in one agent's runtime SHALL be logged visibly and SHALL NOT terminate the daemon or disrupt the other agents.

#### Scenario: Two agents come online as distinct identities

- **WHEN** the daemon starts with two agents configured with different `apiKey`s
- **THEN** each authenticates independently, appears as its own identity in the startup output, and registers as its own connection(s), and both remain online simultaneously

#### Scenario: One agent's failure isolates from the others

- **WHEN** one configured agent's key is invalid or its subprocess wake fails
- **THEN** the daemon logs that agent's failure visibly and the other agents continue serving normally

### Requirement: Per-agent backend selection

Each agent SHALL select its own backend from its `agentType`, so a single daemon process MAY run agents on different backends (`claude-code`, `codex`, `kiro`) at the same time. The daemon SHALL construct the appropriate spawner per agent and route each agent's wakes to its own spawner.

#### Scenario: Claude and Kiro agents run in one daemon

- **WHEN** one configured agent has `agentType: claude-code` and another has `agentType: kiro`
- **THEN** the daemon wakes the first via a Claude Code subprocess and the second via a Kiro CLI subprocess, each with its own credentials

### Requirement: Per-agent wake concurrency limit

Each agent SHALL have its own wake-concurrency limit that bounds only that agent's concurrent wakes, and that limit SHALL be configurable via the agent's `maxConcurrency` field (defaulting to the value that is currently the process-wide default). Per-direct-idea serialization SHALL continue to hold within each agent.

#### Scenario: Per-agent concurrency is independent and configurable

- **WHEN** two agents are configured with different `maxConcurrency` values
- **THEN** each agent dispatches at most its own configured number of concurrent wakes, independent of the other agent's limit and load

#### Scenario: Default concurrency preserved when unset

- **WHEN** an agent does not specify `maxConcurrency`
- **THEN** it uses the default limit (the value that is the current process-wide default), so unconfigured behavior is unchanged

### Requirement: Per-agent credential delivery to each backend

The daemon SHALL deliver each agent's own credentials to its spawned subprocess according to that backend's mechanism: for `claude-code`, via the per-wake `--mcp-config` file carrying that agent's `url` and bearer key; for `kiro`, via the per-spawn environment (`CHORUS_API_KEY` / `CHORUS_URL`) that Kiro interpolates from its MCP config at runtime. For `codex`, the daemon SHALL export that agent's `CHORUS_*` environment for the plugin's shell tooling but SHALL treat the Codex Chorus MCP key as **user-managed** in the operator's own Codex config; the daemon SHALL NOT be required to auto-inject a per-agent Codex MCP key in this version. Every spawner SHALL derive the exported `CHORUS_URL` / `CHORUS_API_KEY` for the child environment from the **spawning agent's** credentials, never from a process-global credential.

#### Scenario: Claude agent authenticates with its own key

- **WHEN** a `claude-code` agent is woken
- **THEN** the temporary `--mcp-config` written for that wake contains that agent's `url` and bearer key, so the subprocess acts under that agent's identity

#### Scenario: Kiro agent authenticates with its own key via env

- **WHEN** a `kiro` agent is woken
- **THEN** the daemon exports that agent's `CHORUS_API_KEY` (and `CHORUS_URL`) into the child environment and Kiro resolves its MCP `Authorization` from that env, so the subprocess acts under that agent's identity

#### Scenario: Codex key is user-managed

- **WHEN** a `codex` agent is woken
- **THEN** the daemon exports that agent's `CHORUS_*` env for the plugin shell tooling, and Codex's Chorus MCP authentication comes from the operator-configured Codex config — the daemon does not auto-inject the Codex MCP key

### Requirement: Overlapping working directories are allowed without serialization

The daemon SHALL allow different agents to be configured with the same or overlapping `cwds` and SHALL NOT serialize or reject such overlap. Because each agent has a distinct identity, overlapping cwds SHALL register as distinct connections. The daemon SHALL NOT arbitrate git-worktree contention between agents sharing a cwd; avoiding concurrent conflicting work in a shared working tree (e.g. via separate branches or worktrees) SHALL be the operator's responsibility.

#### Scenario: Two agents share a cwd and both run

- **WHEN** two agents are each configured with the same working directory and both are woken
- **THEN** the daemon runs both without serializing on that cwd, each under its own identity, and does not block or reject the overlap

### Requirement: Registering and managing multiple agents

The CLI SHALL let a user add additional agents without hand-editing being the only option: `chorus login` SHALL support an `--add` mode that validates a new key against the server (with masked interactive entry), then appends the new agent to `daemon.json`'s `agents[]` via the field-level merge writer, without overwriting any existing agent's credentials. The install wizard SHALL support adding more than one agent in a single run. Hand-editing `daemon.json` SHALL remain a fully supported way to manage agents.

#### Scenario: login --add appends a second agent

- **WHEN** the user runs `chorus login --add` with a reachable URL and a valid `cho_` key while a configuration for one agent already exists
- **THEN** the command validates the key, shows the resolved identity, and appends the new agent to `agents[]` (owner-only file permissions) without altering the existing agent's credentials

#### Scenario: Invalid key on --add does not modify the file

- **WHEN** the user runs `chorus login --add` with an invalid or revoked key
- **THEN** the command reports the authentication failure and does not modify `daemon.json`

### Requirement: Offline agent type is a valid, never-woken agents[] entry

An agent's `agentType` MAY be `"offline"`, denoting an agent that is configured in `daemon.json` (with its own validated Chorus key) purely so the local `chorus mcp` proxy can act under that agent's identity, but that the daemon SHALL NOT wake. For an `offline` agent the daemon SHALL NOT construct a spawner, SHALL NOT dispatch wakes, and SHALL NOT register it as a wakeable connection; it remains a first-class credential entry for CLI/MCP proxying. The set of accepted `agentType` values SHALL include `"offline"` alongside the daemon-wakeable backends, and validation SHALL accept it. `"offline"` is the fail-closed classification for any selected agent whose coding-agent backend is not daemon-wakeable (opencode, openclaw, pi, and dsh while its backend is de-advertised).

#### Scenario: Offline agent is proxy-only, never woken
- **WHEN** a configured agent has `agentType: "offline"`
- **THEN** the daemon constructs no spawner and dispatches no wake for it, and `chorus mcp` can still resolve its key from `daemon.json` to proxy MCP calls under that agent's identity

#### Scenario: Mixed wakeable and offline agents coexist
- **WHEN** one configured agent is `agentType: claude-code` and another is `agentType: offline`
- **THEN** the daemon wakes the claude-code agent normally and never attempts to wake the offline agent, and both keep independent credential entries

#### Scenario: offline is an accepted agentType value
- **WHEN** `agentType: "offline"` is written or validated
- **THEN** it is accepted as a known value (not rejected as unknown), distinct from the wakeable backends

### Requirement: Per-agent daemon-wake opt-in via a `daemonWake` field

The daemon SHALL honor a per-agent boolean `daemonWake` on each `agents[]` entry that records whether it wakes that agent. `daemonWake` is orthogonal to `agentType`: `agentType` is the backend identity (a wakeable backend, or `offline` for a backend that cannot be daemon-woken), while `daemonWake` is the operator's opt-in for a *wakeable* backend.

The daemon SHALL wake an agent only when `isWakeableAgentType(agentType)` is true AND `daemonWake` is not `false`. Concretely: an `offline` agent is never woken (regardless of `daemonWake`); a wakeable-backend agent with `daemonWake: false` is NOT woken and receives the same runtime treatment as an offline agent — the daemon builds no spawner, dispatches no wake, and registers no wakeable connection for it, while its key remains in `daemon.json` for the `chorus mcp` proxy; a wakeable-backend agent with `daemonWake: true` or with the field absent IS woken. An absent field MUST be treated as woken so that agent entries written before this field existed continue to be woken.

#### Scenario: Wakeable agent opted out is proxy-only
- **WHEN** an agents[] entry has a wakeable `agentType` (e.g. `kiro`) and `daemonWake: false`
- **THEN** the daemon builds no spawner, dispatches no wake, and registers no wakeable connection for it, and its key remains available to `chorus mcp`

#### Scenario: Wakeable agent opted in is woken
- **WHEN** an agents[] entry has a wakeable `agentType` and `daemonWake: true`
- **THEN** the daemon builds its spawner and wakes it normally

#### Scenario: Absent field is treated as woken (backward compatibility)
- **WHEN** an agents[] entry has a wakeable `agentType` and no `daemonWake` field
- **THEN** the daemon wakes it (absent is not "opted out"), so entries written before the field existed keep working

#### Scenario: Offline dominates the field
- **WHEN** an agents[] entry has `agentType: "offline"`
- **THEN** it is never woken irrespective of any `daemonWake` value

#### Scenario: All selected agents are non-woken
- **WHEN** every configured agent is either `offline` or a wakeable backend with `daemonWake: false`
- **THEN** the daemon has nothing to wake and runs as an idle no-op process, keeping every agent's key available to `chorus mcp`

