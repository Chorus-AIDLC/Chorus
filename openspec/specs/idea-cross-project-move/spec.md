# idea-cross-project-move Specification

## Purpose

Defines the contract for moving an Idea from one Project to another within the same company. Specifies which downstream entities (Proposals, Documents, Tasks, Activity rows) cascade with the Idea and which (Comments, dependencies, sessions, Notifications, assignees) deliberately stay attached via existing foreign keys. Also fixes the migration counts, preview semantics, and authorization model that REST, MCP, and the UI all share.

## Requirements

### Requirement: Cross-project Idea move SHALL cascade-migrate the full AI-DLC pipeline tail in a single transaction

When a caller invokes `chorus_move_idea` (MCP) or `POST /api/ideas/[uuid]/move` (REST) for an Idea inside the same company, the service layer MUST update the `projectUuid` of the Idea itself **and** every entity that the Idea has produced through the AI-DLC pipeline, atomically inside one Prisma `$transaction`.

The migration set is defined as:

- The Idea row.
- All `Proposal` rows where `inputType = "idea"` and `inputUuids` contains the moved Idea's UUID, **regardless of `status`** (the where clause MUST NOT filter on `status` so any status value present or future — currently `draft|pending|approved|rejected|revised` per the schema enum — is included).
- All `Document` rows whose `proposalUuid` is in the migrated proposal set.
- All `Task` rows whose `proposalUuid` is in the migrated proposal set.
- All `Activity` rows whose `(targetType, targetUuid)` matches any of: the Idea, a migrated Proposal, a migrated Document, or a migrated Task.

The service MUST NOT modify:

- `Comment` rows (they have no `projectUuid` field; relation by `targetType + targetUuid` already follows the moved entity).
- `TaskDependency`, `AcceptanceCriterion`, `SessionTaskCheckin` rows (they have no `projectUuid`; foreign keys already follow the migrated Task).
- `AgentSession` rows (no `projectUuid`; cross-project session references are valid by design).
- `Notification` rows (notifications are event snapshots; routing by entity UUID already works after the move).
- Task `assigneeType` / `assigneeUuid` fields — assignments are preserved as-is.

The service MUST NOT perform same-name conflict detection on Document or Task: titles are not constrained to be unique within a project, so duplicate titles after move are a permitted state.

The service MUST scope every `updateMany` and `findMany` by `companyUuid` so that no rows belonging to other companies can be touched.

#### Scenario: Idea with approved proposal materializing tasks and documents is moved

- **GIVEN** an Idea `I` in Project `P_old` (company `C`) with one approved Proposal `R` whose `inputUuids` contains `I.uuid`
- **AND** Proposal `R` materialized one Document `D` (`proposalUuid = R.uuid`) and three Tasks `T1, T2, T3` (`proposalUuid = R.uuid`)
- **AND** five Activity rows exist on the Idea / Proposal / Tasks / Document under `projectUuid = P_old`
- **WHEN** `moveIdea(C, I.uuid, P_new.uuid, ...)` is called
- **THEN** after the transaction commits, `I.projectUuid`, `R.projectUuid`, `D.projectUuid`, `T1.projectUuid`, `T2.projectUuid`, `T3.projectUuid` and all five Activity rows' `projectUuid` MUST equal `P_new.uuid`
- **AND** none of those rows MUST exist with `projectUuid = P_old.uuid`

#### Scenario: Proposals in any non-draft status follow the Idea

- **GIVEN** an Idea `I` with three linked Proposals `R1` (status `approved`), `R2` (status `rejected`), `R3` (status `revised`)
- **WHEN** the Idea is moved to a new Project
- **THEN** `R1`, `R2`, `R3` all MUST have their `projectUuid` updated to the target Project

#### Scenario: Comments and task dependencies are NOT independently rewritten

- **GIVEN** an Idea move that includes Tasks `T1` (depends on `T2`) with `Comment` rows on `T1` and `AcceptanceCriterion` rows on `T2`
- **WHEN** the move completes
- **THEN** the `TaskDependency`, `AcceptanceCriterion`, and `Comment` rows MUST remain unchanged at the row level — the service MUST NOT issue any `update`, `delete`, or `create` against these tables — they continue to reference the moved Tasks via existing foreign keys

