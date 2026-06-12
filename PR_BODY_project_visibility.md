# Project Visibility (Private / Shared) + Two-Level Group Inheritance

> This branch contains **two stacked features**: (1) per-**project** visibility, and (2) per-**project-group** visibility that projects **inherit** via a dynamic union. They share the `project-access.ts` authz core and ship together. A mid-stream regression (empty groups vanishing from the list) was also fixed (commit `4500008`).

---

## Part 1 — Project Visibility (Private / Shared)

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

---

## Part 2 — Two-Level Visibility (ProjectGroup → Project inheritance)

### Summary

Project **groups** gain the same `shared`/`private` + owner + member model, and a project's effective access becomes the **dynamic union** of its own accessors and its group's accessors.

- **Inheritance = dynamic union**: a project's accessors = (project owner + members) ∪ (its group's owner + members). Add someone to a private group → they instantly reach **every project in it** (and all cascaded entities). No snapshot; computed at query time.
- **"项目级 > 项目组" (project-level is authoritative)**: a project's own `visibility` flag wins. A `shared` project inside a `private` group is still company-wide; a **`private` project inside a `shared` group is still restricted** — a shared group never exposes its private projects. (Enforced by using *only owner/member* groups for the project-union, never shared groups.)
- New groups default **private** (creator = owner + first member); existing groups migrate to **shared**. A new project created with a `groupUuid` defaults to its group's visibility.
- Group management (visibility, members, update, delete) is **owner + super-admin only** — no `project:admin` bypass.

### Surfaces

- **Schema**: `ProjectGroup.visibility`/`ownerType`/`ownerUuid`, new `ProjectGroupMember` table, migration with `shared` backfill.
- **Authz core** (`project-access.ts`): `getAccessibleProjectUuids` + `canAccessProject` fold in owned/member groups; new `getAccessibleGroupUuids` / `canAccessGroup` / `canManageGroup`. Two **distinct** group-sets kept rigorously separate (project-union = owner/member only; group-visibility = shared∪owned∪member).
- **Service / REST**: group visibility + member CRUD, `listProjectGroups` gated by `canAccessGroup` (preserving the empty-group fix), new `/api/project-groups/[uuid]/members`, project inherits group visibility default.
- **MCP**: `chorus_admin_create_project_group` gains `visibility`/`memberUuids`; new `chorus_list_project_group_members` (`project:read`), `chorus_admin_add/remove_project_group_member` (`project:admin`); `update`/`delete` group tools now owner-gated.
- **Frontend**: Lock badge on private groups; manage-group dialog visibility toggle + owner-only members manager (i18n en/zh).
- **Docs**: MCP_TOOLS.md + both skill doc sets.

### Testing (whole branch)

- Authz unit matrix extended for group inheritance incl. **both cross-case invariants** (shared-in-private-group still company-wide; private-in-shared-group still restricted) and `project:admin`-non-member-denied.
- End-to-end integration test extended: a group member gains read+write across the group's private project + cascade purely via group membership; **dynamic revocation** (remove from group → access flips); non-member + `project:admin`-non-member denied.
- Full gate green: `tsc` ✓, **1954 tests pass / 1 skip** ✓, coverage **95.16% stmts / 88.5% branches / 96.03% funcs / 96.92% lines** (≥ thresholds) ✓, `pnpm build` ✓.

### Migration / rollout

Both migrations (`add_project_visibility`, `add_project_group_visibility`) run automatically via the Docker entrypoint and backfill existing rows to `shared`. Already deployed to the live standalone instance for validation.

### Known follow-ups (out of scope)

- Per-member roles (viewer/editor/admin) — single `member` role for both projects and groups.
- Project cannot NARROW/remove inherited group members (union only — by design).
- Nested groups (single level, unchanged).
- `docs/design.pen` not updated (Pencil MCP tooling unavailable in this environment).
