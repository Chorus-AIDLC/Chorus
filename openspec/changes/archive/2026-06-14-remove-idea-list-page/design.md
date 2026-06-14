# Design — Remove Idea List page, redirect RESTful idea URLs

## Context

Two parallel idea surfaces exist today:

| Surface | Route | Status |
|---|---|---|
| Dashboard Idea Tracker | `/projects/[uuid]/dashboard` (+ `?panel={id}`) | canonical |
| Idea List page | `/projects/[uuid]/ideas`, `/ideas/[ideaUuid]` | redundant → remove |

The Dashboard already has the canonical deep-link scheme. `usePanelUrl` uses
query params `?panel={id}&tab={tab}` (path changes would trigger soft-nav
remounts). `dashboard/[ideaUuid]/page.tsx` already redirects the path form to
`?panel=`. So the idea detail "address" we redirect to is
`/projects/[uuid]/dashboard?panel={ideaUuid}`.

## Directory analysis (what is safe to delete)

`grep` of importers establishes the boundary:

**Delete (only used by the `/ideas` routes themselves):**
- `ideas/page.tsx`, `ideas/[ideaUuid]/page.tsx`
- `ideas/ideas-page-content.tsx` (imported only by the two page.tsx)
- `ideas/ideas-list.tsx`, `ideas/idea-create-form.tsx` (imported only by ideas-page-content)

**Keep (imported by Dashboard panels / proposals page — NOT route-only):**
- `ideas/actions.ts` → used by `dashboard/panels/idea-detail-panel.tsx`
- `ideas/[ideaUuid]/elaboration-actions.ts` → `dashboard/panels/elaboration-view.tsx`, `components/elaboration-panel.tsx`
- `ideas/[ideaUuid]/activity-actions.ts` → `dashboard/panels/activity-timeline.tsx`
- `ideas/[ideaUuid]/actions.ts` → idea CRUD server actions
- `ideas/assign-idea-modal.tsx` → `dashboard/panels/{basic-view,idea-detail-panel}.tsx`
- `ideas/idea-detail-panel.tsx` → `proposals/[proposalUuid]/source-ideas-card.tsx`

Once `page.tsx` files are gone the directory is no longer a reachable route;
the surviving files are just colocated shared modules. Migrating them under
`dashboard/` would be cleaner namespacing but touches every importer for no
functional gain and is explicitly out of scope.

## Redirect contract (middleware)

All redirects live in `src/middleware.ts` (it already owns the legacy
`?idea=`/`?task=` redirects at the top of `middleware()`). HTTP **308**
(permanent, preserves method) — the list page is permanently gone.

Order matters: the idea redirects must run before auth handling so a logged-out
hit still lands on the right post-login destination, matching the existing
legacy-redirect placement.

```
GET /projects/:p/ideas            → 308 /projects/:p/dashboard
GET /projects/:p/ideas/:ideaUuid  → 308 /projects/:p/dashboard?panel=:ideaUuid
# legacy, updated to skip the two-hop:
GET /projects/:p/ideas?idea=:id   → 308 /projects/:p/dashboard?panel=:id
```

Regex sketch (UUID-agnostic segment match, mirrors existing style):
- `^/projects/([^/]+)/ideas$` (with or without `?idea=`)
- `^/projects/([^/]+)/ideas/([^/]+)$`

The matcher in `middleware.ts` config must include `/projects/:path*` (it
already does, since the legacy redirect works there). Preserve any unrelated
query params on the list-page redirect (e.g. `status`, `assignedToMe`) is NOT
required — those filters don't exist on the Dashboard; drop them.

## Nav + internal links

- `(dashboard)/layout.tsx` `getProjectNavItems`: remove the `ideas` entry. Order
  becomes Overview → Documents → Proposals → Tasks → Activity.
- Internal link sites changed to point straight at the Dashboard (not relying on
  the redirect):
  - `components/global-search.tsx:203` → `/projects/{p}/dashboard?panel={uuid}`
  - `components/notification-popup.tsx:130` → `${base}/dashboard?panel={entityUuid}`
  - `contexts/notification-context.tsx:69` → `${base}/dashboard?panel={entityUuid}`
  - `dashboard/idea-tracker-stats.tsx:107` ("Total Ideas" card href) → `/projects/{p}/dashboard`
  - `components/page-transition.tsx`: the `/ideas/[ideaUuid] → /ideas` parent-path
    rule for exit animation is now dead; remove or repoint so it doesn't
    mis-key transitions on the now-removed route.

## i18n

- `nav.ideas` (en `"Ideas"`, zh `"想法"`/equivalent) becomes unreferenced once the
  nav item is removed → delete from both `messages/en.json` and `messages/zh.json`.
- Verify no other consumer of `nav.ideas` remains before deleting (grep).
- Surgical string edits only — these locale files have known duplicate keys, so a
  full JSON round-trip would drop keys.

## Testing

- **Unit**: a pure redirect-mapping test (and/or middleware test) asserting the
  three URL → target mappings, including that `/ideas/{id}` maps to
  `?panel={id}` and legacy `?idea={id}` collapses to one hop.
- **e2e (Playwright)**: navigate to `/projects/{p}/ideas` and
  `/projects/{p}/ideas/{ideaUuid}`, assert the browser lands on `/dashboard`
  and `/dashboard?panel={ideaUuid}` respectively; assert the sidebar has no
  `Ideas` item; assert 0 console errors. Per the project `e2e-verification` skill.

## Risks

- A missed internal `/ideas/...` link would still work (redirect catches it) but
  cost an extra hop — mitigated by the grep sweep in scope.
- Deleting a file that turns out to have an external importer → TypeScript build
  fails fast; the pre-delete grep + `tsc --noEmit` gate catches it.