#### Scenario: Notifications and AgentSession are NOT modified

- **GIVEN** an Idea move where Tasks have active `SessionTaskCheckin` rows referencing an `AgentSession` and the Idea has historical `Notification` rows
- **WHEN** the move completes
- **THEN** the `AgentSession`, `SessionTaskCheckin`, and `Notification` rows MUST remain byte-equal to their pre-move state — no field updates, no checkout, no projectUuid rewrite

#### Scenario: Cross-company isolation is preserved

- **GIVEN** company `C_a` has Idea `I_a` and company `C_b` has a Proposal `R_b` whose `inputUuids` happens to contain `I_a.uuid` (impossible by domain rules but defensive)
- **WHEN** `moveIdea(C_a, I_a.uuid, ...)` is called
- **THEN** Proposal `R_b` MUST NOT be touched — every `updateMany` issued by the service MUST carry `companyUuid = C_a`

### Requirement: `moveIdea` SHALL return migration counts

The `moveIdea(companyUuid, ideaUuid, targetProjectUuid, ...)` service function MUST return, in addition to the current `IdeaResponse`, a `moved` field with the count of rows updated for each cascaded entity:

```ts
{
  ...ideaResponse,
  moved: {
    proposals: number,
    documents: number,
    tasks: number,
    activities: number,
  }
}
```

The REST route `POST /api/ideas/[uuid]/move` MUST include this `moved` object in its response payload.

The MCP tool `chorus_move_idea` MUST include this `moved` object (alongside the moved Idea) in its returned text content.

#### Scenario: Move returns accurate counts

- **GIVEN** an Idea move that ends up updating 1 Idea row, 2 Proposals, 1 Document, 3 Tasks, and 7 Activities
- **WHEN** the caller invokes either the MCP tool or the REST endpoint
- **THEN** the response MUST contain `moved: { proposals: 2, documents: 1, tasks: 3, activities: 7 }` — counts MUST equal the actual `count` returned from each Prisma `updateMany`

### Requirement: A preview endpoint SHALL expose the cascade scope before the move

The system MUST provide a non-mutating preview path that, given an Idea UUID and a target Project UUID, returns the same `moved` shape (proposal/document/task/activity counts) that the actual move would produce, without modifying any rows.

This is exposed as REST `GET /api/ideas/[uuid]/move/preview?targetProjectUuid=<uuid>`. The MCP surface does NOT expose preview as a separate tool — agents call the real move and inspect the returned counts.

#### Scenario: Preview matches actual move counts when no concurrent writes occur

- **GIVEN** an Idea state with N proposals, M documents, K tasks, L activities matching the move criteria
- **WHEN** the UI calls the preview endpoint and immediately afterwards triggers the real move with no intervening writes
- **THEN** the preview response and the move response MUST report identical `{ proposals, documents, tasks, activities }` counts

### Requirement: Authorization for moveIdea SHALL be `idea:write` on the MCP path; REST and UI inherit existing idea-edit gating

The MCP tool `chorus_move_idea` MUST be gated by exactly the `idea:write` permission in `src/mcp/tools/permission-map.ts`. The handler MUST NOT additionally require any `project:*` permission bit.

The REST endpoint, the UI server action and the MCP tool MUST all require the caller to have project access level Editor or higher on the Idea's current project and on the target project. An agent caller's level is its owner's effective level. A target the caller cannot see MUST be reported as "Target project not found", indistinguishable from a missing project.

#### Scenario: Agent with only idea:write can move an idea between projects it has no project:write on

- **GIVEN** an Agent with permissions `idea:[read,write]` only (no `project:*`), whose owner is an Editor on both the source and target projects
- **WHEN** the agent calls `chorus_move_idea`
- **THEN** the call MUST succeed and perform the cascade migration

#### Scenario: MCP move into a private project the caller cannot see is rejected as not found

- **GIVEN** an Agent whose owner has no access to private project P
- **WHEN** the agent calls `chorus_move_idea` with `targetProjectUuid = P`
- **THEN** the tool MUST return an error stating the target project was not found
- **AND** nothing MUST be migrated

#### Scenario: MCP move of an Idea the caller can only view is rejected

