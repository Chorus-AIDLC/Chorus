## Why

On the project Dashboard (Idea Tracker), clicking an idea link from a notification, the SSE toast, global search, or an agent-presence row changes the URL to `?panel=<ideaUuid>` but the right-hand idea detail panel does **not** open or switch. The URL and the visible UI fall out of sync, so the deep link silently appears broken.

The root cause is a single hook: `usePanelUrl` keeps the selected idea in local `useState` and only re-syncs it on the `popstate` event. App Router soft navigation (`router.push`) changes the URL **without** firing `popstate`, so the hook never learns the URL changed. The server-passed `initialSelectedIdeaUuid` only seeds `useState` on first mount, so navigating between `?panel=` values while already on the Dashboard never updates the panel.

## What Changes

- Make `usePanelUrl` derive its selected-panel / selected-tab state from Next.js `useSearchParams()` (the App Router source of truth that updates reactively on soft navigation), instead of from `popstate`-only local state.
- Wrap the `IdeaTracker` subtree in a `<Suspense>` boundary, as required by Next 15 for components that read `useSearchParams()` (otherwise the route opts into full client-side rendering and emits a build warning).
- Preserve the existing design intent: query-param navigation MUST NOT remount the `IdeaTracker` subtree (scroll/tab state survives), and the `?tab=` param continues to work alongside `?panel=`.
- One root fix repairs **all four** soft-navigation entry points that build `?panel=` links — notification popup, SSE notification toast, global search, and agent-presence rows/turn-band — not just the reported notification popup.
- Add regression coverage: a unit test that `usePanelUrl` updates the selection when `searchParams` change, plus an e2e test for "stay on Dashboard → click a notification idea link → the panel switches to the new idea" (today's `notification-popup.test` only asserts the pushed URL, never that the panel actually switched).

No API, schema, or data-model changes. No breaking changes — `openPanel` / `closePanel` / `switchTab` keep their existing signatures.

## Capabilities

### New Capabilities

- `idea-panel-url-sync`: The Dashboard idea side-panel selection (`?panel=` / `?tab=`) stays in sync with the browser URL across all navigation kinds — soft navigation (`router.push` / `<Link>`), back/forward, and direct load — without remounting the tracker subtree.

### Modified Capabilities

<!-- None. `idea-list-removal` covers routing/redirects to ?panel= addresses; this change concerns the reactive in-page sync of the panel to that URL, which no existing capability specifies. -->

## Impact

- **Code (changed):**
  - `src/hooks/use-panel-url.ts` — derive `selectedId` / `selectedTab` from `useSearchParams()`; keep `openPanel` / `closePanel` / `switchTab` updating the URL.
  - `src/app/(dashboard)/projects/[uuid]/dashboard/dashboard-content.tsx` (or `idea-tracker.tsx`) — add the `<Suspense>` boundary around `IdeaTracker`.
- **Code (verified fixed, no change needed):** the four `?panel=` link builders — `src/components/notification-popup.tsx`, `src/contexts/notification-context.tsx`, `src/components/global-search.tsx`, `src/components/agent-presence/hooks.ts` (consumed by `execution-row.tsx` and `chat/turn-band.tsx`).
- **Tests:** new unit test for `usePanelUrl`; new e2e regression for the notification → panel-switch flow.
- **Dependencies / APIs / data model:** none.
