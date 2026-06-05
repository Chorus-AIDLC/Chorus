# elaboration-resolution

## ADDED Requirements

### Requirement: Dedicated admin-gated resolution action

The system SHALL provide a `chorus_pm_validate_elaboration` MCP tool that marks an Idea's whole elaboration complete. This tool SHALL require the `idea:admin` permission. It SHALL be an Idea-level action that accepts only `ideaUuid` — it does not target a single round and does not modify any round's status.

#### Scenario: Resolve elaboration with admin permission

- **WHEN** an agent holding `idea:admin` calls `chorus_pm_validate_elaboration` on its assigned Idea, where every round is answered
- **THEN** the Idea status becomes `elaborated`
- **AND** the Idea `elaborationStatus` becomes `resolved`
- **AND** round statuses are left unchanged
- **AND** an `elaboration_resolved` activity is logged

#### Scenario: Resolution rejected without admin permission

- **WHEN** an agent that holds `idea:write` but not `idea:admin` calls `chorus_pm_validate_elaboration`
- **THEN** the call is rejected because the tool requires `idea:admin`

#### Scenario: Resolution requires every round answered

- **WHEN** `chorus_pm_validate_elaboration` is called on an Idea that has at least one round still in `pending_answers`
- **THEN** the call fails with an error indicating some round(s) still have unanswered questions

#### Scenario: Resolution requires at least one round

- **WHEN** `chorus_pm_validate_elaboration` is called on an Idea that has no elaboration rounds
- **THEN** the call fails with an error indicating there are no elaboration rounds to resolve

### Requirement: Human confirmation is required before resolving

The `chorus_pm_validate_elaboration` tool description and every Chorus skill that invokes it (idea, yolo, brainstorm) SHALL state that human confirmation is required before calling it, except in YOLO mode where the agent may resolve autonomously.

#### Scenario: Tool description states the confirmation requirement

- **WHEN** a client inspects the `chorus_pm_validate_elaboration` tool description
- **THEN** the description states that human confirmation is required before calling it (except in YOLO mode)

#### Scenario: Skill docs carry the confirmation note

- **WHEN** the idea, yolo, and brainstorm skill documents reference resolution
- **THEN** each instructs the agent to obtain human confirmation before resolving, except under YOLO automation

### Requirement: Validate performs only resolution

The `chorus_pm_validate_elaboration` tool SHALL perform only the resolution action. It SHALL NOT tag per-question issues and SHALL NOT create follow-up rounds. Opening a follow-up round SHALL be achieved by calling `chorus_pm_start_elaboration` again.

#### Scenario: Validate tool only resolves

- **WHEN** an agent holding `idea:admin` calls `chorus_pm_validate_elaboration`
- **THEN** the tool marks the elaboration complete and accepts only `ideaUuid`
- **AND** opening a follow-up round is achieved by calling `chorus_pm_start_elaboration` again
