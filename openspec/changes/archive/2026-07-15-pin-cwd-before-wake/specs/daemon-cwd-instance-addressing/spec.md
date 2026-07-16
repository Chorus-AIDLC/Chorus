## MODIFIED Requirements

### Requirement: An owner SHALL be able to pin a target instance when @-mentioning an agent

When an owner @-mentions an agent in a comment, the mention SHALL remain addressed to the agent. The picker-trigger behavior SHALL first honor the pin state of the comment's **root Idea** (resolved via the shared root-idea resolver) for the Idea's assignee agent:

- **When the @-mentioned agent IS the root Idea's assignee agent AND the root Idea is pinned to an instance** (`assigneeType = "agent_instance"`), the mention SHALL inherit that idea's `(host, cwd)` pin with NO picker — even when that instance is currently offline (the inherited pin is HARD: the resulting wake is notify-only, never re-routed to another cwd). The system SHALL NOT prompt the owner to re-choose a cwd that the Idea already fixes.
- **When the @-mentioned agent IS the root Idea's assignee agent AND the root Idea is NOT instance-pinned**, the picker SHALL follow the online-instance rule below (two or more online instances → picker; exactly one → auto-select; none → un-pinned).
- **When the @-mentioned agent is NOT the root Idea's assignee agent** (a different agent, or the comment has no root Idea), the picker SHALL follow the online-instance rule below, and the chosen instance SHALL NOT be persisted to the Idea — the owner re-chooses on each such mention.

The online-instance rule (applied in the two non-inheriting cases above): when the mentioned agent has two or more live instances, the UI SHALL present a secondary picker letting the owner choose which `(host, cwd)` instance the mention targets; when the agent has exactly one live instance the UI SHALL auto-select it with no additional interaction. The pin inherited or chosen SHALL always be the root Idea's pin (never a per-resource / per-task pin) when inheriting, and SHALL be expressed as `(host, cwd)` (a durable "place") rather than a specific connection id, and SHALL never be inferred from the comment's project. A mention that carries no pin SHALL behave exactly as before this change.

#### Scenario: Mentioning the idea's assignee agent inherits the idea's pin with no picker

- **GIVEN** a comment box on an Idea (or a Task derived from that Idea) whose root Idea is pinned to instance A of agent G
- **WHEN** the owner @-mentions agent G
- **THEN** the mention MUST inherit instance A's `(host, cwd)` pin
- **AND** no secondary picker MUST be presented, even if agent G has other online instances

#### Scenario: Mentioning the idea's assignee agent when the idea is unpinned still prompts on ambiguity

- **GIVEN** a comment box whose root Idea is assigned to a bare agent G (not instance-pinned) and G has two or more online instances
- **WHEN** the owner @-mentions agent G
- **THEN** the UI MUST present the secondary picker of G's online instances

#### Scenario: Mentioning a different agent is not persisted and prompts each time

- **GIVEN** a comment box whose root Idea is pinned to agent G, and a different agent H with two or more online instances
- **WHEN** the owner @-mentions agent H
- **THEN** the UI MUST present the secondary picker for H
- **AND** the chosen instance MUST NOT change the Idea's assignee (it is re-chosen on the next such mention)

#### Scenario: Inheriting an offline idea pin stays notify-only

- **GIVEN** a comment box whose root Idea is pinned to instance A of agent G, and instance A currently has no online connection
- **WHEN** the owner @-mentions agent G and posts the comment
- **THEN** the mention MUST carry instance A's pin
- **AND** the resulting wake MUST be notify-only (not re-routed to another online cwd of G)

#### Scenario: A single live instance is auto-selected

- **GIVEN** an owner @-mentions an agent that has exactly one live instance and no inheritable idea pin applies
- **WHEN** the mention is being composed
- **THEN** that instance MUST be auto-selected with no additional picker interaction required

#### Scenario: A mention with no pin behaves as before

- **GIVEN** an owner @-mentions an agent with no live instances and no inheritable idea pin
- **WHEN** the mention is composed and posted
- **THEN** the mention MUST carry no pin and behave exactly as before this change
