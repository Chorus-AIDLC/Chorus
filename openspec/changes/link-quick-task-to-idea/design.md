## Context

Today the only Idea ↔ Task path is `Task.proposalUuid → Proposal.inputUuids[0]`. Every consumer re-implements that walk (idea.service single + batch, idea-tracker, project-team-handoff, agent-assignment-release, research-eligibility, resource-graph, yolo-request, lineage, idea-team, notification-listener, plugin hooks). Quick Tasks fall through all of them, which is the root cause of #650. Decisions come from elaboration rounds 1–2 on Idea `63753a7d-6a94-48a1-9e64-6ecb15be4ed6` (answered by Felix) and the follow-up confirmation comment.

## Goals / Non-Goals

Goals: a first-class direct link for Quick Tasks; one shared derived-status path over proposal tasks ∪ linked tasks; linked tasks behave exactly like proposal tasks for lineage, routing, Team and the code-review gateway; full UI support.

Non-goals: manual Idea completion, proposal-less completion reports, project-group rate changes, backfill, `design.pen`.

## Decisions

### D1 — Data model: nullable scalar `Task.ideaUuid`

```prisma
model Task {
  ...
  proposalUuid String?
  ideaUuid     String? // Direct Idea link — Quick Tasks only (mutually exclusive with proposalUuid)
  ...
  @@index([ideaUuid])
}
```

Plain scalar, no Prisma relation — matches `proposalUuid` (also a scalar) and `relationMode = "prisma"`. Migration `prisma/migrations/<ts>_task_idea_link/` adds the column + index; no data migration. Alternative (relation with `onDelete: SetNull`) rejected: Idea has no task relation today and the delete path is handled explicitly (D7).

### D2 — Link invariants (enforced in `task.service`, the single write path)

A shared validator `assertValidTaskIdeaLink(companyUuid, { projectUuid, proposalUuid, ideaUuid })`:

1. `ideaUuid == null` → always valid (clears the link).
2. `proposalUuid != null` → reject (`"A task linked to a proposal cannot also link to an idea directly"`).
3. Idea must exist in `companyUuid` → else not found.
4. `idea.projectUuid === projectUuid` → else reject (`"Idea must be in the same project as the task"`).
5. `idea.isContainer === true` → reject (`"Theme ideas cannot have tasks; link a child idea"`).
6. Any native Idea status is allowed; linking never mutates the Idea row.

Called from `createTask` and `updateTask` (when `ideaUuid` is present in the update). Errors surface as 400 on REST / `isError` on MCP via the existing error mapping. MCP project access: `project-access.ts` already authorizes a top-level `ideaUuid` against the declared project; both tools stay `task:write`.

### D3 — API surfaces

- `TaskResponse.ideaUuid: string | null` (both `formatTaskResponse` and `formatTaskResponsesBatch`, `listTasks` select, `getUnblockedTasks` select).
- `listTasks({ ideaUuid })` filter; `chorus_list_tasks` gains optional `ideaUuid`.
- `chorus_create_tasks`: optional **top-level** `ideaUuid` applying to every task in the batch; rejected when `proposalUuid` is also passed. Activity value records the link.
- `chorus_update_task`: optional `ideaUuid: string | null` (set / change / clear); counts as a field update; activity logged.
- REST `POST /api/projects/{uuid}/tasks` and `PATCH /api/tasks/{uuid}` accept `ideaUuid`; `createTaskAction` / `updateTaskFieldsAction` pass it through.

### D4 — Unified derived status

New module `src/services/idea-task-context.service.ts`:

```ts
export interface IdeaTaskContext {
  hasPendingProposal: boolean;
  hasApprovedProposal: boolean;
  proposalTaskStatuses: string[]; // tasks of the latest approved proposal (existing rule)
  linkedTaskStatuses: string[];   // tasks with task.ideaUuid === idea
  proposalCount: number;
}
// Batched — ≤3 queries regardless of idea count; accepts a tx client.
export async function loadIdeaTaskContexts(
  db: PrismaLike, companyUuid: string,
  ideas: { uuid: string; projectUuid: string }[],
): Promise<Map<string, IdeaTaskContext>>;
```

`DerivedStatusContext` gains `linkedTaskStatuses?: string[]` (default `[]`). `computeDerivedStatus` keeps its current behaviour **byte-for-byte when `linkedTaskStatuses` is empty**. When non-empty, with `all = (hasApprovedProposal ? taskStatuses : []) ∪ linkedTaskStatuses`, precedence is:

1. native `elaborating` + `elaborationStatus === "pending_answers"` → `human_conduct_required / answer_questions`
2. `hasPendingProposal` → `human_conduct_required / review_proposal`
3. any `to_verify` in `all` → `human_conduct_required / verify_work`
4. every status in `all` is `done|closed` → `done / done`
5. otherwise → `in_progress / building`

