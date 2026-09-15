# plugin-subagent-session-naming Specification

## ADDED Requirements

### Requirement: A Claude Code sub-agent's Chorus session SHALL be named after its `subagent_type`

When the Claude Code plugin creates a Chorus session for a sub-agent spawned through the `Task` tool, the session name MUST be the sub-agent type as delivered on the `SubagentStart` event (`agent_type`), which is the same value the spawning `Task` call passed as `subagent_type`. The name MUST NOT be derived from a pending-file filename, and it MUST NOT be a placeholder of the form `unknown-<digits>`.

When — and only when — `agent_type` is absent or empty on the event, the session name MUST fall back to `worker-<first 8 characters of agent_id>`. No code path MUST produce a session name matching `unknown-*`.

#### Scenario: Session name equals the spawned sub-agent type

- **GIVEN** the Chorus plugin hooks are active (`CHORUS_URL` and `CHORUS_API_KEY` are set)
- **WHEN** Claude Code spawns a sub-agent via the `Task` tool with `subagent_type` `"claude"` and the `SubagentStart` event carries `agent_type` `"claude"`
- **THEN** the `chorus_create_session` call issued by the plugin MUST carry `name` = `"claude"`
- **AND** the name MUST NOT match `unknown-*`

#### Scenario: Missing agent type falls back to an agent-id-derived name

- **GIVEN** a `Task` spawn whose `SubagentStart` event carries an empty `agent_type`
- **WHEN** the plugin creates the Chorus session
- **THEN** the session name MUST be `worker-` followed by the first 8 characters of `agent_id`
- **AND** the name MUST NOT match `unknown-*`

### Requirement: The pending file SHALL act as a spawn gate, not a name channel

The per-spawn file written by the `PreToolUse:Task` hook MUST serve only to prove that a given `SubagentStart` corresponds to a real `Task` spawn. `SubagentStart` MUST claim at most one pending file per sub-agent using an atomic move, and MUST skip session creation entirely when no pending file can be claimed (Claude Code's internal or cleanup agents bypass `PreToolUse:Task`). The claimed file's contents and filename MUST NOT influence the session name.

Claiming MUST be first-in-first-out by pending-file modification time. Because the name is taken from the `SubagentStart` event rather than from the file, a FIFO pairing that does not correspond to the same spawn MUST NOT be able to mis-name a session.

For the gate to hold, the set of agent types for which the `PreToolUse:Task` hook writes a pending file MUST equal the set for which the `SubagentStart` hook creates a session: any type skipped by one hook MUST be skipped by the other, so no spawn can leave an unclaimed pending file for an unrelated later agent to claim.

#### Scenario: A sub-agent with no pending file gets no session

- **GIVEN** a `SubagentStart` event for an agent whose spawn never passed through `PreToolUse:Task`
- **AND** the pending directory for the current Claude Code session is empty
- **WHEN** the `SubagentStart` hook runs
- **THEN** no `chorus_create_session` call MUST be issued
- **AND** the hook MUST exit successfully without error output

#### Scenario: A skipped agent type leaves no orphan pending file

- **GIVEN** a sub-agent whose type is on the `SubagentStart` hook's skip list (for example a read-only reviewer type)
- **WHEN** it is spawned via the `Task` tool
- **THEN** the `PreToolUse:Task` hook MUST NOT write a pending file for it
- **AND** no later sub-agent MUST be able to claim a file left behind by that spawn

#### Scenario: Parallel spawns of the same type each get a named session

- **GIVEN** two sub-agents of the same `subagent_type` spawned in the same batch
- **WHEN** both `PreToolUse:Task` invocations write their pending files and both `SubagentStart` hooks run
- **THEN** each invocation MUST write a distinct pending file (no overwrite)
- **AND** each `SubagentStart` MUST claim exactly one file and resolve a session name equal to its own event's `agent_type`

### Requirement: Session reuse by name SHALL be preserved

Before creating a session, the plugin MUST list existing sessions and match by the resolved session name. A matching session with status `active` MUST be reused and heartbeated rather than duplicated; a matching session with status `closed` or `inactive` MUST be reopened; only when no match exists MUST a new session be created. Sub-agent sessions already stored under a legacy `unknown-*` name MUST NOT be renamed or migrated by this change.

Because the name is now a repeating agent type rather than a per-spawn value, several concurrent sub-agents MUST be able to share one session. Session teardown MUST therefore be holder-aware: the plugin MUST track which live sub-agents hold a session name, and a sub-agent's exit MUST tear the session down (close it, release its task check-ins, delete its name-keyed state and metadata file) only when it is the last holder. While another holder is live, an exiting sub-agent MUST clean up only its own agent-id-keyed state and MUST NOT close the session, check out another sub-agent's task, or auto-verify another sub-agent's task.

#### Scenario: A shared session survives a sibling's exit

- **GIVEN** two sub-agents of the same `agent_type` that resolved to one shared Chorus session
- **AND** the second sub-agent still has an open task check-in on that session
- **WHEN** the first sub-agent exits
- **THEN** the plugin MUST NOT close the session
- **AND** it MUST NOT check out the second sub-agent's task
- **AND** the name-keyed state and the `sessions/<name>.json` metadata file MUST still exist

#### Scenario: The last holder tears the shared session down

- **GIVEN** the shared session from the previous scenario, with only one sub-agent left holding it
- **WHEN** that last sub-agent exits
- **THEN** the plugin MUST check out its remaining open check-ins and close the session
- **AND** it MUST delete the name-keyed state and remove the `sessions/<name>.json` metadata file

#### Scenario: A same-named active session is reused

- **GIVEN** an active Chorus session named `"claude"` for the calling agent
- **WHEN** a new sub-agent with `agent_type` `"claude"` starts
- **THEN** the plugin MUST reuse that session's UUID instead of creating a second session
- **AND** it MUST send a heartbeat for that session

#### Scenario: Legacy unknown-named sessions are left untouched

- **GIVEN** Chorus already stores sessions named `unknown-1757000000000000000` from before this change
- **WHEN** any number of new sub-agents are spawned
- **THEN** those existing rows MUST remain unchanged in name and status
- **AND** no rename or backfill routine MUST run
