## Why

Today every user and agent in a Company can see and modify every Project — the only isolation boundary is `companyUuid`. Teams need to keep some projects (e.g. confidential initiatives, customer-specific work) restricted to a named group of people, with different people holding different levels of authority inside that project. The owner asked for project-level access control: projects are either **public** or **private**, private projects are reachable only by allowed users, and allowed users carry a permission level.

Decisions confirmed in elaboration (round 1, verified by the owner):

- Two visibilities: `public` (unchanged behaviour — every company member has full read/write, no levels) and `private` (members only).
- Three member levels on private projects: **Viewer** (read-only), **Editor** (create/edit Ideas, Proposals, Tasks, Documents, comments), **Admin** (Editor + manage members, change visibility, edit/delete the project).
- Agents inherit their **owner's** membership; an agent's effective capability is the intersection of the owner's project level and the agent's own permission bits. Agents are never members themselves.
- The project creator automatically becomes its Admin; no company-level admin role is introduced. On **public** projects everything stays open to every company member as today (content, settings, group move, delete) — **except switching to private** (and, to protect that, managing the member list), which only the project's Admin members may do. On **private** projects all management is Admin-only.
- Non-members see nothing: private projects are absent from project lists, search, group dashboards, notifications and SSE, and direct access returns **404**.
- Existing projects migrate as `public`; new projects default to `public`.

Follow-up decisions (owner, idea comments 2026-10-01, after proposal review round 1):

- **Legacy projects have no creator record** (verified: no column, no creation Activity). The migration backfills each existing project's creator/Admin as **the first user of its Company** (earliest `User.createdAt`, tie → lowest `id`).
- **Editors may approve/reject proposals and verify tasks** (no separate governance level).
- The defaults below are **confirmed**:

- A project created by an agent makes the agent's **owner** its Admin.
- A private project always keeps at least one Admin (cannot remove/demote the last Admin).
- Switching public → private makes the actor (or the acting agent's owner) an Admin; everyone else loses access. Switching private → public keeps the member list (dormant) for a later switch back.
- In a private project, only members (and agents owned by members) can be @mentioned or assigned.
- The SuperAdmin panel is unchanged (no break-glass management of private projects).

## What Changes

- **Schema**: `Project.visibility` (`"public" | "private"`, default `"public"`), `Project.createdByUuid` (creator user UUID; legacy rows backfilled to the company's first user), and a new `ProjectMember` model (`projectUuid`, `userUuid`, `role: viewer|editor|admin`).
- **Access core**: a single service (`project-access.service.ts`) that answers "what level does this actor have on this project?" for users and agents, a Prisma `where` fragment for "projects this actor can see", and one consolidated entity → project resolver (replacing the three ad-hoc copies in comment / mention / reference services and the presence wrapper).
- **Membership management**: list/add/change-role/remove members and change visibility, with the last-Admin guard and creator auto-Admin on every create path (REST, server action, MCP).
- **Enforcement everywhere a project or its entities are reachable**: project-scoped and entity-scoped REST routes, dashboard pages (`notFound()`), server actions, MCP tools (central gate), list/aggregate surfaces (projects list, project groups, group dashboard, search, sidebar quick access, stats, assignments/checkin), SSE, notifications, mentions/mentionables, and assignment targets. No access → 404; insufficient level → 403.
- **UI**: visibility choice in Create Project, a new **Access** tab in Project Settings (visibility toggle + member table with role select / add / remove), a lock badge on private projects, and read-only affordances for Viewers. en + zh i18n, light + dark themes, `docs/design.pen` updated.
- **MCP**: `chorus_get_project` returns `visibility` and the caller's `accessLevel`; `chorus_admin_create_project` gains optional `visibility`. Docs updated in `docs/MCP_TOOLS.md` and both skill trees.

## Capabilities

### New Capabilities

- `project-access-control`: Project visibility (public/private), per-project membership with Viewer/Editor/Admin levels, agent inheritance via owner, and the enforcement contract (404 for non-members, 403 for insufficient level) across REST, pages, MCP, search, listings, SSE, notifications, mentions and assignment.

### Modified Capabilities

<!-- None at requirement level — existing capability specs keep their behaviour for public projects; the new capability layers a project-access precondition on top. -->

## Impact

- **Prisma**: 1 new model, 2 new `Project` columns, 1 migration (existing rows → `public`, `createdByUuid` = company's first user, plus an `admin` `ProjectMember` row for that user). Run `pnpm db:generate`.
- **Services**: new `project-access.service.ts` + `project-member.service.ts`; touches `project.service.ts`, `project-group.service.ts`, `project-visit.service.ts`, `search.service.ts`, `idea-tracker.service.ts`, `assignment.service.ts`, `notification-listener.ts`, `mention.service.ts`, `comment.service.ts`, `reference-artifact.service.ts`, `project-agent-cwd.service.ts`.
- **REST**: ~47 `projectExists` call sites migrate to an access-aware helper; entity routes gain an entity-access check; new `/api/projects/[uuid]/members` routes; `PATCH /api/projects/[uuid]` accepts `visibility`.
- **MCP**: central project-access gate in the tool wrapper (`src/mcp/tools/presence.ts` / `register-helpers.ts`), filtered list tools, two tool schema additions.
- **SSE**: `src/app/api/events/route.ts` filters change/presence events by the subscriber's accessible project set.
- **UI**: `create-project-dialog.tsx`, `project-settings-modal.tsx`, projects list / sidebar / group pages, Viewer read-only affordances; `messages/en.json` + `messages/zh.json`; `docs/design.pen`.
- **Behavioural**: public projects behave exactly as today for every company member (content, settings, group move, delete). The only new restriction on public projects: switching to private and managing members require project Admin (legacy projects: the company's first user). Not breaking for existing API client shapes.
