## ADDED Requirements

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
