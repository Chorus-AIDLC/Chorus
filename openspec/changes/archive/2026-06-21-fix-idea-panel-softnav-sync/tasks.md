# Tasks

## 1. Fix panel-URL sync + Suspense + regression tests

- [ ] 1.1 Rewrite `usePanelUrl` to derive `selectedId` / `selectedTab` from `useSearchParams()`; route `openPanel` / `closePanel` / `switchTab` through `router.replace` (preserving unrelated query params); remove the redundant `popstate` listener.
- [ ] 1.2 Wrap `IdeaTracker` in a `<Suspense>` boundary in `dashboard-content.tsx` with a no-layout-jump fallback.
- [ ] 1.3 Verify all four soft-nav entry points (notification popup, SSE toast, global search, agent-presence rows/turn-band) open/switch the panel while already on the Dashboard, and that back/forward + `?tab=` still work and the tracker view is not reset.
- [ ] 1.4 Add a unit test for `usePanelUrl` (searchParams change → selection change) and an e2e regression for "stay on Dashboard → click a notification idea link → panel switches".
- [ ] 1.5 `pnpm build` shows no `useSearchParams` CSR-bailout warning; `pnpm lint`, `npx tsc --noEmit`, and `pnpm test` pass.
