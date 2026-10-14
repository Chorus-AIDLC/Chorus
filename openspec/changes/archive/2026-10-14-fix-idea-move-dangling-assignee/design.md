## Context

`moveIdea` (`src/services/idea.service.ts`) calls `assertAssigneeProjectAccess` (`src/services/task.service.ts:233`) once per distinct assignee in the cascade:
- the root Idea (before the transaction),
- descendant Ideas (before the transaction),
- Tasks under the moved Proposals (inside the transaction).

`assertAssigneeProjectAccess` maps `agent_instance` to its agent and calls `canActorAccessProject` (`src/services/project-access.service.ts:362`). That call resolves an agent to its owner (`membershipPrincipal`), but returns `false` when the agent row is missing. A missing `AgentInstance` throws directly. Either way the result is `AssigneeAccessError` (403, a fixed message, no details), and the first failure aborts the whole move.

`DELETE /api/agents/[uuid]` (`src/app/api/agents/[uuid]/route.ts:188`) and `deleteAgent` (`src/services/agent.service.ts:167`, called by the settings `deleteApiKeyAction`) only run `prisma.agent.delete`. `relationMode = "prisma"`, and `assigneeUuid` is polymorphic with no relation, so nothing cleans assignments. `AgentInstance` rows cascade-delete with the agent.

`chorus_move_idea` (`src/mcp/tools/pm.ts:1197`) calls `moveIdea` directly. The REST route and the UI `moveIdeaAction` both require Editor on the Idea (`requireEntityAccess` / `denyUnlessEntityAccess`) and on the target (`requireProjectAccess` / `denyUnlessProjectAccess`).

## Goals / Non-Goals

**Goals:**
- A move is never blocked by an assignee that no longer exists.
- When a live assignee lacks access, the user sees who is blocked and where, before confirming (preview) and on confirm (error details).
- MCP move enforces the same caller access as REST and UI.
- Deleting an agent stops creating new dangling assignees on unfinished work.

**Non-Goals:**
- Backfilling or cleaning existing dangling rows. The requester explicitly declined this.
- Changing agent → owner access inheritance, which is already correct and confirmed as the rule.
- Changing claim/assign validation: assigning to a non-existent actor stays an error.
- Moving a project between groups. That path doesn't check assignees.

## Decisions

### D1. A dangling assignee is "unassigned" for the move check only
Add `resolveLiveAssignee(companyUuid, { type, uuid }, client)` in `task.service.ts`. It returns the access actor `{ type: "user"|"agent", uuid }`, or `null` when the assignee is dangling:
- `user`: no `User` row in the company.
- `agent`: no `Agent` row in the company.
- `agent_instance`: no `AgentInstance` row in the company, or the instance's agent row is missing.
- Any unknown `assigneeType` is also treated as dangling.

The move path uses a new collector (D2) that skips `null` results. `assertAssigneeProjectAccess`, which claim and assign use, keeps its current behavior. A missing instance or agent still throws there, because assigning to a ghost is a caller error, not stale data.

*Alternative rejected:* treat a dangling assignee as a pass inside `canActorAccessProject`. That function also gates notifications and wakes, and passing an unknown actor there is a fail-open risk.

### D2. Collect all blocked assignees, then reject once
Add `collectBlockedAssignees(companyUuid, rows, targetProjectUuid, client)`. It returns `BlockedAssignee[]`, deduplicated by `type:uuid`, each with the entities it holds:

```ts
interface BlockedAssignee {
  assigneeType: string;          // as stored: "user" | "agent" | "agent_instance"
  assigneeUuid: string;
  name: string | null;           // resolved display name (agent / user)
  entities: { type: "idea" | "task"; uuid: string; title: string }[];
}
```

Inputs are the moved **root** Idea (today checked on its own path before the transaction, which must be folded into the collector and follow the same skip-dangling rule), descendant Ideas and the cascaded Tasks, each tagged with its entity type, uuid and title. A live assignee is blocked when `canActorAccessProject(…, "editor", client)` is false. Owner inheritance stays exactly as-is.

`moveIdea` gathers the Idea rows before the transaction, then gathers the Task rows inside it using the `tx` client, so the check sees the same snapshot as the cascade. It calls the collector once over the combined list. If the list is non-empty, it throws `new AssigneeAccessError(message, { blockedAssignees })`, and the transaction rolls back as today. The message names the blocked assignees, e.g. `Assignee does not have access to this project: Bob (2 tasks), Leo (1 idea)`. It keeps the existing prefix, so current string matching still works.

