## Why

On 2026-10-13 the Tokyo (ap-northeast-1) deployment failed every attempt to delete a project, and to delete a project group together with its projects (`deleteProjects=true`), with Prisma `P2014` — `The change you are trying to make would violate the required relation 'IdeaLineage' between the Idea and Idea models.` The schema uses `relationMode = "prisma"`; `Project → Idea` is `onDelete: Cascade` while the Idea self-relation `IdeaLineage` is `onDelete: Restrict`. When the project cascade reaches an Idea that still has children pointing at it via `parentUuid`, Prisma's emulated Restrict aborts the whole transaction. Single-Idea delete (`deleteIdea`) already detaches direct children first; the two project-level delete paths never did. Any project that ever used idea lineage (derived/child ideas, theme ideas) is therefore undeletable.

## What Changes

- Add a shared service helper `detachIdeaLineageForProjects(tx, companyUuid, projectUuids)` in `src/services/idea.service.ts` that, inside the caller's transaction, sets `parentUuid = null` on every Idea (same company) whose **parent** Idea belongs to one of the projects about to be deleted — regardless of which project the child itself lives in.
- `deleteProject` (`src/services/project.service.ts`) calls the helper inside its existing transaction, after `lockProjectManagement` (permission + lock) and before `tx.project.delete`.
- `deleteProjectGroup` (`src/services/project-group.service.ts`) calls the helper inside its existing transaction, after the per-project access checks and only on the `deleteProjects=true` branch, before `tx.project.deleteMany`.
- The keep-projects branch of `deleteProjectGroup` is unchanged (it never deletes Ideas).
- No schema change: `IdeaLineage` stays `onDelete: Restrict`; single-Idea delete keeps orphaning children to top-level.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `idea-lineage`: adds a requirement that deleting a project (directly or via group delete with projects) detaches lineage so the delete succeeds, and children living outside the deleted set survive as top-level ideas.

## Impact

- Code: `src/services/idea.service.ts`, `src/services/project.service.ts`, `src/services/project-group.service.ts` and their unit tests.
- No API, MCP tool, UI, i18n or schema changes; no migration.
- Out of scope (per elaboration Q3): auditing other cascade/Restrict paths; any finding is recorded as a follow-up Idea.
- Verification (per elaboration Q4): Vitest regressions, a real-PostgreSQL local reproduction, and a re-check on the Tokyo deployment after deploy with CloudWatch evidence of no `P2014`.
