## ADDED Requirements

### Requirement: Task-creating MCP tools SHALL require non-empty acceptance criteria

The MCP tools that create tasks or task drafts (`chorus_pm_add_task_draft` and `chorus_create_tasks`) MUST reject any request whose acceptance criteria are missing, an empty array, or contain no item with a non-blank `description` (after trimming). The rejection MUST be an explicit error; these tools MUST NOT silently create a task or draft with zero acceptance criteria. An acceptance-criteria set is considered satisfied when at least one provided item has a `description` that is non-empty after trimming whitespace.

#### Scenario: Adding a task draft without acceptance criteria is rejected

- **GIVEN** a proposal in `draft` status
- **WHEN** an agent calls `chorus_pm_add_task_draft` omitting `acceptanceCriteriaItems` (or passing `[]`)
- **THEN** the call MUST return an error indicating acceptance criteria are required
- **AND** no task draft MUST be appended to the proposal's `taskDrafts`

#### Scenario: Adding a task draft whose criteria are all blank is rejected

- **GIVEN** a proposal in `draft` status
- **WHEN** an agent calls `chorus_pm_add_task_draft` with `acceptanceCriteriaItems` whose every `description` is empty or whitespace-only
- **THEN** the call MUST return an error indicating acceptance criteria are required
- **AND** no task draft MUST be appended to the proposal's `taskDrafts`

#### Scenario: Adding a task draft with at least one non-blank criterion succeeds

- **GIVEN** a proposal in `draft` status
- **WHEN** an agent calls `chorus_pm_add_task_draft` with `acceptanceCriteriaItems` containing at least one item with a non-blank `description`
- **THEN** the call MUST succeed
- **AND** the appended task draft MUST persist the non-blank acceptance criteria items

#### Scenario: Creating a task without acceptance criteria is rejected

- **WHEN** an agent calls `chorus_create_tasks` with a task entry that omits `acceptanceCriteriaItems`, passes `[]`, or provides only blank descriptions
- **THEN** the call MUST return an error indicating acceptance criteria are required for that task
- **AND** no task in the batch MUST be created (the request is rejected before any task is persisted)

#### Scenario: Creating tasks with non-blank criteria succeeds

- **WHEN** an agent calls `chorus_create_tasks` where every task entry has at least one non-blank acceptance criterion
- **THEN** the call MUST succeed
- **AND** each created task MUST have its acceptance criteria persisted as `AcceptanceCriterion` rows

### Requirement: Task-editing MCP tools SHALL preserve the non-empty acceptance-criteria invariant

The MCP tools that edit tasks or task drafts (`chorus_pm_update_task_draft` and `chorus_update_task`) MUST follow partial-update semantics for acceptance criteria. When the caller provides `acceptanceCriteriaItems`, it MUST contain at least one item with a non-blank `description`; an empty array or all-blank items MUST be rejected (the field cannot be used to clear acceptance criteria). When the caller omits `acceptanceCriteriaItems`, the existing acceptance criteria MUST be preserved unchanged, and the call MUST NOT be rejected for lack of acceptance criteria. This keeps status transitions and dependency edits via `chorus_update_task` working without resending acceptance criteria.

`chorus_update_task` MUST accept an optional `acceptanceCriteriaItems` parameter with replace semantics: when provided and non-empty, it replaces the task's acceptance-criteria rows with the new set.

#### Scenario: Updating a task draft with an empty criteria array is rejected

- **GIVEN** a proposal in `draft` status containing a task draft with acceptance criteria
- **WHEN** an agent calls `chorus_pm_update_task_draft` passing `acceptanceCriteriaItems: []` (or only blank descriptions)
- **THEN** the call MUST return an error indicating acceptance criteria cannot be cleared
- **AND** the task draft's existing acceptance criteria MUST be unchanged

#### Scenario: Updating a task draft without touching criteria preserves them

- **GIVEN** a proposal in `draft` status containing a task draft with acceptance criteria
- **WHEN** an agent calls `chorus_pm_update_task_draft` changing only the title and omitting `acceptanceCriteriaItems`
- **THEN** the call MUST succeed
- **AND** the task draft's acceptance criteria MUST be preserved unchanged

#### Scenario: Updating a task draft with new non-blank criteria replaces them

- **GIVEN** a proposal in `draft` status containing a task draft with acceptance criteria
- **WHEN** an agent calls `chorus_pm_update_task_draft` with `acceptanceCriteriaItems` containing at least one non-blank item
- **THEN** the call MUST succeed
- **AND** the task draft's acceptance criteria MUST be replaced with the provided non-blank items

#### Scenario: Changing task status without criteria is not blocked

- **GIVEN** an existing task assigned to the caller that already has acceptance criteria
- **WHEN** the caller calls `chorus_update_task` with `status: "in_progress"` and no `acceptanceCriteriaItems`
- **THEN** the call MUST succeed (subject to the existing dependency-resolution checks)
- **AND** the task's acceptance criteria MUST be preserved unchanged

#### Scenario: Editing task acceptance criteria with an empty array is rejected

- **GIVEN** an existing task that has acceptance criteria
- **WHEN** an agent calls `chorus_update_task` passing `acceptanceCriteriaItems: []` (or only blank descriptions)
- **THEN** the call MUST return an error indicating acceptance criteria cannot be cleared
- **AND** the task's existing acceptance-criteria rows MUST be unchanged

#### Scenario: Editing task acceptance criteria with new non-blank items replaces them

- **GIVEN** an existing task that has acceptance criteria
- **WHEN** an agent calls `chorus_update_task` with `acceptanceCriteriaItems` containing at least one non-blank item
- **THEN** the call MUST succeed
- **AND** the task's `AcceptanceCriterion` rows MUST be replaced with the provided non-blank items
