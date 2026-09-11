## ADDED Requirements

### Requirement: Agent-originated idea/theme wakes SHALL carry the waker's live session anchor

The server SHALL enrich an **agent**-caused daemon wake for a directly addressed
Idea or Task with a derived `wakerSession` anchor identifying the waking agent's
current live session for that Idea, so a woken peer can be told where a reply
lands. The anchor SHALL be **derived at
serialization time** from existing session and connection state and SHALL NOT be
persisted (no schema column, no write). The anchor is **actor-scoped**: it
identifies the wake's agent actor and MUST be emitted independently of whether the
resource also has an assignment-derived `orchestrator` (the two are separate
fields and MAY both be present, absent, or identify different agents). Resolution
MUST read only the addressed resource's own idea anchor (its `directIdeaUuid`) and
MUST NOT traverse Idea lineage, parent/container Ideas, Proposals, Documents, or
root-Idea ancestry. The anchor SHALL be emitted only when the waking agent has a
live session for that Idea whose origin connection is currently online; otherwise
it SHALL be absent. A wake caused by a **user** actor SHALL NOT carry a
`wakerSession` anchor.

#### Scenario: Agent @mention wake carries the waker's live session anchor

- **GIVEN** agent A has a live, online-origin session anchored on Idea I
- **WHEN** agent A wakes agent B by mentioning B on Idea I (or a task/comment anchored on I)
- **THEN** the wake payload for B SHALL include a `wakerSession` anchor identifying agent A's live session for Idea I
- **AND** the notification actor SHALL remain agent A unchanged

#### Scenario: Anchor is emitted without an assignment orchestrator

- **GIVEN** Idea I has no agent assignment provenance, so no `orchestrator` is derived
- **AND** agent A has a live, online-origin session on Idea I
- **WHEN** agent A wakes agent B on Idea I
- **THEN** the wake payload SHALL still include a `wakerSession` anchor for agent A
- **AND** `orchestrator` SHALL remain absent

#### Scenario: Offline waker origin emits no anchor

- **GIVEN** agent A's session for Idea I has no currently-online origin connection
- **WHEN** agent A wakes agent B on Idea I
- **THEN** the wake payload SHALL NOT include a `wakerSession` anchor
- **AND** delivery SHALL fall back to the existing notify-only behavior

#### Scenario: User-caused wake carries no anchor

- **WHEN** a wake for an Idea or Task is caused by a user actor
- **THEN** the wake payload SHALL NOT include a `wakerSession` anchor

#### Scenario: Anchor resolution does not traverse lineage

- **GIVEN** a child Idea C with no waker session and a parent Idea P on which the waking agent has a live session
- **WHEN** an agent wake is built for child Idea C
- **THEN** no `wakerSession` anchor SHALL be emitted
- **AND** the server MUST NOT traverse to the parent Idea

### Requirement: The daemon prompt SHALL restate the waker session anchor as advisory return guidance

The daemon prompt builder SHALL append an advisory block whenever a wake payload
carries a live `wakerSession` anchor. The block SHALL name the waking agent with
its `@[Name](agent:uuid)` mention and SHALL state that replying on the current
resource reaches the waker's existing live session rather than opening a new one.
The block is **advisory**: it SHALL NOT assert any server-enforced routing and the
return reply SHALL continue to resolve through the existing return path. The block
SHALL be independent of the existing orchestrator block — either, both, or neither
MAY appear on the same wake. A null action body MUST remain null (anchor
enrichment MUST NOT create a preamble-only or anchor-only wake). When no live
`wakerSession` anchor is present, no anchor block SHALL be appended.

#### Scenario: Wake with a live anchor gets the advisory return line

- **GIVEN** a wake payload for agent B carrying a `wakerSession` anchor for agent A
- **WHEN** the daemon builds the prompt
- **THEN** the prompt SHALL include a block naming `@[A](agent:<A uuid>)` and stating that a reply on this resource reaches A's live session
- **AND** the block SHALL NOT claim any automatic server routing

#### Scenario: Anchor block and orchestrator block coexist

- **GIVEN** a wake payload carrying both an `orchestrator` (agent O) and a `wakerSession` anchor (agent A)
- **WHEN** the prompt is built
- **THEN** the orchestrator handoff block for O SHALL be present
- **AND** the separate waker-session advisory block for A SHALL also be present

#### Scenario: No anchor means no anchor block

- **WHEN** a wake payload has no `wakerSession` anchor (user actor, offline waker, or non-anchored resource)
- **THEN** no waker-session advisory block SHALL be appended

#### Scenario: Null body remains null

- **WHEN** an unknown action or blank `human_instruction` produces a null body
- **THEN** waker-session anchor enrichment MUST NOT create a preamble-only or anchor-only wake
