## Context

The sidebar (`src/app/(dashboard)/layout.tsx` → `SidebarContent`) is a
client component rendered in both a 220px desktop `<aside>` and a mobile
`<Sheet>` drawer. It already derives the current project UUID from the URL
(`extractProjectUuid(pathname)`) and switches between project-context nav and
global nav. Settings + preferences live in the bottom footer.

Elaboration resolved these decisions:

- **Storage = account-level (server-side, cross-device)** — the load-bearing
  choice. Recent + pinned are per-user DB rows, not `localStorage`.
- **Placement = everywhere, but expandable in-project** — expanded on global
  pages, collapsed to a header row inside a project.
- **Recent count = 5**, excluding pinned.
- **Pins = unlimited, ordered by pin time** (no drag reorder).
- **Layout = one merged list** — pinned float to top with a pin icon, recent
  below.
- **Dedupe = pinned excluded from recent.**
- **Group context = project-group name as a small sub-line** under the name.

The feature is **user-only**. Agents authenticate via API keys and never render
this sidebar, so the data model is keyed on `User`, not the polymorphic
`ownerType/ownerUuid` pair `NotificationPreference` uses.

## Goals / Non-Goals

**Goals**

- One place in the sidebar to reach frequently- and recently-used projects, one
  click to switch, consistent across devices.
- Additive: no change to existing sidebar nav requirements; no change to core
  entity models.

**Non-Goals**

- Drag-to-reorder pins (explicitly deferred — pins order by pin time).
- A recent-count or pin-cap setting UI (fixed at 5 recent, unlimited pins).
- Cross-company or team-shared quick-access (strictly per-user, company-scoped).
- Migrating existing local view-preferences to the server.

## Data Model

New Prisma model (relationMode = "prisma", so no DB-level FK; cascade handled at
the app level consistent with the rest of the schema):

```prisma
// Per-user project quick-access state: recency + pin. One row per (user, project).
model ProjectVisit {
  id            Int       @id @default(autoincrement())
  uuid          String    @unique @default(uuid())
  companyUuid   String
  userUuid      String
  projectUuid   String
  lastVisitedAt DateTime  @default(now()) // updated on every project-page entry
  pinnedAt      DateTime? // non-null = pinned; ordering key for the pinned list
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([userUuid, projectUuid])
  @@index([companyUuid])
  @@index([userUuid, pinnedAt])
  @@index([userUuid, lastVisitedAt])
}
```

- **Recent list** = rows for the user where `pinnedAt IS NULL`, ordered by
  `lastVisitedAt DESC`, take 5.
- **Pinned list** = rows where `pinnedAt IS NOT NULL`, ordered by `pinnedAt ASC`
  (earliest-pinned first, stable), unlimited.
- A project appears in at most one list (pinned wins), satisfying the dedupe rule
  for free — the recent query filters `pinnedAt IS NULL`.
- A row can exist with `pinnedAt` set but a stale `lastVisitedAt`; that is fine —
  pinning a never-visited project (from the `/projects` card) upserts a row with
  `pinnedAt` set and `lastVisitedAt = now()`.
- **Deleted project / stale rows**: because relationMode is "prisma" there is no
  cascade from `Project` delete. The read aggregate LEFT-resolves each visit row
  against live projects (a single `project.findMany` on the collected UUIDs,
  company-scoped) and drops any visit whose project no longer exists or is in
  another company — so a deleted project silently disappears from the sidebar and
  stale rows are harmless (never surfaced). No background cleanup needed for v1.

## Service Layer — `project-visit.service.ts`

All functions take `companyUuid` + `userUuid` and are company/user scoped.

- `recordVisit(companyUuid, userUuid, projectUuid)` — verify the project exists
  in the company; upsert the `(userUuid, projectUuid)` row setting
  `lastVisitedAt = now()` (leaves `pinnedAt` untouched). No-op-safe to call on
  every navigation. Returns nothing meaningful (fire-and-forget from the client).
- `pinProject(companyUuid, userUuid, projectUuid)` — verify project; upsert row
  with `pinnedAt = now()` if not already pinned (idempotent — re-pinning does not
  move it). Sets `lastVisitedAt` on create so the row is well-formed.
- `unpinProject(companyUuid, userUuid, projectUuid)` — set `pinnedAt = null` on
  the row if present (the project falls back into the recent list on its next
  read if its `lastVisitedAt` is recent enough). Idempotent.
- `getSidebarQuickAccess(companyUuid, userUuid)` — returns
  `{ pinned: ProjectRef[], recent: ProjectRef[] }` where
  `ProjectRef = { uuid, name, groupUuid, groupName }`. Resolves project + group
  names in bulk (two `findMany`s, company-scoped), drops visits whose project is
  gone. `groupName` is null for ungrouped projects. **Filter-then-cap**: live
  projects are resolved and stale/foreign visits dropped *before* the recent list
  is capped at 5 — never `take(5)` at the DB layer before filtering, or a deleted
  newest project would consume a slot and under-fill the visible recent list
  below 5.

`recordVisit` / `pinProject` verify company ownership of the project before
writing, so a forged `projectUuid` from another company cannot create a row.

## REST Surface — user-authenticated

Under `src/app/api/project-visits/`. All routes use `withErrorHandler` +
`getAuthContext` and require a **user** context (`isUser`) — this is a human-only
surface; agents get 403. Standard `{ success, data }` envelope.

