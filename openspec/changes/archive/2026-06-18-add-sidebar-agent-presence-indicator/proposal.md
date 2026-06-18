# Sidebar Online-Agent Presence Indicator

## Why

Today the only way to answer "is my daemon online — is anything actually picking
up the work I dispatched?" is to navigate to the standalone `/agent-connections`
page. That is a high-frequency, glance-worthy signal buried in a second-level
route. It should be a resident, global, low-cost fixture of the shell.

This idea (`8f7bb356`) is the third consumer of the daemon connection-observability
layer (siblings: the redesigned page `f803d5d3`, the @-mention liveness dot
`999ddd93`). Elaboration (3 rounds, recorded on the idea) expanded the original
"just show an online count" scope into a **mini live daemon view in the sidebar**,
and converged on a deliberate product simplification: **collapse to a single entry
point.** The standalone `/agent-connections` page is removed; everything it does —
the master-detail connection list, the live running/queued execution state (子2),
and the interrupt/resume controls (子3) — moves behind one resident sidebar
indicator that opens a popover, with a "View all" modal for the full view.

## What Changes

1. **Resident presence pill** in the `(dashboard)` sidebar, directly above the
   user-profile block (and in the mobile drawer). A small pill with a pulsing
   green dot + online count + label (e.g. "2 online"). The count counts **online
   connections only**. It has three distinct, non-silent states: idle ("0 online",
   static grey dot), loading (muted placeholder), and request-failed (a
   distinguished unavailable state — never masquerading as "0 online").

2. **Click-to-open popover** (shadcn `Popover`, not a hover tooltip) — a mini live
   daemon view. Lists each **online** connection, and under each, its current
   `running` / `queued` executions (task title, root-idea session label,
   running|queued, elapsed). Reuses the existing page's rendering vocabulary
   (agent name primary, client type badge, pulsing dot, monospace elapsed). A task
   row deep-links to its entity (task/idea). A footer "View all" action opens the
   modal.

3. **"View all" modal** (shadcn `Dialog`) — the full former page, relocated. Houses
   the master-detail connection list + execution state + interrupt/resume controls,
   at full capability parity with the page being removed.

4. **Remove the standalone `/agent-connections` page and its sidebar nav item.**
   The route and the `RadioTower` global-nav entry go away; the page's component is
   refactored into the modal body. A redirect preserves any external/bookmarked
   links.

5. **New aggregate read endpoint `GET /api/daemon/executions`** — a ~20-line route
   wrapping the already-written-but-unexposed `getVisibleExecutions(auth)` service
   function (owner-scoped, no N+1). Needed only for the **first-paint aggregate**
   of "everything running across all my connections"; live increments already flow
   over the existing `/api/events` SSE channels.

6. **Shared presence data provider** mounted in the dashboard layout shell, feeding
   both the pill and the modal from one polling loop + one SSE subscription —
   zero duplicate requests.

### Capabilities touched

- `agent-connection-observability` (**MODIFIED**): the observability surface changes
  from a standalone page to a sidebar indicator + popover + modal; a new aggregate
  executions read endpoint is added.
- `daemon-execution-state` (**MODIFIED**): the execution running/queued view, which
  the spec previously located in the page's detail pane, now also drives the sidebar
  popover and is sourced for first paint by the new aggregate endpoint.

## Impact

- **Frontend-heavy, one small additive backend route.** No schema change, no
  migration, no new permission bit, no change to SSE routes or the registry write
  path. The new endpoint reuses existing owner-scoped service logic.
- **Deliberate walk-back of two recently-shipped surfaces.** The page redesign
  (`f803d5d3`) and interrupt/resume controls (`4c9b3bca` / 子3) are relocated from a
  standalone route into the modal — confirmed intended by the idea owner. Net
  capability is preserved (parity), entry points reduced from two to one.
- **Affected code**: `src/app/(dashboard)/layout.tsx` (pill + provider + nav-item
  removal), the `agent-connections/page.tsx` component (refactored into a modal
  body), `src/contexts/` (new presence provider), `src/app/api/daemon/executions/`
  (new route), `messages/{en,zh}.json` (i18n), and the removed route's redirect.
- **Out of scope**: connection management verbs beyond the existing interrupt/resume;
  transcript panels; second-level SSE for connection online/offline liveness (count
  stays poll-driven at the existing 15s cadence, consistent with today's page).
