## Why

Moving an Idea to another project fails with `403 "Assignee does not have access to this project"` even when both projects are public. The reported case: in the web UI Move dialog, moving MCS 1.4.0 Ideas into the newly created MCS Backlogs project, both public and in the same group.

The root cause is a **dangling assignee**: an agent was deleted, but its uuid is still stored as the assignee.

- `DELETE /api/agents/[uuid]` and the settings "delete API key" action (`deleteAgent`) only delete the Agent row. Polymorphic `assigneeType`/`assigneeUuid` columns have no relation to the agent, so Task and Idea rows keep the deleted agent's uuid. Its `AgentInstance` rows cascade-delete, so `agent_instance` pins dangle too.
- The API and UI hide these assignees. `formatAssigneeComplete` returns `null` when the name can't be resolved, so the rows look unassigned.
- `moveIdea` checks every assignee in the cascade. `canActorAccessProject` can't find the deleted agent and returns `false`, which throws `AssigneeAccessError` and rolls back the whole move. Project visibility never comes into play.

On the live instance, all 78 MCS 1.4.0 tasks and all 12 Ideas show `assignee: null`, and their activity stream names a single actor (agent `daee0667-…`) that no longer resolves.

Agent → owner access inheritance (`membershipPrincipal`) already works, and the requester confirmed the strict-inheritance rule. Elaboration also found two gaps:
- A move blocked by a **real** no-access assignee says nothing about who is blocked.
- The MCP `chorus_move_idea` tool skips the caller's own source/target project access check, which the REST route and UI action both enforce.

## What Changes

- **Move tolerates dangling assignees.** When access-checking assignees during a move, a deleted user, deleted agent, or deleted/orphaned agent instance is treated as unassigned and skipped. The row is left unchanged; this change adds no data cleanup and no migration.
- **Blocked moves explain themselves.** The move collects *every* live assignee that lacks Editor access to the target, rather than throwing on the first. It rejects with `AssigneeAccessError` (403) whose `details.blockedAssignees` lists each assignee (type, uuid, name) and the entities they hold (Idea / Task: uuid + title). The move preview (service, REST, UI server action) returns the same `blockedAssignees` list without mutating anything. The Move dialog shows the list and disables Confirm while any assignee is blocked. Agents still inherit their owner's effective access exactly.
- **MCP caller access parity.** `chorus_move_idea` requires the caller to have Editor access on the Idea's project and on the target project, matching REST and UI. A hidden target reads as not found.
- **Agent deletion releases unfinished work.** Deleting an agent, through either path, first releases in one transaction:
  - Tasks assigned to that agent or to its instances in status `assigned` / `in_progress`: back to `open` with the assignee cleared.
  - Ideas assigned to that agent or to its instances whose derived status is not `done`: released, using `releaseIdea` semantics.

  Tasks that are `to_verify` / `done` / `closed`, and done Ideas, keep their assignee for history; the move check now skips them.
- **No data backfill** of existing dangling rows. The requester decided the move fix is enough.

## Capabilities

### New Capabilities
- `agent-deletion-assignment-release`: what happens to an agent's Idea and Task assignments when the agent is deleted.

### Modified Capabilities
- `idea-cross-project-move`: adds the assignee access-check contract (dangling assignees skipped, blocked assignees reported with details, also in the preview). Replaces the stale MCP authorization requirement with caller Editor access on source and target.

## Impact

- `src/services/idea.service.ts`: `moveIdea`, `moveIdeaPreview`, `assertAssigneesCanAccess`, plus a new blocked-assignee collector.
- `src/services/task.service.ts`: `assertAssigneeProjectAccess` / `AssigneeAccessError`, which gains structured details. Assignment paths (claim/assign) keep rejecting a non-existent assignee.
- `src/services/agent.service.ts` `deleteAgent`, and `src/app/api/agents/[uuid]/route.ts` DELETE, which routes through the service.
- `src/mcp/tools/pm.ts` `chorus_move_idea`.
- `src/app/api/ideas/[uuid]/move/preview/route.ts`, `src/app/(dashboard)/projects/[uuid]/dashboard/panels/actions.ts`, `move-idea-dialog.tsx`, and `messages/en.json` + `messages/zh.json`.
- Docs: `docs/MCP_TOOLS.md` (chorus_move_idea access note).
- No schema change and no migration.
