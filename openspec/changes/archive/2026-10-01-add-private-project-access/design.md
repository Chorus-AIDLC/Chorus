## Context

Authorization today has two layers and neither is project-aware:

1. **Tenant isolation** — every query filters by `companyUuid`.
2. **Agent capability bits** — `src/lib/authz/` (`{resource}:{action}`, company-wide) checked by `checkAgentPermission` (`src/lib/auth.ts:196`) for REST and by `registerPermissionedTool` for MCP tool visibility. Humans pass through.

Project existence is checked through `projectService.projectExists(companyUuid, uuid)` (~47 references in 21 files), `getProject`, `getProjectByUuid`, and one inline query (`api/projects/[uuid]/activity/route.ts`). Entity routes (`/api/tasks/[uuid]`, ideas, proposals, documents, comments, references, entities) never resolve the project — they fetch `{uuid, companyUuid}`. Entity → project resolution exists in three private copies: `comment.service.ts:437 resolveProjectUuid`, `mention.service.ts:183-216`, `reference-artifact.service.ts:179`, plus `mcp/tools/presence.ts:79` (not company-scoped). `User` has no role column; `Project` has no creator column.

## Goals / Non-Goals

**Goals**
- One authoritative function for "actor × project → level", reused by every surface.
- Private projects are invisible (404) to non-members on every read path, including aggregates, search, SSE and notifications.
- Zero behaviour change for public projects.

**Non-Goals**
- Company-level admin role, SuperAdmin break-glass, access requests / "request to join".
- Per-agent membership (agents only inherit through their owner).
- Levels on public projects (public = everyone full read/write, as today).
- Per-entity ACLs inside a project; project groups gaining their own visibility.
- MCP tools for membership management (UI/REST only in this change).

## Decisions

### D1. Data model

```prisma
model Project {
  // ...existing
  visibility    String  @default("public") // "public" | "private"
  createdByUuid String? // creator User UUID (agent-created → agent.ownerUuid); legacy rows backfilled (see Migration)
  members       ProjectMember[]
  @@index([companyUuid, visibility])
}

model ProjectMember {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  companyUuid String
  projectUuid String
  project     Project  @relation(fields: [projectUuid], references: [uuid], onDelete: Cascade)
  userUuid    String
  role        String   // "viewer" | "editor" | "admin"
  addedByUuid String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([projectUuid, userUuid])
  @@index([companyUuid, userUuid])
}
```

Migration: add columns with defaults (all existing projects → `public`), create table, then backfill in SQL: for each existing project set `createdByUuid` = the company's first user (`ORDER BY "createdAt" ASC, id ASC LIMIT 1`) and insert an `admin` `ProjectMember` row for that user. A company with zero users (not expected in practice) leaves `createdByUuid = NULL` and no admin row; such a project stays public and can only be managed after an admin row exists (documented, not handled in UI). `relationMode = "prisma"` so the cascade is application-level, consistent with the rest of the schema. Membership rows persist when a project is public (dormant) so switching back to private restores them.

### D2. Access levels and resolution

`type ProjectAccessLevel = "none" | "viewer" | "editor" | "admin"` (ordered).

`getProjectAccess(auth, projectUuid) → { project, level }` in `src/services/project-access.service.ts`:

| Actor | Project missing / other company | public | private, member role R | private, non-member |
|---|---|---|---|---|
| user | none | member role R, else editor | R | none |
| agent with owner | none | owner's role R, else editor | owner's R | none |
| agent without owner | none | editor | none | none |

