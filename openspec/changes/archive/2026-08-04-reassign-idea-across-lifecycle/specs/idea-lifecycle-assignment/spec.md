## ADDED Requirements

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
