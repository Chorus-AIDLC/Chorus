# Add "Remove from recent" to the sidebar Recent Projects list

## Why

The sidebar project quick-access region (shipped in `add-sidebar-project-quick-access`)
maintains the **Recent Projects** list fully automatically: the top five projects by
`lastVisitedAt`, with pinned projects excluded. The only manual control a user has over
that list today is **pin / unpin** — there is no way to say "I don't want this project
showing up in Recent."

Users want to curate the list: drop a project they visited once by accident, or clear
out a project they're done with, without having to pin something else to push it out.
This change adds a lightweight, thought-through **manual remove** affordance.

## What Changes

- **New row action — "Remove from recent".** Each **recent (unpinned)** row gets a
  per-row overflow menu (a `⋯` kebab) exposing `{ Pin to sidebar, Remove from recent }`.
  The kebab replaces the always-hover-revealed pin button on recent rows only.
- **Pinned rows are unchanged.** Pinned rows keep their existing one-tap pin (unpin)
  button — they do NOT get the overflow menu. The two row types intentionally differ:
  recent rows carry a menu, pinned rows carry a direct unpin toggle.
- **Soft-remove semantics.** "Remove from recent" deletes the user's `ProjectVisit` row
  for that project (only when it is not pinned). The project is simply forgotten from
  recency — the next time the user visits it, it naturally returns to the recent list.
  No permanent "hidden" state, no `dismissedAt` field, no schema migration.
- **No undo toast, no confirm dialog.** Removal is silent — the row just disappears. The
  safety net is the soft-remove semantics themselves (re-visiting brings it back).
- **Mobile parity.** In the mobile drawer, the `⋯` button is always visible (desktop
  reveals it on hover/focus), tapped to open the same menu. The pinned-row pin button is
  likewise always visible on mobile, matching the existing behavior.
- **New "forget visit" backend action.** A `DELETE /api/project-visits` route + a
  `forgetVisit` service function delete the `(user, project)` visit row — gated so a
  **pinned** project's row is never deleted. The shared quick-access provider gains a
  `remove(projectUuid)` method that calls it and replaces state with the fresh aggregate,
  so every surface (sidebar, `/projects` cards) stays in sync with no reload.

## Capabilities

- `sidebar-project-quick-access` — extended with a "Remove a project from the recent
  list" requirement (ADDED).

## Impact

- **Frontend:** `src/components/sidebar-project-quick-access.tsx` (recent-row action area
  → shadcn `DropdownMenu`; pinned rows untouched);
  `src/contexts/project-quick-access-context.tsx` (new `remove` method); i18n keys
  `quickAccess.removeFromRecent`, `quickAccess.pinToSidebar`, `quickAccess.moreActions`
  added to all four locales (en / zh / ko / ja), locale-parity test must pass.
- **Backend:** `src/app/api/project-visits/route.ts` (new `DELETE`);
  `src/services/project-visit.service.ts` (new `forgetVisit`). No schema change — the
  existing `ProjectVisit` model is sufficient (delete the row).
- **Tests:** service unit tests for `forgetVisit` (pinned-guard, no-op safety,
  company-scope); route tests for `DELETE` (200 fresh aggregate, 401, 403 agent, 422
  missing uuid).
- **Verification:** light + dark theme, desktop aside + mobile drawer, all four
  combinations. design.pen per owner convention (the parent feature waived it).
- **No breaking changes.** Pin / unpin / visit routes and the merged-list rendering are
  preserved; this is purely additive.
