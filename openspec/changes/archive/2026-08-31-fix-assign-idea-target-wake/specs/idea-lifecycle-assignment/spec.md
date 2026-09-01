## MODIFIED Requirements

### Requirement: MCP-callable idea assignment (`chorus_pm_assign_idea`)

The system SHALL provide an MCP tool `chorus_pm_assign_idea` that assigns an Idea to a
specified assignee, reusing the same assignment policy, service primitive, activity path, and
wake pipeline as the existing UI assignment control. The tool SHALL be gated on the
`idea:admin` permission. It SHALL accept an Idea reference, an assignee type of `user` or
`agent`, an assignee reference, and — for an `agent` assignee — an optional AgentInstance
reference that pins the assignment (`assigneeType = "agent_instance"`). For an agent target,
the tool MUST resolve the owner user's project cwd target before assignment and MUST use a
project-fixed AgentInstance and cwd provenance when configured, matching the UI assignment
precedence over an explicitly supplied instance. Assignment SHALL be permitted regardless of
the Idea's current lifecycle stage or existing assignee, and SHALL silently take over an
existing assignment so that exactly one responsible assignee remains. A successful agent
assignment MUST emit an `assigned` Activity and request a wake when the logical assignee is
new or changes to a different agent. When the Idea already belongs to that same logical agent
(either directly or through one of its AgentInstances), the tool MUST persist any effective
instance pin or cwd update but MUST NOT emit another `assigned` Activity or request a duplicate
wake. The tool SHALL NOT introduce any new status transition: an `open` Idea becomes
`elaborating`, and any other status is preserved. A target `agent` (or the agent owning a
pinned instance) MUST satisfy the existing agent-eligibility rule (`idea:write`); a target
`user` MUST belong to the same company. An emitted `assigned` Activity SHALL be recorded with
the calling agent as actor.

#### Scenario: Admin agent assigns an open child idea to another agent

- **WHEN** an agent holding `idea:admin` calls `chorus_pm_assign_idea` for an `open` Idea with
  `assigneeType = "agent"` and a target agent that holds `idea:write`
- **THEN** the Idea assignee becomes that agent and its status becomes `elaborating`
- **AND** an `assigned` Activity is recorded with the calling agent as actor
- **AND** the assigned agent is woken through the existing idea wake path

#### Scenario: Project-fixed target is pinned before wake

- **WHEN** the calling agent owner's project preference fixes the target agent to a cwd
- **AND** the caller invokes `chorus_pm_assign_idea` without `instanceUuid`
- **THEN** the Idea is persisted as an `agent_instance` assignment with the resolved cwd
  provenance before the `assigned` Activity is emitted
- **AND** the wake targets that resolved instance

#### Scenario: Reassigning the same agent to a new instance is wake-deduplicated

- **WHEN** an Idea is already assigned to an agent
- **AND** `chorus_pm_assign_idea` successfully assigns that same agent with a new effective
  instance pin or cwd target
- **THEN** the updated assignment is persisted
- **AND** no new `assigned` Activity is emitted
- **AND** no duplicate daemon wake is requested

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
