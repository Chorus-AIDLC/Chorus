# idea-lifecycle-assignment Specification

## Purpose
TBD - created by archiving change reassign-idea-across-lifecycle. Update Purpose after archive.
## Requirements
### Requirement: Idea assignment remains available across lifecycle stages

The system SHALL allow an authorized user to open the existing Idea assignment
control and assign an Idea to any candidate allowed by the current assignment
rules, regardless of whether the Idea is open, elaborating, elaborated, or
derived as complete.

#### Scenario: Reassign an elaborated Idea

- **WHEN** an authorized user opens an elaborated Idea in the Idea Tracker and
  clicks its assignee block
- **THEN** the existing assignment modal opens
- **AND** selecting a valid user, agent, or agent instance updates the Idea
  assignee

#### Scenario: Release an elaborated Idea

- **WHEN** an authorized user selects Release for an elaborated Idea
- **THEN** the Idea assignee is cleared
- **AND** the Idea remains elaborated

### Requirement: Reassignment preserves workflow and linked ownership

Changing an Idea assignee MUST update only the Idea assignment and its existing
audit metadata. It MUST NOT change the Idea lifecycle state or the assignees of
linked Proposals and Tasks.

#### Scenario: Completed Idea remains complete after reassignment

- **WHEN** an Idea whose derived status is complete is reassigned
- **THEN** its stored lifecycle and derived completion status remain unchanged
- **AND** an assignment activity is recorded through the existing activity path

#### Scenario: Linked work ownership is unchanged

- **WHEN** an Idea with linked Proposals or Tasks is reassigned
- **THEN** no linked Proposal or Task assignee is modified

### Requirement: Existing assignment policy remains authoritative

Lifecycle-wide assignment SHALL reuse the current authentication,
authorization, company scoping, candidate selection, and AgentInstance
validation rules.

#### Scenario: Invalid target remains rejected

- **WHEN** a caller attempts to assign an Idea to a target rejected by the
  current assignment policy
- **THEN** the assignment fails without changing the Idea assignee or lifecycle
  state

### Requirement: MCP-callable idea assignment (`chorus_pm_assign_idea`)

The system SHALL provide an MCP tool `chorus_pm_assign_idea` that assigns an Idea to a
specified assignee, reusing the same assignment policy, service primitive, activity path, and
wake pipeline as the existing UI assignment control. The tool SHALL be gated on the
`idea:admin` permission. It SHALL accept an Idea reference, an assignee type of `user` or
`agent`, an assignee reference, and — for an `agent` assignee — an optional AgentInstance
reference that pins the assignment (`assigneeType = "agent_instance"`). Assignment SHALL be
permitted regardless of the Idea's current lifecycle stage or existing assignee, and SHALL
silently take over an existing assignment so that exactly one responsible assignee remains.
The tool SHALL NOT introduce any new status transition: an `open` Idea becomes `elaborating`,
and any other status is preserved. A target `agent` (or the agent owning a pinned instance)
MUST satisfy the existing agent-eligibility rule (`idea:write`); a target `user` MUST belong to
the same company. An `assigned` Activity SHALL be recorded with the calling agent as actor.

#### Scenario: Admin agent assigns an open child idea to another agent

- **WHEN** an agent holding `idea:admin` calls `chorus_pm_assign_idea` for an `open` Idea with
  `assigneeType = "agent"` and a target agent that holds `idea:write`
- **THEN** the Idea assignee becomes that agent and its status becomes `elaborating`
- **AND** an `assigned` Activity is recorded with the calling agent as actor
- **AND** the assigned agent is woken through the existing idea wake path

#### Scenario: Assigning an elaborated idea backfills the owner without regressing status

- **WHEN** an `elaborated` Idea with no assignee is assigned via the tool
- **THEN** the Idea assignee is set
- **AND** its stored lifecycle status remains `elaborated`

#### Scenario: Non-admin caller is rejected

- **WHEN** an agent that lacks `idea:admin` attempts to call `chorus_pm_assign_idea`
- **THEN** the tool is not available to that agent and no assignment occurs

#### Scenario: Ineligible target agent is rejected

- **WHEN** a caller assigns an Idea to an agent that does not hold `idea:write`
- **THEN** the assignment fails without changing the Idea assignee or lifecycle status

#### Scenario: Assign to a user target

- **WHEN** a caller assigns an Idea with `assigneeType = "user"` and a same-company user
- **THEN** the Idea assignee becomes that user
- **AND** no daemon wake is delivered
- **AND** the user receives an assignment notification through the existing path

#### Scenario: Pinned instance that is offline stays notify-only

- **WHEN** a caller assigns an Idea to an `agent_instance` that currently has no online
  connection
- **THEN** the assignment is persisted
- **AND** the wake is notify-only, consistent with the HARD assignment-pin offline policy

### Requirement: An agent-initiated idea assignment wake identifies the assigner

An agent-initiated Idea assignment wake SHALL identify who initiated the assignment — the
actor type (`user` or `agent`) and a human-readable identity — so the woken agent can
determine whether a human, or which agent, delegated the work. The assignment Activity SHALL
carry the initiating actor (`actorType`/`actorUuid`), and the wake SHALL surface that
identity. The human-initiated path SHALL likewise name the initiating human, without changing
its existing behavior.

#### Scenario: Agent-assigned wake names the assigning agent

- **WHEN** agent A assigns an Idea to agent B and B is woken by the assignment
- **THEN** B's wake context states that the assignment was initiated by agent A

#### Scenario: Human-assigned wake names the human

- **WHEN** a human assigns an Idea to agent B and B is woken by the assignment
- **THEN** B's wake context states that the assignment was initiated by that human

### Requirement: Idea-assignment wake gives stage-correct next-step guidance

An idea-assignment wake SHALL instruct the assigned agent to review the Idea and advance it
from its current lifecycle stage, and SHALL NOT instruct it to claim the Idea. The assignment
has already set the assignee, so a claim would fail — it is rejected for an already-assigned
Idea and hard-fails for an `elaborated` Idea — and "begin elaboration" is wrong-stage guidance
for a backfilled `elaborated` Idea. The guidance SHALL direct the agent to continue elaboration
while the Idea is still `elaborating`, or to author the proposal once it is `elaborated`,
stopping at the human proposal / verify gates and never merging automatically.

#### Scenario: Assigned agent is told to advance, not claim

- **WHEN** an agent is woken by an Idea assignment
- **THEN** the wake tells it to review the Idea and advance from its current stage
- **AND** the wake does not instruct it to call `chorus_claim_idea`

#### Scenario: Elaborated backfill does not instruct a claim

- **WHEN** an `elaborated` Idea is assigned and wakes the agent
- **THEN** the guidance does not instruct `chorus_claim_idea` (which would hard-fail on an
  elaborated Idea)
- **AND** it directs the agent toward the proposal stage