On public projects every company actor gets at least `editor`, so content read/write is unchanged for everyone (Non-goal: Viewer levels on public projects). `admin` on a public project comes only from an explicit `admin` membership (the creator, or for legacy projects the company's first user, plus anyone they promote). Operations are split so public projects keep today's behaviour (owner decision, idea comment 2026-10-01 05:33: "public项目的管理不只是admin可以做，但只有转换为private是admin才可以做的操作"):

| Operation | public project | private project |
|---|---|---|
| content read | any company actor | viewer+ |
| content write / approve / verify | any company actor | editor+ |
| `manage_project` — edit settings, move group, delete | any company actor (unchanged) | admin |
| `change_visibility` (public→private) | explicit admin member only | admin (private→public) |
| `manage_members` — add / change role / remove | explicit admin member only | admin |

`manage_members` is admin-only on public projects too, because otherwise any member could grant themselves admin and then switch to private, defeating the rule. Implemented as `requireProjectOperation(auth, projectUuid, op)` on top of `getProjectAccess`: on public projects non-members resolve to `editor` and `manage_project` is allowed for `editor`+; on private projects it needs `admin`. This closes the review-round-1 lock-out vector: a non-Admin cannot flip a public project to private. The agent's company-wide permission bits are still checked independently (existing `checkAgentPermission` / tool registration), so the effective result is the **intersection**: the bit says *what kind of thing* the agent may do, the level says *whether the owner may do it in this project*.

Required level per operation:
- **viewer**: any read of the project or its entities.
- **editor**: any create/update/delete/claim/comment/reference/elaboration/proposal action on entities within the project (including proposal approve/reject and task verify — governance is not split out in this change).
- **admin**: on private projects — update project metadata, delete, move between groups; on all projects — change visibility and manage members (see the operation table above; on public projects metadata/delete/group-move remain open to all).

Request-scoped memoisation: a small per-request cache (`Map<projectUuid, level>` keyed off the auth object via `WeakMap`) avoids repeated membership queries inside one request/MCP call.

### D3. Module contracts (shared across tasks)

`src/services/project-access.service.ts` exports:

```ts
export type ProjectAccessLevel = "none" | "viewer" | "editor" | "admin";
export type AccessEntityType = "project" | "idea" | "proposal" | "task" | "document" | "comment";

getProjectAccess(auth: AuthContext, projectUuid: string): Promise<{ project: Project | null; level: ProjectAccessLevel }>;
requireProjectAccess(auth, projectUuid, min: Exclude<ProjectAccessLevel,"none">): Promise<Project>;
  // throws ProjectNotFoundError (→ 404) when level === "none"; ProjectAccessDeniedError (→ 403) when 0 < level < min
resolveEntityProjectUuid(companyUuid: string, type: AccessEntityType, uuid: string): Promise<string | null>;
requireEntityAccess(auth, type, uuid, min): Promise<{ projectUuid: string }>; // 404 if entity missing OR level none
accessibleProjectWhere(auth: AuthContext): Promise<Prisma.ProjectWhereInput>;
  // { companyUuid, OR: [{ visibility: "public" }, { uuid: { in: memberProjectUuids } }] }
accessibleProjectUuids(auth): Promise<string[]>; // for filters on non-Project tables (search, trackers, SSE)
canActorAccessProject(companyUuid, actor: { type: "user"|"agent"; uuid: string }, projectUuid, min): Promise<boolean>;
  // for recipients / mention / assignment targets (not the caller)
```

- `ProjectNotFoundError` / `ProjectAccessDeniedError` are mapped by `withErrorHandler` to `errors.notFound("Project")` / `errors.forbidden(...)`; MCP wrapper maps them to the same `{ error }` text shape tools use today.
- `resolveEntityProjectUuid` **replaces** the private copies in comment / mention / reference-artifact services and `presence.ts` (which must become company-scoped).
- `projectExists(companyUuid, uuid)` is retained for internal/service use only; all request-facing call sites move to `requireProjectAccess`.

`src/services/project-member.service.ts` exports `listMembers`, `addMember(auth, projectUuid, userUuid, role)`, `updateMemberRole`, `removeMember`, `setVisibility(auth, projectUuid, visibility)`; all require `admin`. Invariants: target user must be in the same company; a private project must retain ≥1 admin (`LastAdminError` → 400); `setVisibility("private")` upserts the actor's user (agent → owner; ownerless agent → reject) as admin in the same transaction. Every mutation logs an Activity (`project_member_added|role_changed|removed`, `project_visibility_changed`) and emits a realtime `project_access_changed` event.

Creator auto-admin: `projectService.createProject` and `createProjectWithAgentCwds` accept `createdByUuid` and always create the creator's `admin` membership in the same transaction (public or private), and log a `created` Activity for the project (none is logged today). `setVisibility` requires `admin`; on public→private the actor is already an admin, so the upsert is a safety no-op.

### D4. Enforcement map

| Surface | Mechanism |
|---|---|
| `api/projects/[uuid]/**` routes | `requireProjectAccess(auth, uuid, viewer|editor|admin)` replaces `projectExists`/`getProject`; fixes `proposals/[proposalUuid]/validate` which ignores the path project and `activity` inline query |
| Entity routes (`api/tasks/[uuid]`, ideas, proposals, documents, comments, references, entities, `tasks/[uuid]/dependencies`, etc.) | `requireEntityAccess` before the service call |
| Dashboard pages `projects/[uuid]/**` | new `projects/[uuid]/layout.tsx` calling `requireProjectAccess(…,"viewer")` → `notFound()`; page-level `redirect("/projects")` on missing project becomes `notFound()` |
| Server actions (~90 in 22 files) | `requireEntityAccess`/`requireProjectAccess` at the top of each mutating action (editor/admin) |
| MCP tools | central gate in the shared tool wrapper: reuse `detectResource` (presence.ts:44) to find the project from `projectUuid` / `ideaUuid` / `taskUuid` / `proposalUuid` / `documentUuid` / `targetType+targetUuid`; required level derived from the tool's permission action in `permission-map.ts` (`read`→viewer, `write`/`admin` on non-project resources→editor, `project:*` on an existing project→admin); ungated tools default to viewer for reads, editor for comment/reference writes. Returns the standard not-found error text for `none`. |
| Listings | `GET /api/projects`, `listProjects`, `listProjectsWithStats`, `getCompanyOverviewStats`, `listProjectGroups` counts, `getProjectGroup`, `getGroupDashboard`, `getSidebarQuickAccess`, `recordVisit`/`pinProject` all use `accessibleProjectWhere` |
| Search | `search.service` defaults `projectUuids` to `accessibleProjectUuids(auth)` (intersected with any caller filter); exact-UUID lookup and project/group hits filtered the same way |
| Trackers / checkin / available | `buildIdeaTracker`, `buildTaskTracker`, `getAvailableItems`, checkin `activeProjects` restricted to accessible projects |
| SSE | `api/events` computes the accessible set at connect; drops `change`/`presence` events whose `projectUuid` is private and not in the set; refreshes the set on `project_access_changed` for the subscriber's company |
| Notifications | `notification-listener.resolveRecipients` drops recipients for whom `canActorAccessProject(…, "viewer")` is false; `resolveProjectName` becomes company-scoped |
| Mentions | `validateMentionTarget` rejects targets without access to the entity's project; `searchMentionables` with `entityType/entityUuid` filters to users with access + agents whose owner has access |
| Assignment | idea/task assign (REST, server action, MCP `chorus_pm_assign_*`, claim) rejects assignees without `editor` access (agents via owner) |
| Daemon wakes | follow notifications; `daemon-instruction.service` conversational-idea path reuses `requireProjectAccess` (keeps `ProjectNotVisibleError` semantics) |

### D5. UI

- `create-project-dialog.tsx`: visibility radio (Public default / Private) with helper text.
- `project-settings-modal.tsx`: new **Access** tab (admin-only edit; others see read-only) — visibility toggle with confirmation dialog for public→private ("members not listed lose access"), member table (`Table`, role `Select`, remove `Button`), add-member combobox fed by company users. Last-admin guard surfaced as inline error. Basic-info edit and the danger zone (delete) stay available to everyone on public projects and are admin-only on private projects.
- Lock `Badge`/icon on private projects in projects list, group page, sidebar quick access.
- Viewer read-only: hide/disable primary create/edit affordances on project pages using the `accessLevel` exposed by `GET /api/projects/[uuid]` and page data; server remains the source of truth.
- shadcn/ui only, semantic tokens / `dark:` variants, IME guard on any Enter handler, en + zh keys, `docs/design.pen` updated.

## Risks / Trade-offs

- **Missed enforcement point leaks data** → mitigated by (a) one shared resolver, (b) a route-inventory test that enumerates `src/app/api/**/route.ts` and asserts each project/entity route calls the access helper (allowlist for non-project routes), (c) an integration checkpoint across REST/MCP/search/SSE/notifications.
- **Only Admins can make a public project private or manage its members**; all other public-project management stays open to everyone. Legacy projects' Admin is the company's first user, who can promote others.
- **Legacy creator backfill is a heuristic** (first company user is not necessarily the real creator) — accepted by the owner; the first user can re-assign Admin via the Access tab.
- **Performance**: one extra membership lookup per request (memoised); `accessibleProjectUuids` per SSE connection and per search. Index `@@index([companyUuid, userUuid])` keeps it cheap.
- **Owner-less agents** lose all private-project access — intended, documented.
- **Revocation latency**: an open SSE stream refreshes on `project_access_changed`; already-delivered notifications remain in the inbox (their links 404).

## Migration Plan

1. Prisma migration adds columns/table; all rows public → zero behaviour change.
2. Ship access core + enforcement behind no flag (inert while no project is private).
3. UI exposes private creation/toggle last.
Rollback: drop the UI; enforcement on all-public data is a no-op.

## Open Questions

None — resolved in idea comments (legacy creator = company's first user; Editors may approve/verify; defaults confirmed).
