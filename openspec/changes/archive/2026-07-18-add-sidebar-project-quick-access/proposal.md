## Why

Switching projects today means backing out to the `/projects` list and clicking
in again — even for the handful of projects a user opens every day. The sidebar
carries only the *current* project's navigation; it has no cross-project quick
switch. Now that Settings moved to the sidebar footer there is room for a light
project quick-access region. Users asked for this to follow their account
(cross-device), not be pinned to one browser.

## What Changes

- **New account-level quick-access region in the left sidebar** — one merged
  list showing *pinned* projects (float to the top, pin icon, no cap, ordered by
  when pinned) followed by *recently-visited* projects (up to 5, most-recent
  first). A project that is pinned is excluded from the recent list (no
  duplicates). Each row shows the project name with its project-group name as a
  small sub-line underneath.
- **Placement** — present on every dashboard page. On global pages
  (`/projects`, `/project-groups/*`, `/settings`) it is expanded by default; when
  inside a project the sidebar leads with the current project's navigation and
  the quick-access region collapses to a single "Projects" header row the user
  clicks to expand. The collapsed/expanded choice is remembered (localStorage —
  a pure view-state preference, not the data). Rendered identically in the
  desktop `<aside>` and the mobile `<Sheet>` drawer.
- **Pin / unpin affordances** — a pin toggle appears on each sidebar quick-access
  row (revealed on hover / focus) and on each project card in the `/projects`
  list.
- **Automatic visit tracking** — entering any project sub-page
  (`/projects/{uuid}/*`) records a visit for the signed-in user, which feeds the
  recent list.
- **Account-level persistence (server-side, cross-device)** — recent + pinned
  state is stored per user in the database, not in `localStorage`, so it follows
  the account across browsers and devices. **BREAKING**: none — additive schema +
  new REST endpoints only.

## Capabilities

### New Capabilities

- `sidebar-project-quick-access`: The account-level recently-visited + pinned
  project quick-access region in the sidebar — its data model, the REST surface
  that reads the aggregate and mutates pins / records visits, and the sidebar +
  projects-list UI behavior (merged list, pin/recent rules, placement,
  collapse-in-project, both themes, both layouts).

### Modified Capabilities

<!-- None — this is a net-new capability. The existing sidebar navigation
     requirements are unchanged; this adds a region beneath them. -->

## Impact

- **Database**: new `ProjectVisit` Prisma model (one row per `(user, project)`
  with `lastVisitedAt` + nullable `pinnedAt`), `relationMode = "prisma"`, DDL-only
  migration (no backfill).
- **Service layer**: new `project-visit.service.ts` (record visit, pin, unpin,
  read sidebar aggregate), company + user scoped.
- **REST**: new routes under `src/app/api/project-visits/` (GET aggregate, POST
  record-visit, PUT/DELETE pin) — user-authenticated.
- **Frontend**: `src/app/(dashboard)/layout.tsx` (`SidebarContent`) gains the
  quick-access region + a visit-recording effect keyed on the URL project UUID;
  new `src/components/sidebar-project-quick-access.tsx`; a pin control added to
  `/projects` cards; a small localStorage helper for the in-project
  collapse/expand view-state.
- **i18n**: new keys in all four locale files (`en`, `zh`, `ko`, `ja`).
- **Docs**: `docs/design.pen` updated for the new sidebar region.
