## Context

- `prisma/schema.prisma`: `relationMode = "prisma"`; `Idea.parent` (`IdeaLineage`) is `onDelete: Restrict, onUpdate: Restrict`.
- `deleteCompany` deletes company data by `companyUuid` in dependency order inside `prisma.$transaction`: activity → comment → proposal → task → document → **idea** → project → apiKey → agent → user → company.
- When `tx.idea.deleteMany` runs, the emulated Restrict check sees ideas still referenced by another idea's `parentUuid` and raises `P2014`, rolling back the transaction.
- `deleteIdea` and `detachIdeaLineageForProjects` (#619) already solve the same problem for single-idea and project-level deletes.

## Goals / Non-Goals

**Goals**
- A company that holds idea trees of any depth can be deleted.
- The detach runs in the same transaction, so a failed delete rolls it back.
- The write is `companyUuid`-scoped.

**Non-Goals**
- Changing `IdeaLineage` to `Cascade` / `SetNull`.
- Deleting the other company-owned models `deleteCompany` currently leaves behind (elaboration Q1, follow-up).

## Decisions

### D1 — One company-scoped `updateMany`

```ts
await tx.idea.updateMany({
  where: { companyUuid, parentUuid: { not: null } },
  data: { parentUuid: null },
});
await tx.idea.deleteMany({ where: { companyUuid } });
```

Every idea in the company is about to be deleted, so there is no need to work out which parents are being removed (the job of `detachIdeaLineageForProjects`). Filtering on `companyUuid` covers every project in one statement, with no prior project lookup (elaboration Q2).

### D2 — Placement

Immediately before `tx.idea.deleteMany`, after the `company.findUnique` "not found" guard. A missing company throws before any write.

## Risks / Trade-offs

- A child idea in **another** company pointing at an idea in the company being deleted would still raise `P2014`. Normal flows cannot create cross-company lineage (parent and child must share a project). This keeps the strict tenant boundary: we never write to another company's rows.
- Mocked unit tests cannot prove the engine no longer raises `P2014`; the PGlite real-engine test closes that gap.

## Verification Plan

1. Real engine (PGlite + Prisma, mirroring `project-delete-lineage.database.test.ts`): seed a company with two projects, a multi-level tree `a → b → c`, and a flat idea. `deleteCompany` succeeds and leaves no ideas, projects or company rows. A second company's idea tree is untouched (lineage intact).
2. Mocked unit test: `idea.updateMany` is called with the company-scoped where clause, and before `idea.deleteMany`.
3. `pnpm test`, `npx tsc --noEmit`, `pnpm lint` pass.
