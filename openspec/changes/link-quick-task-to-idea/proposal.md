## Why

GitHub issue #650: an Idea whose work was done with Quick Tasks (no Proposal) can never be finished. Chorus only knows one completion path — Idea → Proposal (`inputUuids`) → Task (`proposalUuid`). A Quick Task has no link to any Idea, so the Idea stays at "进行中 / 规划中" forever, while the project-group page (which only counts tasks) shows 100%. Felix decided (2026-11-05) to fix this by **letting a Quick Task link directly to one Idea, skipping the Proposal** — a first-class second path, not a manual "mark done" override.

## What Changes

- **Data model**: `Task` gains a nullable scalar `ideaUuid` (+ index). It is written **only** for Quick Tasks (tasks without `proposalUuid`); the two links are mutually exclusive. Proposal tasks keep deriving their Idea through `proposalUuid → inputUuids`. No backfill.
- **Linking rules**: one Idea per task; the Idea may be in any native status (open / elaborating / elaborated) and linking never changes the Idea's native status; the Idea must be in the same company and the same project as the task; theme (container) Ideas cannot take direct tasks (same rule as proposals). Requires `task:write` plus access to the project. Links can be set at creation and set / changed / cleared later.
- **MCP / REST / server actions**: `chorus_create_tasks` (Quick Task mode) accepts `ideaUuid`; `chorus_update_task` accepts `ideaUuid: string | null`; `chorus_list_tasks` filters by `ideaUuid`; task responses expose `ideaUuid`. Same on `POST /api/projects/{uuid}/tasks`, `PATCH /api/tasks/{uuid}` and the task server actions.
- **Unified Idea status computation**: one shared loader collects, per Idea, its pending/approved proposals, the approved proposal's tasks and the directly linked tasks; `computeDerivedStatus` folds the union of both task sets into building / verify_work / done. Every derived-status consumer (idea detail, tracker, `get_my_assignments`, theme rollup, Team handoff, agent-release, YOLO-done check, research eligibility, resource graph) uses that one path.
- **Lineage & routing**: a linked Quick Task is a full member of its Idea's lineage, exactly like a proposal task — root/direct idea resolution (`resolvedVia: "via_task_idea"`), daemon session anchor, instance pin inheritance, @mention routing, Team development/review routing, last-task detection, the whole-Idea code-review gateway, `execution_started` activity, cross-project Idea move and Idea deletion (link cleared).
- **Frontend**: pick an Idea when creating a Quick Task; view / change / clear the link in task detail; the Idea panel (overview timeline + tasks tab) lists linked Quick Tasks; resource graph draws Idea → Task edges. en + zh i18n, light + dark themes.
- **Plugins & docs**: the post-verify hooks' code-review gateway fires for Ideas completed via linked Quick Tasks; `docs/MCP_TOOLS.md` and the quick-dev / develop skills (all ports) document `ideaUuid`.

## Non-goals

- No manual "mark Idea done / closed" action.
- No completion report for Ideas without a Proposal (`chorus_create_report` stays proposal-bound).
- Project-group completion rate is unchanged (still task-based).
- Proposal-materialized tasks never get `ideaUuid`; no historical backfill.
- `docs/design.pen` is not updated (owner waived it for this change).
- "Start development" (proposal-task kickoff) is unchanged.

## Capabilities

### New Capabilities
- `quick-task-idea-link`: storing, validating and exposing the direct Quick Task → Idea link, and its lineage / routing / lifecycle semantics.
- `idea-derived-status`: the single shared rule for an Idea's derived status over proposal tasks ∪ linked Quick Tasks.

### Modified Capabilities
- None formally (behavioural extensions of `root-idea-resolution`, `idea-lineage`, `code-review-gateway` and `idea-cross-project-move` are specified inside the two new capabilities to keep the delta additive).

## Impact

- `prisma/schema.prisma` + new migration; regenerated Prisma client.
- Services: `task`, `idea`, `idea-tracker`, `lineage`, `idea-team`, `notification-listener`, `notification`, `project-team-handoff`, `agent-assignment-release`, `research-eligibility`, `resource-graph`; `src/lib/yolo-request.ts`.
- MCP: `src/mcp/tools/public.ts`, `src/mcp/tools/project-access.ts`. REST: task routes. Server actions under `projects/[uuid]/tasks` and dashboard panels.
- UI: task detail panel, dashboard idea detail panel / overview timeline / task list, resource graph; `messages/en.json`, `messages/zh.json`.
- Plugins: `on-post-verify-task.sh` (Claude Code, Codex/TRAE `plugins/chorus`, Kiro), Hermes reminders; skill docs; `docs/MCP_TOOLS.md`.
- Reference: https://github.com/Chorus-AIDLC/Chorus/issues/650
