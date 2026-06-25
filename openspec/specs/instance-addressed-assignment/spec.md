# instance-addressed-assignment Specification

## Purpose
TBD - created by archiving change add-agent-instance-addressing. Update Purpose after archive.
## Requirements
### Requirement: agent_instance is a third polymorphic assignee type

Ideas and Tasks SHALL support a third polymorphic assignee type `agent_instance` in addition
to `user` and `agent`. A pinned assignment SHALL be represented as `assigneeType = "agent_instance"`
with `assigneeUuid` referencing an `AgentInstance.uuid`; an un-pinned agent assignment SHALL
remain `assigneeType = "agent"` with `assigneeUuid` referencing an `Agent.uuid`. No additional
pin columns SHALL be added to Idea or Task — the polymorphic `assigneeType`/`assigneeUuid`
pair SHALL carry the instance reference. The legacy `Task.targetHost` and `Task.targetCwd`
columns SHALL be removed.

#### Scenario: Pinned assignment uses the instance type

- **WHEN** an Idea is assigned to a specific online instance
- **THEN** its `assigneeType` is `"agent_instance"` and `assigneeUuid` is that
  `AgentInstance.uuid`

#### Scenario: Un-pinned assignment stays agent

- **WHEN** an Idea is assigned to an agent without choosing an instance
- **THEN** its `assigneeType` is `"agent"` and `assigneeUuid` is that `Agent.uuid`

### Requirement: An agent_instance assignment resolves to its owning agent everywhere

The system SHALL treat an `agent_instance` assignment as belonging to the agent named by
`AgentInstance.agentUuid` at every site that determines whether work belongs to an agent —
assignment filters ("my assignments", the checkin idea tracker), ownership gates (release,
report, proposal authorship, elaboration), and wake-notification recipient resolution.
A flat equality on `assigneeUuid` against the agent's uuid is insufficient because an
`agent_instance` row's `assigneeUuid` is an instance uuid; resolution SHALL go through the
shared helper that maps an assignment to its canonical agent uuid. A wake-notification
recipient derived from an `agent_instance` assignment SHALL be the agent (type `agent`), not
the instance.

#### Scenario: Checkin idea tracker includes instance-pinned ideas

- **WHEN** an agent checks in and an Idea is assigned to one of that agent's instances
  (`assigneeType = "agent_instance"`)
- **THEN** the idea tracker includes that Idea (it is not dropped)

#### Scenario: Owner of an instance-pinned task may act on it

- **WHEN** an agent attempts an ownership-gated action on a Task assigned to one of that
  agent's instances
- **THEN** the action is permitted, because the assignment resolves to that agent

#### Scenario: Wake recipient is the agent, not the instance

- **WHEN** a notification recipient is derived from an `agent_instance` assignment
- **THEN** the recipient is `{ type: "agent", uuid: <AgentInstance.agentUuid> }`

### Requirement: Wake resolution inherits the root idea's instance for the same agent

Daemon wake pin-resolution SHALL resolve the target instance in this order: the wake's own
task override (a Task whose `assigneeType = "agent_instance"`), then the root Idea's pinned
instance, then agent-overall online-first. The root Idea's instance SHALL be inherited ONLY
when it resolves to the same agent as the wake's target; a Task assigned to a different agent
SHALL NOT inherit the root Idea's instance and SHALL resolve against its own agent. When an
Idea is pinned to an instance, the elaboration-resolve / Verify-Elaborate handoff wake and the
idea-claimed wake SHALL target that instance through this resolution, taking priority over the
existing session-origin heuristic; only when the Idea has no assignee-instance does the
existing online-first / session-origin behavior apply.

#### Scenario: Task inherits the root idea instance (same agent)

- **WHEN** a Task has no instance override, its root Idea is pinned to instance A, and the
  Task resolves to the same agent that owns instance A
- **THEN** the wake targets instance A

#### Scenario: Task override beats the root idea instance

- **WHEN** a Task is itself pinned to instance B and its root Idea is pinned to instance A
- **THEN** the wake targets instance B

#### Scenario: Cross-agent task does not inherit

- **WHEN** a Task is assigned to agent Y while its root Idea is pinned to an instance of
  agent X
- **THEN** the Task does not inherit instance X and resolves against agent Y

#### Scenario: Elaboration-resolve wake targets the idea instance over the session-origin heuristic

- **WHEN** an Idea pinned to instance A has its elaboration resolved (Verify-Elaborate
  handoff), waking the assigned agent
- **THEN** the wake targets instance A, taking priority over the existing idea-session-origin
  upgrade and over agent-overall online-first

### Requirement: An unreachable assignment-pinned instance degrades to a plain agent

The system SHALL distinguish a soft pin (an assignment: a Task `agent_instance` override or an
inherited Idea instance) from a hard pin (a mention's typed `?cwd=&host=` markup). When a soft
pin resolves to an instance that has no online connection, the system SHALL NOT hang or error;
it SHALL degrade gracefully to treating the target as a plain agent and wake the agent's
online-first connection. A degraded assignment behaves as an un-pinned `agent` assignment for
downstream inheritance: later resolve wakes have no instance to inherit and resolve
online-first. A hard mention pin SHALL retain the existing notify-only behavior (no wake, no
online-first re-route) so a human-typed place is never silently redirected.

#### Scenario: Soft assignment pin to an offline instance falls to online-first

- **WHEN** a wake for a Task/Idea assignment resolves to instance A, A has no online
  connection, and the agent has another online connection
- **THEN** the wake is delivered to the agent's online-first connection rather than failing

#### Scenario: Hard mention pin to an offline instance stays notify-only

- **WHEN** a wake from a mention's `?cwd=&host=` markup resolves to an offline instance
- **THEN** no wake is delivered (notify-only) and the wake is NOT re-routed to online-first

### Requirement: Instance selection at assignment offers only online instances

When assigning an Idea or Task to an instance, the instance picker SHALL offer only instances
that currently have an online connection. The picker MAY display offline instances in a
disabled state but SHALL NOT allow pinning to them, because a pin to an offline instance would
immediately degrade. Idea assignment SHALL support choosing an instance, re-assigning to a
different agent, choosing a different instance, and reverting to a plain agent.

#### Scenario: Offline instance cannot be pinned

- **WHEN** the user opens the instance picker for an agent that has both online and offline
  instances
- **THEN** only the online instances are selectable

#### Scenario: Idea can be reverted to a plain agent

- **WHEN** the user re-assigns an instance-pinned Idea back to the plain agent
- **THEN** the Idea's `assigneeType` becomes `"agent"` and downstream wakes resolve
  online-first

### Requirement: Mention markup identifies an instance without changing the wire format

The agent mention token SHALL continue to use the `@[Name](agent:uuid?cwd=…&host=…)` wire
format and the existing pin codec. The optional `?cwd=…&host=…` suffix SHALL be interpreted
as identifying the `AgentInstance` for that agent at `(host, cwd)`. Existing stored comment
tokens SHALL require no migration.

#### Scenario: Pinned mention resolves to an instance

- **WHEN** a comment contains `@[Name](agent:uuid?cwd=/work&host=prod)` and an `AgentInstance`
  exists for that agent at `(host="prod", cwd="/work")`
- **THEN** the mention resolves to that `AgentInstance` for wake targeting, with no change to
  the stored token

