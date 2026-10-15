## Why

While fixing the project / project-group delete `P2014` (#619) we found that `deleteCompany` (`src/services/company.service.ts`) has the same defect. Inside its transaction it calls `tx.idea.deleteMany({ where: { companyUuid } })` without first detaching lineage. Under `relationMode = "prisma"` the `IdeaLineage` self-relation is an emulated `onDelete: Restrict`, so any company that holds an idea with a child idea fails to delete with `P2014 ... required relation 'IdeaLineage'` and the whole transaction rolls back. Reproduced on 2026-10-13 with PGlite + the real Prisma 7.10 engine (one project, idea `a`, child idea `b` with `parentUuid = a`).

## What Changes

- In `deleteCompany`, inside the existing transaction and immediately before `tx.idea.deleteMany`, clear lineage for the whole company with one statement: `tx.idea.updateMany({ where: { companyUuid, parentUuid: { not: null } }, data: { parentUuid: null } })` (elaboration Q2 = company-scoped `updateMany`, not the project-list helper).
- Add a real-engine regression test (PGlite + Prisma) that deletes a company holding a multi-level idea tree, and extend the mocked unit test to assert the detach runs before `idea.deleteMany` (elaboration Q3).
- No schema change: `IdeaLineage` stays `onDelete: Restrict`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `idea-lineage`: adds a requirement that deleting a company detaches lineage so the delete succeeds.

## Impact

- Code: `src/services/company.service.ts`, `src/services/__tests__/company.service.test.ts`, new `src/services/__tests__/company-delete-lineage.database.test.ts`.
- No API, MCP tool, UI, i18n or schema changes; no migration.
- Out of scope (elaboration Q1): `deleteCompany` still does not delete several company-owned models (ProjectGroup, Notification, ElaborationRound, AgentSession, Mention, …). Recorded as a follow-up.
