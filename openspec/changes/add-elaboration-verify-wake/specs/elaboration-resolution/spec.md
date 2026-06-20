# elaboration-resolution Specification

## ADDED Requirements

### Requirement: A human-callable resolution path SHALL exist alongside the admin-gated MCP tool

The system SHALL provide a human-callable elaboration resolution path that is additive to — and does NOT replace — the existing `chorus_pm_validate_elaboration` MCP tool. The human path SHALL be a Next.js server action gated on the caller's auth type being `user` (or `super_admin`) and SHALL scope the Idea by the caller's `companyUuid`. Unlike the agent-only tool, the human path SHALL NOT require the caller to be the Idea's assignee and SHALL NOT require any agent permission bit. It SHALL enforce the same structural preconditions as the agent path (the Idea has at least one round and no round is in `pending_answers`) and SHALL perform the same state transition (`status → elaborated`, `elaborationStatus → resolved`). The human path SHALL log an `elaboration_verified` activity (distinct from the agent path's `elaboration_resolved`).

#### Scenario: Human path resolves without admin permission or assignee identity

- **GIVEN** an Idea in `elaborating` status with every round answered, assigned to a daemon agent
- **WHEN** an authenticated human user (not the assignee, holding no agent permission) invokes the human resolution path within the same company
- **THEN** the Idea `status` MUST become `elaborated`
- **AND** the Idea `elaborationStatus` MUST become `resolved`
- **AND** an `elaboration_verified` activity MUST be logged

#### Scenario: The admin-gated MCP tool is unchanged

- **WHEN** an agent holding `idea:admin` calls `chorus_pm_validate_elaboration` on its assigned Idea with every round answered
- **THEN** the Idea status becomes `elaborated`
- **AND** the Idea `elaborationStatus` becomes `resolved`
- **AND** an `elaboration_resolved` activity is logged
- **AND** the agent-only assignee + `idea:admin` requirement of that tool is unchanged by the addition of the human path

#### Scenario: Human path enforces the all-rounds-answered precondition

- **WHEN** the human resolution path is invoked on an Idea that has at least one round still in `pending_answers`
- **THEN** the call MUST fail without changing the Idea status
- **AND** the failure MUST indicate some round(s) still have unanswered questions
