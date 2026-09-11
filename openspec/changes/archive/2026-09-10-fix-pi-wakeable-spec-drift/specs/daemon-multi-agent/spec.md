## MODIFIED Requirements

### Requirement: Per-agent backend selection

Each agent SHALL select its own backend from its `agentType`, so a single daemon process MAY run agents on different backends (`claude-code`, `codex`, `kiro`, `pi`) at the same time. The daemon SHALL construct the appropriate spawner per agent and route each agent's wakes to its own spawner.

#### Scenario: Claude and Kiro agents run in one daemon

- **WHEN** one configured agent has `agentType: claude-code` and another has `agentType: kiro`
- **THEN** the daemon wakes the first via a Claude Code subprocess and the second via a Kiro CLI subprocess, each with its own credentials

#### Scenario: Claude and pi agents run in one daemon

- **WHEN** one configured agent has `agentType: claude-code` and another has `agentType: pi`
- **THEN** the daemon wakes the first via a Claude Code subprocess and the second via a `pi` subprocess, each with its own credentials

### Requirement: Offline agent type is a valid, never-woken agents[] entry

An agent's `agentType` MAY be `"offline"`, denoting an agent that is configured in `daemon.json` (with its own validated Chorus key) purely so the local `chorus mcp` proxy can act under that agent's identity, but that the daemon SHALL NOT wake. For an `offline` agent the daemon SHALL NOT construct a spawner, SHALL NOT dispatch wakes, and SHALL NOT register it as a wakeable connection; it remains a first-class credential entry for CLI/MCP proxying. The set of accepted `agentType` values SHALL include `"offline"` alongside the daemon-wakeable backends, and validation SHALL accept it. `"offline"` is the fail-closed classification for any selected agent whose coding-agent backend is not daemon-wakeable (opencode, openclaw, and dsh while its backend is de-advertised) — `pi` is NOT among them: it is a wakeable backend (see the `pi-daemon-backend` capability).

#### Scenario: Offline agent is proxy-only, never woken
- **WHEN** a configured agent has `agentType: "offline"`
- **THEN** the daemon constructs no spawner and dispatches no wake for it, and `chorus mcp` can still resolve its key from `daemon.json` to proxy MCP calls under that agent's identity

#### Scenario: Mixed wakeable and offline agents coexist
- **WHEN** one configured agent is `agentType: claude-code` and another is `agentType: offline`
- **THEN** the daemon wakes the claude-code agent normally and never attempts to wake the offline agent, and both keep independent credential entries

#### Scenario: offline is an accepted agentType value
- **WHEN** `agentType: "offline"` is written or validated
- **THEN** it is accepted as a known value (not rejected as unknown), distinct from the wakeable backends
