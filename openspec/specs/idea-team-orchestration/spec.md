# idea-team-orchestration Specification

## Purpose
Provide owner-private Team orchestration for explicitly assigned Ideas: preserve lead ownership while delegating product/development work, enforce per-Idea human/lead gates, and pause safely when the Team or lead becomes invalid.

## Requirements

### Requirement: Explicit owner enrollment and durable pause
The system SHALL enroll only explicitly assigned eligible leads into their personal project Team and SHALL preserve a durable guard when automation becomes invalid.

#### Scenario: Creation without owner
- **WHEN** an Idea is created without assignee in a Team-configured project
- **THEN** it remains unassigned and no Team agent is automatically claimed or woken

#### Scenario: Eligible lead assignment
- **WHEN** an authorized actor explicitly assigns an eligible lead, including confirmed handoff
- **THEN** the Idea records personal Team owner and logical lead, keeps existing stage and executes the existing assignment wake

#### Scenario: Lead removal or unbinding
- **WHEN** an enrolled lead becomes ineligible, ceases to be current owner or its Team is unbound
- **THEN** enrollment remains paused, agent gates fail closed, running tasks are not interrupted and human repair is available

### Requirement: Delegated product collaboration
The system SHALL let the current active lead explicitly delegate product work without replacing the Idea assignee, while preserving existing permissions.

#### Scenario: Product handoff
- **WHEN** the lead delegates an eligible product member
- **THEN** a directed wake instruction is recorded and that member can elaborate and author/submit the Idea's proposal without claiming the Idea

#### Scenario: Ineligible or unrelated delegate
- **WHEN** a delegate loses role eligibility or a different actor attempts product work
- **THEN** delegated access is denied and no lead ownership changes

### Requirement: Private deterministic recommendations
Recommendations SHALL be owner-private, permission-scoped and explain their selection or lack of selection.

#### Scenario: Reopen affinity
- **WHEN** a reopened task's original developer is online and eligible
- **THEN** that developer is preferred over other online developers regardless of load

#### Scenario: Load and dependency tie
- **WHEN** other development tasks have multiple eligible online candidates
- **THEN** minimum activeCount wins, dependency-chain affinity breaks only load ties, and an unresolved tie is returned for the lead's decision

#### Scenario: Empty versus offline
- **WHEN** a role is empty or wholly ineligible
- **THEN** the result is manual rather than substituting the lead
- **WHEN** eligible role members exist but all are offline
- **THEN** eligible online lead fallback is recommended or the result explicitly requires manual handling

#### Scenario: Foreign context
- **WHEN** another user's agent requests private candidates or provides an unrelated task
- **THEN** no private roster is disclosed and the request is denied

### Requirement: Server-enforced per-Idea approval gates
All approval and task completion mutation paths SHALL enforce enrolled Team gates using current identity and human YOLO authority.

#### Scenario: Non-YOLO approval
- **WHEN** an agent attempts proposal approval for a non-YOLO enrolled Idea
- **THEN** the server rejects it even if the agent has proposal:admin

#### Scenario: YOLO lead and task verify
- **WHEN** a current eligible lead with existing action permission approves a human-YOLO-authorized proposal or verifies its task
- **THEN** the mutation is permitted subject to existing lifecycle and acceptance checks
- **WHEN** another agent, missing actor or paused lead attempts the same transition
- **THEN** the mutation is rejected

#### Scenario: Human and legacy compatibility
- **WHEN** an authorized human manages enrolled work or existing unmanaged work follows its old workflow
- **THEN** existing project/permission checks and human management remain in force

#### Scenario: Multiple and document inputs
- **WHEN** a proposal derives from multiple Ideas or source documents
- **THEN** the gates of all reachable source Ideas apply with cycle protection and no managed ancestry bypass

### Requirement: Consistent lead routing and visible gates
Lifecycle notifications, daemon/plugin instructions and UI SHALL agree on current lead ownership and gates without exposing private roster details.

#### Scenario: Product proposal and task lifecycle
- **WHEN** delegated product proposals receive decisions or linked tasks change lifecycle state
- **THEN** the enrolled lead receives a deduplicated notification to coordinate the next step, without introducing independent reviewer wakes

#### Scenario: Gate display and port parity
- **WHEN** users view an Idea or an agent receives a wake
- **THEN** the UI shows current gate/paused reason and all maintained prompt/skill ports instruct the agent to fetch authoritative context, preserve lead ownership and obey server gates
