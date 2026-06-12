# Project Visibility (Private / Shared)

## Summary

Adds a second access dimension to projects on top of multi-tenancy. A project is now either:

- **`shared`** — visible to the whole company (the historical behavior), or
- **`private`** — visible only to its **owner** and an explicit **member list** (users *and* agents).

Membership — not the permission bitset — is what grants access to a private project. Holding `project:admin` does **not** bypass it; only the **super admin** platform role sees everything (for governance).

New projects default to **private** (owner = creating actor, who is auto-added as the first member). A data migration sets all **pre-existing** projects to **shared**, so no current work becomes inaccessible.

## Why

Previously every project was visible to everyone in the company (services scoped only by `companyUuid`). Teams asked for private workspaces that a subset of people/agents can collaborate in.

## How it works

A single authz module — `src/lib/authz/project-access.ts` — is the source of truth:

- `getAccessibleProjectUuids(auth)` → the set of project UUIDs the actor may see (or an `ALL` sentinel for super admin)
- `canAccessProject(auth, projectUuid)` → read **and** write gate
- `canManageProject(auth, projectUuid)` → owner-only gate (visibility / membership / delete)
- `applyProjectFilter(where, accessible)` → injects `projectUuid: { in: [...] }` into existing (company-scoped) queries

Access is enforced **across the whole cascade** — the project and all of its ideas, proposals, documents, tasks, activity, comments, notifications, and search results are filtered for non-members. Both **reads and writes** are gated (e.g. a non-member agent cannot claim/update a private task or post a comment on it).

## Surfaces changed

- **Schema**: `Project.visibility` / `ownerType` / `ownerUuid`, new `ProjectMember` table, migration with `shared` backfill.
- **Services**: project, project-group, idea, proposal, document, task, activity, notification, comment, search, assignment, idea-tracker — all gated.
- **REST API**: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/[uuid]`, new `/api/projects/[uuid]/members` (GET/POST/DELETE, owner-only), and `canAccessProject` guards on every nested route. Leak rule: inaccessible → `404`, accessible-but-not-owner manage → `403`.
- **MCP tools**: `chorus_admin_create_project` gains `visibility` + `memberUuids`; new `chorus_list_project_members` (`project:read`), `chorus_admin_add_project_member` / `chorus_admin_remove_project_member` (`project:admin`); list/get project & group tools and every projectUuid-taking tool gated.
- **Frontend**: Lock badge on private projects; project settings modal gains a visibility toggle + owner-only members manager (shadcn-only, i18n en/zh, IME-safe).
- **Docs**: `docs/MCP_TOOLS.md` + both skill doc sets.

## Testing

- Unit tests for the authz core (full actor × visibility matrix, incl. `project:admin`-non-member denied and `projectUuids[]` header does **not** grant access).
- Read- and write-gating tests across every affected service.
- A dedicated **end-to-end privacy integration test** (`src/__tests__/integration/project-visibility.integration.test.ts`) that drives the real authz + services over an in-memory Prisma and asserts the full boundary: non-member deny (reads + writes), owner/member allow, super_admin all-access, `project:admin`-non-member deny, shared-project regression.
- Full gate green: `tsc` ✓, `pnpm test` (1889 pass / 1 skip) ✓, coverage **95.06% stmts / 87.94% branches / 95.95% funcs / 96.82% lines** (≥ thresholds) ✓, `pnpm build` ✓.

## Migration / rollout

The migration adds the columns (default `private`) **and** runs `UPDATE "Project" SET visibility='shared'` for all pre-existing rows, so production data stays fully visible. The standalone Docker entrypoint runs `prisma migrate deploy` automatically on container start.

## Known follow-ups (out of scope)

- Per-member roles (viewer/editor/admin) — currently a single `member` role.
- `project_group` entity **names** are still searchable in global search (group containers aren't visibility-gated); private-project *entities* never leak.
- `docs/design.pen` not updated in this environment (Pencil MCP tooling unavailable) — to refresh when design tooling is available.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
