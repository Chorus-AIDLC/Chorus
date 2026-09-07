# agent-orchestrator-handoff Specification

## Purpose
TBD - created by archiving change persist-agent-orchestrator-handoff. Update Purpose after archive.
## Requirements
### Requirement: Idea and Task assignment provenance SHALL be typed

Every Idea and Task assignment provenance record SHALL store
`assignedByType + assignedByUuid` as one nullable pair. `assignedByType` SHALL be
`user` or `agent`, identify the authenticated actor that explicitly assigned the
resource, and SHALL NOT use `agent_instance`. API responses SHALL resolve the
assigner's current display name using the typed identity. Legacy rows with a
non-null UUID and null type MUST remain readable through compatibility inference
without misclassifying an unknown UUID.

#### Scenario: Agent assignment reads back as an agent

- **WHEN** an authenticated agent explicitly assigns a Task to a worker agent
- **THEN** the Task stores `assignedByType = "agent"` and the assigning agent UUID
- **AND** the Task response exposes `assignedBy.type = "agent"` with a dynamically resolved name

#### Scenario: Human assignment remains user audit metadata

- **WHEN** an authenticated user explicitly assigns or reassigns an Idea or Task
- **THEN** the resource stores `assignedByType = "user"` and that user UUID
- **AND** the response continues to expose the user as the assigner

#### Scenario: Legacy provenance is resolved compatibly

- **GIVEN** a legacy resource with a non-null `assignedByUuid` and null `assignedByType`
- **WHEN** the resource is read
- **THEN** the system MUST resolve a same-company matching user first, then a matching agent
- **AND** it MUST return no assigner when neither identity exists

### Requirement: Only explicit agent dispatch SHALL establish an orchestrator

The system SHALL treat the latest explicit assigner as the resource orchestrator
only when its typed provenance is `agent`. An agent self-claim MUST NOT record the
claiming agent as its own orchestrator. Explicit reassignment SHALL replace both
provenance fields, and release SHALL clear both fields. User provenance SHALL
remain visible for audit but SHALL NOT be exposed as an agent orchestrator.

#### Scenario: Agent self-claim creates no self-orchestrator

- **WHEN** an unassigned Idea or Task is claimed by the worker agent itself
- **THEN** its assignment provenance pair MUST remain null
- **AND** no orchestrator SHALL be derived from the worker's assignee identity

#### Scenario: Explicit agent reassignment replaces the orchestrator

- **GIVEN** a resource previously assigned by agent A
- **WHEN** agent B explicitly reassigns the resource to a worker
- **THEN** its provenance SHALL become `{ type: "agent", uuid: B }`
- **AND** subsequent orchestrator attribution SHALL identify agent B, not agent A

#### Scenario: Release clears provenance

- **WHEN** an Idea or Task is released
- **THEN** `assignedByType` and `assignedByUuid` MUST both be null
- **AND** no orchestrator SHALL be emitted for that resource

#### Scenario: User assigner is not promoted to orchestrator

- **GIVEN** a resource whose assignment provenance type is `user`
- **WHEN** daemon attribution is built
- **THEN** no agent orchestrator SHALL be emitted

### Requirement: Every directly addressed Idea and Task wake SHALL carry stable orchestrator attribution

The server SHALL enrich every daemon notification wake for a directly addressed
Idea or Task with its current agent orchestrator when one exists. Synthetic
resume control events for Ideas and Tasks SHALL use the same company-scoped
resolver and carry the same attribution. Resolution MUST read only the addressed
resource's typed assignment provenance and MUST NOT traverse Idea lineage,
parent/container Ideas, Proposals, Documents, or root-Idea ancestry. The current
notification actor SHALL remain separate and unchanged.

#### Scenario: Idea wake carries its explicit agent assigner

- **GIVEN** an Idea explicitly assigned by agent A to worker W
- **WHEN** any non-null daemon wake notification is serialized for that Idea
- **THEN** it SHALL include orchestrator `{ type: "agent", uuid: A, name: <current name> }`
- **AND** the notification actor SHALL remain the actor that caused the current event

#### Scenario: Task resume carries the same orchestrator as ordinary wakes

- **GIVEN** a Task whose current typed assigner is agent A
- **WHEN** an interrupted execution for that Task is resumed
- **THEN** the synthetic `resource_resumed` payload SHALL include agent A as orchestrator

#### Scenario: Parent Idea assignee is not inferred

- **GIVEN** a child Idea with no agent assigner and a parent Idea assigned to an agent
- **WHEN** a wake is built for the child Idea
- **THEN** no orchestrator SHALL be emitted
- **AND** the server MUST NOT traverse to the parent Idea

#### Scenario: Non-Idea and non-Task entities are unchanged

- **WHEN** a wake directly addresses a Proposal, Document, or daemon session
- **THEN** this capability SHALL NOT derive an orchestrator from a related Idea

### Requirement: Every non-null daemon wake SHALL restate the agent orchestrator

The daemon prompt builder SHALL append a shared block whenever a wake payload
carries an agent orchestrator, naming that orchestrator and giving the exact
`@[Name](agent:uuid)` mention needed for handoff. The block SHALL be present on
every non-null action body, including `resource_resumed`, while preserving the
headless preamble and action-specific actor/requester guidance. A null action
body MUST remain null.

#### Scenario: Ordinary wake contains actor and orchestrator separately

- **GIVEN** a Task wake caused by user U whose resource orchestrator is agent A
- **WHEN** the daemon builds the prompt
- **THEN** the action body SHALL continue to identify user U as the current actor/requester
- **AND** a separate shared block SHALL identify agent A as the resource orchestrator
- **AND** the block SHALL include `@[A](agent:<A uuid>)` mention syntax

#### Scenario: Resume wake repeats orchestrator guidance

- **GIVEN** a resumed Idea or Task payload carrying an agent orchestrator
- **WHEN** `buildPrompt` produces the `resource_resumed` prompt
- **THEN** the prompt SHALL restate the same orchestrator mention and handoff rule

#### Scenario: User provenance does not add a prompt block

- **GIVEN** a wake payload with no agent orchestrator because its assigner is a user
- **WHEN** the prompt is built
- **THEN** no orchestrator block SHALL be appended

#### Scenario: Null body remains null

- **WHEN** an unknown action or blank `human_instruction` produces a null body
- **THEN** orchestrator enrichment MUST NOT create a preamble-only or orchestrator-only wake

### Requirement: Worker workflows SHALL hand off at human gates and completion

Chorus agent workflow guidance SHALL instruct a worker that has an agent
orchestrator to explicitly mention that orchestrator on the current child
resource when the worker reaches a required human gate it cannot cross or when
the child Idea or Task is complete. The guidance SHALL NOT require an
orchestrator mention for ordinary internal progress and SHALL NOT imply an
automatic server subscription.

#### Scenario: Worker reaches a human-only gate

- **GIVEN** a worker knows its agent orchestrator from the wake prompt
- **WHEN** the worker reaches elaboration verification, proposal approval, or another required human gate it cannot cross
- **THEN** workflow guidance SHALL require a resource comment that mentions the orchestrator and clearly states the requested handoff
- **AND** the worker SHALL leave the work pending after the asynchronous handoff

#### Scenario: Child resource completes

- **WHEN** a worker completes its assigned child Idea or Task
- **THEN** workflow guidance SHALL require it to mention the orchestrator with the completion status and relevant evidence

#### Scenario: Internal progress remains quiet

- **WHEN** a worker advances an ordinary internal implementation step with no gate or completion
- **THEN** workflow guidance SHALL NOT require an orchestrator mention

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

