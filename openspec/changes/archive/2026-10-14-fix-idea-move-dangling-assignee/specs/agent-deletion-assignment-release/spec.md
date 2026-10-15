## ADDED Requirements

### Requirement: Deleting an agent SHALL release its unfinished assignments atomically

Every agent deletion path MUST run through one company-scoped service function. That includes the REST `DELETE /api/agents/[uuid]` and the settings "delete API key" action. In a single transaction, the function MUST release the agent's unfinished assignments and then delete the agent. The scope MUST cover assignments to the agent (`assigneeType="agent"`) and to any of its AgentInstances (`assigneeType="agent_instance"`). Instance uuids MUST be resolved before the cascade removes them.

- Tasks in status `assigned` or `in_progress` MUST become `open`, with `assigneeType`, `assigneeUuid`, `assignedAt`, `assignedByType` and `assignedByUuid` cleared.
- Ideas whose derived status is not `done` MUST be released with the same field changes as `releaseIdea`.
- Tasks in `to_verify`, `done` or `closed`, and Ideas whose derived status is `done`, MUST keep their assignee for history.
- Each released entity MUST get a `released` activity attributed to the deleting user.
- Rows in other companies MUST NOT be touched.

#### Scenario: In-progress task returns to open

- **GIVEN** agent A holds task T1 (`in_progress`) and task T2 (`done`)
- **WHEN** a user deletes A
- **THEN** T1 MUST be `open` with no assignee
- **AND** T2 MUST be `done` and still reference A

#### Scenario: Instance-pinned elaborating Idea is released

- **GIVEN** Idea I in `elaborating`, assigned to `agent_instance` X belonging to agent A
- **WHEN** A is deleted
- **THEN** I MUST be `open` with no assignee and cleared elaboration fields

#### Scenario: Deletion failure leaves assignments intact

- **GIVEN** agent A holds an `assigned` task
- **WHEN** the agent delete fails inside the transaction
- **THEN** the task MUST still be `assigned` to A
