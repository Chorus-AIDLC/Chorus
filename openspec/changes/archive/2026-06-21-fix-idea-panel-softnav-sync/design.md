# Technical Design: Idea panel URL sync on soft navigation

## Overview

The Dashboard renders the idea detail panel from a single piece of client state, `selectedId`, owned by the `usePanelUrl` hook. The panel is opened/switched by reflecting `?panel=<ideaUuid>` into the URL. Today `selectedId` is a local `useState` that only re-syncs on `popstate`; App Router soft navigation does not fire `popstate`, so external `router.push('?panel=…')` links change the URL but not `selectedId`.

The fix makes the URL the source of truth for the selection by reading `useSearchParams()`, which the App Router updates reactively on every navigation kind. The hook's imperative API (`openPanel` / `closePanel` / `switchTab`) is preserved so in-app callers are unaffected.

## Root cause (verified against code)

`src/hooks/use-panel-url.ts`:
- `const [selectedId, setSelectedId] = useState(initialSelectedId ?? null)` — `initialSelectedId` (from the server `page.tsx` reading `searchParams.panel`) is a `useState` **initializer**; it is ignored on every render after the first mount. So while already on the Dashboard, changing `?panel=` never updates `selectedId`.
- The only post-mount sync path is a `popstate` listener (browser back/forward). `router.push` / `<Link>` soft navigation updates the URL via the App Router without dispatching `popstate`, so the listener never runs.

The four external entry points all build `/projects/{p}/dashboard?panel={ideaUuid}` and navigate via soft nav, so all four hit the same dead path:
- `src/components/notification-popup.tsx` → `getEntityPath()` + `router.push` (`handleClickNotification`).
- `src/contexts/notification-context.tsx` → toast action `router.push(getEntityPath(...))`.
- `src/components/global-search.tsx` → `navigateToResult` `router.push`.
- `src/components/agent-presence/hooks.ts` `execHref()` → consumed by `execution-row.tsx` and `chat/turn-band.tsx` (rendered as links/anchors → soft nav).

The in-app callers already work because they call the hook's `openPanel` directly (e.g. `idea-tracker.tsx` `onIdeaClick={openPanel}`, `IdeaDetailPanel onNavigate={openPanel}`), which updates local state. The bug is exclusively on the URL→state direction for soft nav.

## Approach (chosen: A — derive from useSearchParams)

Rewrite `usePanelUrl` so the URL drives the state:

1. Read the live params with `const searchParams = useSearchParams()`.
2. Derive selection directly: `const selectedId = searchParams.get("panel")` and `const selectedTab = searchParams.get("tab")`. No `useState` mirror for these (eliminates the stale-initializer and dual-source-of-truth classes of bug at once).
3. `openPanel(id, tab?)` / `closePanel()` / `switchTab(tab)` continue to update the URL. They should push the change through the router so `useSearchParams()` re-renders the subtree:
   - Use `router.replace(buildUrl(...))` (App Router) so the param change is observable to `useSearchParams()` while keeping a single history entry (matching the current `history.replaceState` semantics — these are programmatic panel toggles, not new history destinations).
   - `buildUrl` keeps preserving unrelated query params (filters, etc.), unchanged from today.
4. Drop the manual `popstate` listener — `useSearchParams()` already reflects back/forward, so the listener becomes redundant (and removing it avoids double-handling).

Rationale for A over B/C (from elaboration):
- **B (controlled initial prop):** relies on the RSC re-render delivering a new prop on every `?panel=` change and introduces an `openPanel`-vs-prop race; more moving parts than reading the param directly.
- **C (fix each entry):** would touch 4 call sites and require a new cross-component channel to reach `openPanel`; largest blast radius for a one-line-root-cause bug.

## Suspense boundary (Next 15 requirement)

`useSearchParams()` must be under a `<Suspense>` boundary, or Next 15 opts the whole route into client-side rendering and emits a build-time warning. `IdeaTracker` is the component that owns `usePanelUrl`, mounted by `dashboard-content.tsx`. Wrap the `<IdeaTracker .../>` element in `<Suspense fallback={…}>`:
- The fallback should be a lightweight skeleton/empty placeholder matching the tracker's container so there is no layout jump (the real content hydrates immediately on the client).
- Keep the boundary as tight as practical (around `IdeaTracker`, not the whole page header) so the static header still streams.

## No-remount invariant (must preserve)

The hook file header documents why `?panel=` uses query params rather than path segments: App Router intercepts **pathname** changes and remounts, but **query-param** changes do not remount. The fix keeps navigation on the same `pathname` and only mutates the query string, so:
- The `IdeaTracker` subtree is **not** remounted on panel switch — list scroll position, view mode (ideas/lineage/stats), and other transient state survive.
- `?tab=` keeps working alongside `?panel=` (both derived from the same `searchParams`).

A regression check on this invariant: switching `?panel=` must not reset the segmented view control or list scroll.

## Module contracts

`usePanelUrl(basePath, initialSelectedId?)` keeps its return shape exactly: `{ selectedId, selectedTab, openPanel, closePanel, switchTab }`. `initialSelectedId` becomes advisory (the SSR-rendered first paint can still use it if needed) but is no longer the long-lived source of truth — `useSearchParams()` is. Callers (`idea-tracker.tsx`) need no signature changes.

## Implementation plan

1. Rewrite `usePanelUrl` to derive `selectedId` / `selectedTab` from `useSearchParams()`; route `openPanel` / `closePanel` / `switchTab` through `router.replace` (preserving unrelated params via `buildUrl`); remove the `popstate` listener.
2. Add a `<Suspense>` boundary around `IdeaTracker` in `dashboard-content.tsx` with a no-layout-jump fallback.
3. Manually verify all four soft-nav entry points switch the panel while already on the Dashboard.
4. Add a unit test for `usePanelUrl` (URL change → selection change) and an e2e regression (notification idea link → panel switches).

## Risks & Mitigations

- **Risk:** `router.replace` triggers an RSC round-trip (more work than a bare `history.replaceState`), adding latency or a flash on panel toggle. **Mitigation:** the page is already mounted and the panel fetches its own data client-side; query-only nav does not remount. If a perceptible delay appears, fall back to `window.history.replaceState` for the write path while still reading from `useSearchParams()` for the read path (the read path is what fixes the bug; the write path can stay imperative).
- **Risk:** Missing/incorrect `<Suspense>` placement degrades the route to CSR. **Mitigation:** verify with `pnpm build` (no `useSearchParams` CSR-bailout warning) and confirm the header still SSRs.
- **Risk:** Removing `popstate` regresses back/forward. **Mitigation:** the e2e/manual check includes browser back/forward; `useSearchParams()` is documented to update on back/forward.
- **Risk:** Deriving `selectedId` without local state changes referential identity each render. **Mitigation:** `selectedId` is a primitive string compared by value downstream; no memo dependency relies on a stable object identity here.
