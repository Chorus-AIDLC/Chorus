# Persist project-list group expand/collapse state across visits

## Why

On the project list page (`/projects`), projects are shown grouped by
ProjectGroup, and each group card can be expanded or collapsed. Today the
expand state is hardcoded: the page passes `defaultOpen={index === 0}` to each
group, so **only the first group is expanded on every load** and the "Ungrouped"
section always starts collapsed. Each group's open/collapsed boolean lives in
its own `useState` initialized once at mount — nothing is persisted. If a user
expands other groups (or collapses the first), that choice is lost the next time
they open the page; the list always resets to "first group only."

This is a small but recurring papercut for anyone who works out of a group other
than the top one: every visit re-hides the group they care about.

## What Changes

- The project-list page **remembers which groups the user has expanded** and
  restores that state on the next visit, so the page comes back the way the user
  left it instead of resetting to "first group only."
- State is persisted **client-side in `localStorage`** (per browser), matching
  the existing `chorus_projects_view_mode` toggle already on this page
  (elaboration Q1 = a). No server, API, or data-model change.
- The empty-state default — for a user who has never toggled anything, or for a
  newly-created group that isn't in the saved state — is **collapsed**
  (elaboration Q2 = b). This replaces today's "first group auto-expands"
  behavior: on a first visit (or after clearing storage) every group starts
  collapsed until the user opens one.
- The **"Ungrouped" section is remembered too**, like any real group
  (elaboration Q3 = a), keyed by a stable sentinel.
- The `defaultOpen`/`index === 0` special-casing of the first group is removed —
  open state is driven entirely by the persisted set.

## Capabilities

### Added Capabilities

- `project-list-group-expansion`: the project-list page SHALL persist each
  group's (and the Ungrouped section's) expand/collapse state in `localStorage`
  and restore it on the next visit, defaulting untracked groups to collapsed, so
  the page reopens the way the user left it.

## Impact

- **UI (client only)** — `src/app/(dashboard)/projects/page.tsx`
  (`ProjectsPage`, `GroupSection`, `UngroupedSection`): lift open-state into the
  page, drive it from a persisted set of expanded keys, drop `defaultOpen`.
- **New helper** — `src/app/(dashboard)/projects/group-expansion-preference.ts`:
  small SSR-safe `readExpandedGroups()` / `writeExpandedGroups()` localStorage
  helpers (mirrors the existing `dashboard-view-preference.ts` pattern), plus its
  unit test.
- No i18n string changes, no shadcn component additions, no schema/API/service
  change. Both light and dark themes are structurally unaffected (no color or
  layout-class change to the group cards themselves).
