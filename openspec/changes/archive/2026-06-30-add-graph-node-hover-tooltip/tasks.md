# Tasks — Resource-Graph Node Hover Tooltip

## 1. Fetch-on-hover data hook
- [ ] 1.1 `useNodeDetail` hook: debounced fetch per hovered entity (GET /api/{ideas|proposals|tasks|documents}/[uuid]), per-uuid cache, AbortController on hover change, `{ detail, loading }` output, with unit tests for debounce + cache.

## 2. Tooltip overlay + canvas wiring
- [ ] 2.1 DOM tooltip overlay component (shadcn-style): full title + status/type badge per entity type, reusing existing badge conventions; `pointer-events-none`; i18n en+zh.
- [ ] 2.2 Wire into `mindmap-canvas.tsx`: anchor from hoverId + rendered center + view transform (right edge, flip/clamp on overflow); short appear delay; clears on mouse-out; coexists with lineage highlight. Component test for content mapping + desktop-only behavior.
