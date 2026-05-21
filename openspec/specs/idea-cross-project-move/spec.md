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

The MCP tool `chorus_move_idea` MUST be gated by exactly the `idea:write` permission in `src/mcp/tools/permission-map.ts`. The handler MUST NOT additionally check `project:write` on either the source or target Project.

The REST endpoint `POST /api/ideas/[uuid]/move` and the corresponding UI button MUST NOT introduce any cross-Project authorization checks beyond the existing "user is authenticated and belongs to the same company" guard.

#### Scenario: Agent with only idea:write can move an idea between projects it has no project:write on

- **GIVEN** an Agent with permissions `idea:[read,write]` only (no `project:*`)
- **WHEN** the agent calls `chorus_move_idea` with a target Project where it has no project-level permission
- **THEN** the call MUST succeed and perform the cascade migration

