# Remove the Idea List page; keep RESTful idea URLs as redirects

## Why

Idea browsing and management have fully migrated to the project Dashboard's
Idea Tracker (`/projects/[uuid]/dashboard`): a three-way view switch
(Ideas / Lineage / Stats), status grouping, the lineage tree, and a side
detail panel opened via `?panel={ideaUuid}`. The standalone Idea List page
(`/projects/[uuid]/ideas` and `/projects/[uuid]/ideas/[ideaUuid]`) is now
redundant — it duplicates the tracker's list + detail UI, and maintaining two
idea surfaces is wasted effort and a source of drift.

We want to delete the page from the UI but **not** break the two RESTful idea
URLs: shared links, bookmarks, and external references to `/ideas` and
`/ideas/{id}` must keep working by redirecting into the equivalent Dashboard +
side-panel address.

## What Changes

- **Remove the Idea List route + its list-only UI**: delete `ideas/page.tsx`,
  `ideas/[ideaUuid]/page.tsx`, and the components used only by them
  (`ideas-page-content.tsx`, `ideas-list.tsx`, `idea-create-form.tsx`).
- **Keep shared modules in place**: `ideas/actions.ts`,
  `ideas/[ideaUuid]/{actions,elaboration-actions,activity-actions}.ts`,
  `ideas/assign-idea-modal.tsx`, and `ideas/idea-detail-panel.tsx` are imported
  by Dashboard panels and the proposals page — they stay. Removing the
  `page.tsx` files is what makes the directory stop being a reachable route.
- **Redirect the two URLs (308, in middleware)**:
  - `/projects/[uuid]/ideas` → `/projects/[uuid]/dashboard`
  - `/projects/[uuid]/ideas/[ideaUuid]` → `/projects/[uuid]/dashboard?panel={ideaUuid}`
  - Update the existing legacy `?idea={id}` redirect to land directly on
    `/dashboard?panel={id}` (no two-hop chain).
- **Remove the `Ideas` sidebar nav item** (`getProjectNavItems` in
  `(dashboard)/layout.tsx`); Overview/Dashboard becomes the single idea entry.
- **Point internal links at the Dashboard** instead of relying on the redirect:
  global search idea results, notification idea links (popup + context), and
  the Dashboard stats "Total Ideas" card.
- **i18n**: drop the now-unused `nav.ideas` key (en + zh) if no longer
  referenced; keep both locales aligned.

## Capabilities

- `idea-list-removal` — the page is gone, the two URLs redirect, the nav item
  is removed, internal links point at the Dashboard.

## Impact

- No REST API change: `/api/projects/[uuid]/ideas/*` are data endpoints, not UI
  pages, and are untouched.
- No data-model or service-layer change.
- Risk is contained to routing + link hrefs; verified by redirect unit tests
  and a Playwright e2e pass.
