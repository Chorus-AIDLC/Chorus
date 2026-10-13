## Context

- `prisma/schema.prisma`: `relationMode = "prisma"`; `Idea.project` is `onDelete: Cascade`; `Idea.parent` (`IdeaLineage`) is `onDelete: Restrict, onUpdate: Restrict`.
- With `relationMode = "prisma"` Prisma emulates referential actions in the query engine. When `project.delete` / `project.deleteMany` cascades into `Idea`, the engine checks Restrict relations on each Idea about to be removed; any Idea still referenced by another Idea's `parentUuid` triggers `P2014` and rolls back the transaction.
- `deleteIdea` (`src/services/idea.service.ts`) already works around this for single deletes by `updateMany({ where: { companyUuid, parentUuid: uuid }, data: { parentUuid: null } })` before deleting.
- `deleteProject` and `deleteProjectGroup(deleteProjects=true)` delete projects directly without this step — the production failure.

## Goals / Non-Goals

**Goals**
- Project delete and group-delete-with-projects succeed for projects containing idea trees of any depth.
- One shared helper used by both entry points, executed inside the existing transaction after the existing permission checks, so a rejected/failed delete leaves lineage untouched.
- Every write is `companyUuid`-scoped.

**Non-Goals**
- Changing `IdeaLineage` to `Cascade` or `SetNull` (elaboration Q1).
- Auditing other delete/cascade paths (elaboration Q3).
- Changing the keep-projects group-delete branch.

## Decisions

### D1 — Helper contract

```ts
// src/services/idea.service.ts
export async function detachIdeaLineageForProjects(
  tx: Prisma.TransactionClient,
  companyUuid: string,
  projectUuids: string[],
): Promise<number>
```

- Returns the number of Ideas updated; no-op (no query) when `projectUuids` is empty.
- Single statement:
  ```ts
  tx.idea.updateMany({
    where: { companyUuid, parentUuid: { not: null }, parent: { projectUuid: { in: projectUuids } } },
    data: { parentUuid: null },
  })
  ```
  The relation filter (`parent: { projectUuid: { in } }`) selects every child whose parent is going to be deleted, whatever project the child lives in (elaboration Q2). Children inside the deleted set get nulled and then cascade-deleted with their project; children outside survive as top-level Ideas — the same semantics as `deleteIdea`.
- Relation filters are supported under `relationMode = "prisma"` (they compile to sub-selects, not FK joins). If the relation filter proves unsupported on `updateMany` for this Prisma version, fall back to a two-step form: `findMany` parent Idea uuids in the projects (`select: { uuid }`), then `updateMany({ where: { companyUuid, parentUuid: { in: parentUuids } } })`. Either form is a single logical step inside the same transaction.

### D2 — Call sites

- `deleteProject`: inside `prisma.$transaction`, after `lockProjectManagement(tx, companyUuid, uuid, auth)` and before `tx.project.delete`. A permission failure throws before any write.
- `deleteProjectGroup`: inside the transaction, after the per-project access loop and `auditGroup`, inside `if (deleteProjects)` immediately before `tx.project.deleteMany`, passing the locked `projects.map(p => p.uuid)`.

### D3 — Why not `SetNull` in the schema

Chosen by the human in elaboration (Q1 = service helper). Explicit service-layer handling is batch (one `updateMany`), testable with the mocked Prisma client, and matches `deleteIdea`. Emulated `SetNull` would issue per-row queries during cascades and depend on engine internals.

## Risks / Trade-offs

- **Lineage cleared before delete in the same tx** — if the delete later fails, the transaction rolls back the detach too. Covered by a rollback test.
- **Cross-project children** become top-level silently. Acceptable and consistent with `deleteIdea`; cross-project lineage is not creatable through normal flows.
- Mocked unit tests cannot prove the engine no longer raises `P2014`; a real-PostgreSQL local reproduction (before/after) and a Tokyo re-check close that gap.

## Verification Plan

1. Vitest: helper (empty set no-op, where-clause shape, company scoping); `deleteProject` and `deleteProjectGroup` call order (permission → detach → delete), keep-projects branch never calls the helper, permission failure performs no detach, delete failure propagates.
2. Local real DB: PostgreSQL 17 container + `prisma db push`; seed a project with a multi-level idea tree (and a second untouched project), reproduce `P2014` on the unfixed code path, confirm success with the fix; same for group delete with `deleteProjects=true` and with `deleteProjects=false` (lineage preserved).
3. Tokyo: deploy with `default_deploy.sh`, create isolated `e2e-p2014-*` project / group with idea trees via the deployed app, delete them, confirm in CloudWatch (`Chorus-ServiceTaskDefinitionAppLogGroup65D511DD-DIMDaI1WefIE`) no `P2014` after deploy.