This applies regardless of native status (open / elaborating / elaborated). Task counts shown in trackers (`taskCount`, tracker `tasks`) become `all.length`. Callers migrated to `loadIdeaTaskContexts` + `computeDerivedStatus`: `getIdeaWithDerivedStatus`, `getIdeasWithDerivedStatus` (feeds `getIdea` children, tracker groups, theme rollup), `idea-tracker.service` (`get_my_assignments`, checkin), `project-team-handoff.service.derivedStatuses`, `agent-assignment-release.computeDerivedStatusesInTx`, `research-eligibility.service`. `yolo-request` (`ideaIsDone` behind `yoloPreconditionsMet` / `canRequestYolo`) accepts linked tasks (done when the union is non-empty and all terminal, even with no proposal). `resource-graph.service` adds Idea → Task edges for `ideaUuid` and includes linked tasks in idea badge derivation.

### D5 — Lineage & routing

- `lineage.service`: `resolveDirectIdeaUuid("task")` returns `task.ideaUuid` (existence-checked) when set, else the proposal path. `resolveFromTask` adds a branch: `ideaUuid` → `walkToRoot` with `resolvedVia: "via_task_idea"` (added to `ResolvedVia`). Everything downstream (`notification-turn` session anchor + pin inheritance, `notification.service` waker anchor, `mention.service`) follows automatically; stale comments ("A Task has no ideaUuid column") are corrected.
- `idea-team.service`: `getIdeaTeamOrchestrators` task branch and `recommendIdeaTeamRole`'s "task belongs to idea" check accept `task.ideaUuid`.
- `notification-listener`: last-task detection for an Idea counts non-terminal tasks over proposal tasks ∪ linked tasks, so the "last task submitted" / whole-Idea review handoff fires for Quick-Task Ideas.
- `task.service.preserveIdeaExecution`: writes the Idea `execution_started` activity for `task.ideaUuid` too (update + delete paths).

### D6 — Plugins

`on-post-verify-task.sh` (Claude Code `public/chorus-plugin/bin`, Codex/TRAE `plugins/chorus/hooks`, Kiro `public/kiro-plugin/bin`) and Hermes `reminders.py`: when the verified task has no `proposalUuid` but has `ideaUuid`, Branch C (code-review gateway) lists `chorus_list_tasks({ projectUuid, ideaUuid })` and emits the reminder when all are terminal. For proposal tasks whose Idea also has linked tasks, the gateway additionally requires the linked tasks to be terminal. Branch A (OpenSpec archive) and Branch B (completion report) stay proposal-only. Bash 3.2 compatible; hook tests extended. Plugin version bumps + release are a tracked follow-up (release skill), not part of this change.

### D7 — Lifecycle edges

- `moveIdea` / `moveIdeaPreview`: tasks with `ideaUuid ∈ movedIdeaUuids` move with the Idea (projectUuid updated, included in counts, assignee checks and activity moves) exactly like proposal tasks.
- `deleteIdea`: clears `ideaUuid` on linked tasks (tasks survive as plain Quick Tasks) in the same transaction.
- Task delete: linked-task removal recomputes nothing persisted (status is derived).

### D8 — Frontend

- Task detail panel (`tasks/task-detail-panel.tsx`): create mode shows an optional Idea `Select` (project's non-container ideas) for Quick Tasks; detail view shows an "Idea" source link alongside / instead of the Proposal link; edit mode can change or clear the link (hidden for proposal tasks). Server action `getTaskIdeaOptionsAction` + source action extended.
- Dashboard idea detail panel: `fetchTasks` also loads linked Quick Tasks (`getTasksForIdeaAction` → `listTasks({ ideaUuid })`), so the tasks tab and `OverviewTimeline` include them; `currentPhase` treats linked tasks as execution even without a proposal; task-list "view all" link supports the idea filter. Legacy `ideas/idea-detail-panel.tsx` and `yolo-button.tsx` pass linked tasks into `canRequestYolo` / `yoloPreconditionsMet`.
- All strings via `t()` in en + zh; shadcn components; semantic tokens (light + dark).

## Risks / Trade-offs

- **Many consumers** — mitigated by D4's single loader and keeping old behaviour identical when no linked tasks exist (existing tests stay green; new tests cover the linked branch).
- **Mixed Ideas (proposal + linked tasks)** — union semantics chosen by the owner; a pending proposal still takes precedence over done.
- **Installed runtime** — :18637 runs the released build; live E2E needs an isolated :8637 dev server.

## Migration Plan

Additive nullable column + index; deploy runs `prisma migrate deploy`. Rollback = drop column (no data loss beyond links).