| Method + path | Body | Action |
|---|---|---|
| `GET /api/project-visits` | — | `getSidebarQuickAccess` → `{ pinned, recent }` |
| `POST /api/project-visits/visit` | `{ projectUuid }` | `recordVisit` → `{ ok: true }` |
| `PUT /api/project-visits/pin` | `{ projectUuid }` | `pinProject` → updated aggregate |
| `DELETE /api/project-visits/pin` | `{ projectUuid }` | `unpinProject` → updated aggregate |

Pin/unpin return the fresh `{ pinned, recent }` aggregate so the client updates
in one round-trip without a follow-up GET. `visit` returns a minimal ack (the
client does not need the aggregate on every navigation; the sidebar re-fetches
on its own cadence — see below).

## Frontend

### Shared state — `project-quick-access-context.tsx`

The quick-access aggregate is owned by **one** client provider mounted once in
`(dashboard)/layout.tsx`, wrapping the whole shell (like the other shell-level
providers). This is the single source of truth so a mutation from *any* surface —
a sidebar row, a `/projects` card pin, or the visit hook — updates the same state
and every consumer re-renders with no page reload.

Why a provider and not per-component fetches: the sidebar region lives in the
persistent layout and would otherwise only re-fetch on mount + SSE
`project`/`project_group` events. But visit-POST and card pin PUT/DELETE emit no
such events, so on `/projects` (where the expanded region sits right next to the
cards) pinning a card or visiting a project would not appear in the sidebar until
a full reload. A shared provider closes that gap.

The provider:

- GETs `/api/project-visits` on mount; re-fetches on
  `useRealtimeEntityTypeEvent(["project","project_group"])` (covers
  create/rename/delete of projects from elsewhere).
- Exposes `{ pinned, recent }`, `pin(projectUuid)` / `unpin(projectUuid)` (call
  PUT/DELETE `/api/project-visits/pin`, then replace state with the returned fresh
  aggregate — optimistic update acceptable), `recordVisit(projectUuid)` (POST the
  visit then refresh/locally bump), and an `isPinned(projectUuid)` selector.

### Quick-access region — `sidebar-project-quick-access.tsx`

A client component rendered inside `SidebarContent` (both desktop + mobile),
below the nav block and above the footer. Props: `{ mobile, collapsedInProject }`.
It **consumes the provider** (no fetch of its own).

- Renders one merged list: pinned rows first (pin icon filled), then recent rows.
- Each row: a `Link` to `/projects/{uuid}/dashboard`, project name (single line,
  truncate), group name as a `text-[11px] text-muted-foreground` sub-line when
  present, and a pin toggle button revealed on `hover`/`focus-within` (filled pin
  = pinned → click unpins; outline pin = recent → click pins). Pin/unpin goes
  through the provider so the change is reflected everywhere at once.
- Empty state: if there are no pinned and no recent rows, render nothing (no
  empty header noise) on global pages; in-project the collapsed header still
  shows so the region is discoverable.

### Placement + collapse-in-project

- `SidebarContent` computes `isProjectContext` already. Pass
  `collapsedInProject = isProjectContext` to the region.
- When `collapsedInProject`, the region renders a single clickable "Projects"
  header row with a chevron; expanded state is held in local component state
  seeded from a small localStorage helper
  (`sidebar-quick-access-collapse-preference.ts`, mirroring
  `group-expansion-preference.ts`: SSR-safe, degrade-on-throw). This is view
  state, not the account data — localStorage is the right home for it.
- On global pages the region is always expanded (no header toggle).

### Visit recording

In `SidebarContent` (or a tiny `useRecordProjectVisit(currentProjectUuid)` hook),
a `useEffect` keyed on `currentProjectUuid` fires `POST /api/project-visits/visit`
once per distinct project UUID entered (guard with a ref so re-renders within the
same project don't spam). Fire-and-forget; failure is swallowed (best-effort,
like the localStorage helpers).

### Pin entry on `/projects` cards

The project card in `src/app/(dashboard)/projects/page.tsx` gains a pin toggle
(icon button, top-right of the card). It reads pinned state via the shared
provider's `isPinned(projectUuid)` and toggles via the provider's `pin`/`unpin`
— **not** an independent fetch. Because `/projects` renders under the dashboard
layout, the provider is already mounted above it, so a card pin updates the same
aggregate the sidebar reads and shows up there immediately.

### Theming + layout

All surfaces use semantic tokens (`bg-card`, `text-foreground`,
`text-muted-foreground`, `hover:bg-secondary`, `text-primary` for the active pin)
so light/dark both work with no hardcoded hex. Verified in both themes and in the
desktop aside + mobile Sheet. The pin icon uses `lucide-react` `Pin` / `PinOff`.

## Risks / Trade-offs

- **A visit POST on every project entry** adds one lightweight write per
  navigation. Mitigation: the client dedupes by project UUID within a session
  (ref guard), and the upsert is a single indexed row write. Acceptable.
- **No pin cap** (per elaboration) means a power user could pin many projects and
  make the sidebar long. Accepted for v1; the region scrolls with the sidebar
  (`overflow-y-auto` already on the aside).
- **Stale rows for deleted projects** accumulate but are never shown (filtered at
  read). If this ever matters, a later cleanup can delete visits whose project is
  gone; out of scope now.
- **localStorage for the collapse toggle** means the in-project expand/collapse
  choice is per-device while the data is account-level. This is intentional — the
  toggle is ephemeral UI state, and mixing it into the server model would bloat it.

## Migration Plan

1. Add the `ProjectVisit` model to `schema.prisma`.
2. `pnpm db:migrate:dev` to generate the DDL-only migration; `pnpm db:generate`.
3. No backfill (per project convention — migrations are DDL-only). Existing users
   start with an empty quick-access region that populates as they navigate/pin.
