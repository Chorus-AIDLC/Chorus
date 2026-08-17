## MODIFIED Requirements

### Requirement: Dedicated admin-gated resolution action

The system SHALL provide a `chorus_pm_validate_elaboration` MCP tool that marks an Idea's whole elaboration complete. This tool SHALL require the `idea:admin` permission. It SHALL be an Idea-level action that accepts only `ideaUuid` — it does not target a single round and does not modify any round's status. The caller MAY be the Idea's assignee OR a non-assignee acting as an `idea:admin` gateway, mirroring the human UI Verify-Elaborate handoff. When the caller is the assignee, the tool SHALL log an `elaboration_resolved` activity and SHALL NOT wake any agent. When the caller is a non-assignee `idea:admin` gateway, the tool SHALL log an `elaboration_verified` activity so that the Idea's assigned agent (not the gateway) is woken to write the proposal, and the resolution SHALL succeed even when that assignee agent is offline (the wake is queued and recovered on reconnect).

#### Scenario: Assignee resolves elaboration

- **WHEN** the Idea's assignee, holding `idea:admin`, calls `chorus_pm_validate_elaboration` on its assigned Idea where every round is answered
- **THEN** the Idea status becomes `elaborated`
- **AND** the Idea `elaborationStatus` becomes `resolved`
- **AND** round statuses are left unchanged
- **AND** an `elaboration_resolved` activity is logged
- **AND** no agent is woken to write the proposal

#### Scenario: idea:admin gateway resolves another agent's idea

- **WHEN** an agent holding `idea:admin` that is NOT the Idea's assignee calls `chorus_pm_validate_elaboration` on an Idea assigned to another agent, where every round is answered
- **THEN** the Idea status becomes `elaborated` and `elaborationStatus` becomes `resolved`
- **AND** an `elaboration_verified` activity is logged
- **AND** the Idea's assigned agent, not the gateway, is the recipient woken to write the proposal

#### Scenario: Gateway resolve succeeds when the assignee is offline

- **WHEN** a non-assignee `idea:admin` gateway resolves an Idea whose assigned agent has no online daemon connection
- **THEN** the resolution still succeeds (status `elaborated`, `elaborationStatus` `resolved`)
- **AND** the `elaboration_verified` wake is queued for the assignee and recovered on reconnect

#### Scenario: Resolution rejected without admin permission

- **WHEN** an agent that holds `idea:write` but not `idea:admin` calls `chorus_pm_validate_elaboration`
- **THEN** the call is rejected because the tool requires `idea:admin`

#### Scenario: Resolution requires every round answered

- **WHEN** `chorus_pm_validate_elaboration` is called on an Idea that has at least one round still in `pending_answers`
- **THEN** the call fails with an error indicating some round(s) still have unanswered questions

#### Scenario: Resolution requires at least one round

- **WHEN** `chorus_pm_validate_elaboration` is called on an Idea that has no elaboration rounds
- **THEN** the call fails with an error indicating there are no elaboration rounds to resolve

## ADDED Requirements

### Requirement: Gateway skip of elaboration

An `idea:admin` gateway that is NOT the Idea's assignee SHALL be able to skip elaboration for an Idea assigned to another agent via `chorus_pm_skip_elaboration`, waking the assignee to write the proposal — mirroring the gateway resolve path. The tool SHALL remain callable by the Idea's assignee with the `idea:write` permission (no regression); a non-assignee caller SHALL be rejected unless it holds `idea:admin`. Skipping SHALL still require the Idea to be in `elaborating` status and SHALL NOT require any elaboration round to exist. When the caller is the assignee, the tool SHALL log an `elaboration_skipped` activity and SHALL NOT wake any agent. When the caller is a non-assignee `idea:admin` gateway, the tool SHALL log an `elaboration_verified` activity carrying the skip reason so that the Idea's assigned agent (not the gateway) is woken to write the proposal, and the skip SHALL succeed even when the assignee agent is offline.

#### Scenario: Assignee skips its own elaboration

- **WHEN** the Idea's assignee calls `chorus_pm_skip_elaboration` on its assigned Idea in `elaborating` status
- **THEN** the Idea becomes `elaborated` / `resolved` with `elaborationDepth` `minimal`
- **AND** an `elaboration_skipped` activity is logged
- **AND** no agent is woken

#### Scenario: idea:admin gateway skips another agent's idea

- **WHEN** an agent holding `idea:admin` that is NOT the assignee calls `chorus_pm_skip_elaboration` on an Idea assigned to another agent in `elaborating` status
- **THEN** the Idea becomes `elaborated` / `resolved`
- **AND** an `elaboration_verified` activity carrying the skip reason is logged
- **AND** the Idea's assigned agent, not the gateway, is woken to write the proposal

#### Scenario: Non-assignee without admin cannot skip

- **WHEN** an agent that is neither the assignee nor a holder of `idea:admin` calls `chorus_pm_skip_elaboration`
- **THEN** the call is rejected

#### Scenario: Gateway skip succeeds when the assignee is offline

- **WHEN** a non-assignee `idea:admin` gateway skips an Idea whose assigned agent has no online daemon connection
- **THEN** the skip still succeeds
- **AND** the `elaboration_verified` wake is queued for the assignee and recovered on reconnect