- **GIVEN** an Agent whose owner is only a Viewer on the Idea's private project
- **WHEN** the agent calls `chorus_move_idea`
- **THEN** the tool MUST return an access error and nothing MUST be migrated

### Requirement: Move SHALL access-check only live assignees and skip dangling ones

Before migrating anything, `moveIdea` MUST collect every distinct assignee in the cascade: the moved root Idea, its descendant Ideas, and every Task under the moved Proposals. For each one, it MUST resolve whether the assignee still exists in the company:
- `user`: a `User` row exists.
- `agent`: an `Agent` row exists.
- `agent_instance`: an `AgentInstance` row and its `Agent` row both exist.

An assignee that does not resolve (a dangling assignee, e.g. a deleted agent) MUST be treated as unassigned for the access check and MUST NOT block the move. The move MUST NOT modify the row's assignee fields.

A live agent or agent-instance assignee MUST be evaluated with its owner's effective project access (local, group, or implicit Admin), unchanged from the existing inheritance rule. Assignment paths outside the move (claim, assign) MUST keep rejecting a non-existent assignee.

#### Scenario: Tasks assigned to a deleted agent do not block the move

- **GIVEN** an Idea whose approved Proposal has tasks still assigned (`assigneeType="agent"`) to an agent that has since been deleted
- **AND** the target project is public
- **WHEN** a user with Editor access on both projects moves the Idea
- **THEN** the move MUST succeed and cascade the tasks
- **AND** the tasks' `assigneeType`/`assigneeUuid` MUST be unchanged

#### Scenario: The moved Idea itself assigned to a deleted agent does not block the move

- **GIVEN** the root Idea being moved is itself assigned (`assigneeType="agent"`) to a deleted agent
- **WHEN** a user with Editor access on both projects moves it
- **THEN** the move MUST succeed and the root Idea's assignee fields MUST be unchanged

#### Scenario: An Idea pinned to a deleted agent instance does not block the move

- **GIVEN** a descendant Idea assigned to an `agent_instance` whose `AgentInstance` row no longer exists
- **WHEN** the root Idea is moved
- **THEN** the move MUST succeed

#### Scenario: An agent inherits its owner's access

- **GIVEN** a private target project where user U is an Editor, and a task assigned to agent A owned by U
- **WHEN** the Idea is moved to that target
- **THEN** A MUST pass the assignee access check

### Requirement: A move blocked by assignees SHALL report every blocked assignee and their entities

When one or more live assignees lack Editor access to the target project, `moveIdea` MUST reject the whole move (no partial migration) with `AssigneeAccessError` (HTTP 403). The message MUST begin with `Assignee does not have access to this project`. The error's `details.blockedAssignees` MUST list every blocked assignee once, as `{ assigneeType, assigneeUuid, name, entities: [{ type: "idea"|"task", uuid, title }] }`. REST MUST return this under `error.details`, the UI server action MUST return it to the dialog, and the MCP tool MUST include the assignee names in its error text.

#### Scenario: Two blocked assignees are both reported

- **GIVEN** a cascade where agent B (owner has no access to private target T) holds 2 tasks, and user L (not a member of T) holds 1 descendant Idea
- **WHEN** the Idea is moved to T
- **THEN** the response MUST be 403 with `details.blockedAssignees` containing B (2 task entities) and L (1 idea entity)
- **AND** no Idea, Proposal, Document, Task or Activity row MUST have changed project

### Requirement: The move preview SHALL report blocked assignees

The preview (`moveIdeaPreview`, `GET /api/ideas/[uuid]/move/preview`, and `moveIdeaPreviewAction`) MUST return `blockedAssignees` with the same shape and the same skip-dangling rule as the move, without mutating anything. The Move dialog MUST list the blocked assignees and their entities with localized (en/zh) text, and MUST disable Confirm while the list is non-empty.

#### Scenario: Preview warns before confirm

- **GIVEN** a cascade with one blocked assignee
- **WHEN** the user opens the Move dialog and selects the target
- **THEN** the preview MUST return that assignee in `blockedAssignees`
- **AND** the dialog MUST show it and disable Confirm

#### Scenario: Preview ignores dangling assignees

- **GIVEN** a cascade whose only assignees are deleted agents
- **WHEN** the preview runs
- **THEN** `blockedAssignees` MUST be empty