`AssigneeAccessError` gains an optional `details` argument, passed through `ApiError.details`, which `withErrorHandler` already serializes as `error.details`.

### D3. Preview reports the same list
`moveIdeaPreview` already resolves the same proposal/task scope for counts. It runs the same collector without a transaction and returns `{ moved, blockedAssignees }`. The REST preview route and `moveIdeaPreviewAction` pass `blockedAssignees` through. The preview is still non-mutating.

`move-idea-dialog.tsx` renders a warning block when `blockedAssignees.length > 0`: each assignee's name, with entity titles and the counts of Ideas and Tasks. It disables Confirm and tells the user to reassign or release those items first. When the confirm path returns an `AssigneeAccessError`, the dialog shows the server's `details.blockedAssignees` the same way. All strings go in `messages/en.json` and `messages/zh.json` under `moveDialog.*`. Only semantic tokens and `dark:` variants are used for the warning colours.

The server action must return `details` for the dialog to read. `moveIdeaAction` currently returns only `e.message`. It will also return `blockedAssignees` when `e` is an `AssigneeAccessError`.

### D4. MCP caller access parity
In `chorus_move_idea`, before calling `moveIdea`:
- `await requireEntityAccess(auth, "idea", ideaUuid, "editor")`
- `await requireProjectAccess(auth, targetProjectUuid, "editor")`

A `ProjectNotFoundError` on the target maps to "Target project not found", so a hidden target looks the same as a missing one, as in the REST route. Errors use the tool's existing `isError` text path. The tool stays gated by `idea:write` only; no `project:*` permission bit is required. For an agent, project access means its owner's effective level.

### D5. Agent deletion releases unfinished work in one transaction
Add `releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx)`, where `actorUuid` is the deleting user, in a new `src/services/agent-assignment-release.service.ts`. This keeps it out of `agent.service.ts`, which stays a thin CRUD module. Change `deleteAgent` to `deleteAgent(companyUuid, agentUuid, actorUuid)`, make it company-scoped, have it call `releaseAgentAssignments` then `agent.delete` inside one `prisma.$transaction`, and switch both delete paths (REST DELETE route and `deleteApiKeyAction`) to it, passing `auth.actorUuid`.

The release scope covers assignees `{type: "agent", uuid: agentUuid}` plus `{type: "agent_instance", uuid ∈ that agent's instance uuids}`, with instance uuids read before the cascade deletes them.
- **Tasks:** those with status `assigned` or `in_progress` are set to `status: "open"`, with `assigneeType`, `assigneeUuid`, `assignedAt`, `assignedByType` and `assignedByUuid` all null. This follows the field set `releaseTask` clears. Tasks in `to_verify`, `done` or `closed` keep their assignee.
- **Ideas:** compute each Idea's derived status with `computeDerivedStatus` (proposal + task context, batched per company). For every Idea whose derived status is not `done`, apply the same field changes as `releaseIdea`: clear the assignee, cwd and assignedBy fields, and reset an `open`/`elaborating` Idea to `open` with its elaboration fields cleared. An `elaborated` Idea keeps its status. Done Ideas keep their assignee.
- Log one `released` activity per released entity, with `actorType: "user"` and the deleting user's uuid, so the timeline explains the change. Session checkins for the agent's sessions are handled by the existing cascade and need no extra handling.

*Alternative rejected:* clearing assignees on everything, including done work. The requester chose to keep history.

## Risks / Trade-offs

- **[More queries per move]** The collector resolves each distinct assignee, one or two lookups each, then runs one access computation per live assignee. Assignees are deduplicated, so a project with 78 tasks typically has one or two distinct assignees. → Acceptable; same order of work as today.
- **[Long transaction]** The Task check now runs on `tx` inside the interactive transaction. → Lookups are indexed by uuid and deduplicated, well within Prisma's default 5s interactive-transaction timeout for realistic cascades.
- **[Deletion releases many rows]** An agent with many open assignments produces many updates and activities. → Use `updateMany` per status group, and `createMany` for activities where the activity service allows it. Otherwise loop inside the transaction.
- **[Legacy dangling rows stay]** Existing rows like MCS 1.4.0's keep stale uuids, which the API already hides. → Moves skip them (D1). No backfill, by decision.

## Migration Plan

No schema or data migration. Deploy is code-only, and rollback is a plain revert.

## Open Questions

None. Everything was resolved in elaboration rounds 1–3.
