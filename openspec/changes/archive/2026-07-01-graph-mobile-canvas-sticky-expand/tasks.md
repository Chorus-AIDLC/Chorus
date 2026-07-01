# Tasks — Graph Mobile Canvas + Sticky Search-Clear Expand

## 1. Canvas touch gestures (pinch + double-tap)
- [ ] 1.1 Track active pointers in a ref; arbitrate 1-pointer pan/tap vs 2-pointer pinch (D1)
- [ ] 1.2 Two-finger pinch: midpoint-anchored zoom + pan-to-follow, reusing the `[0.2, 2.5]` clamp (D1, q2=a)
- [ ] 1.3 Double-tap: zoom-in on tap point / reset to fit toggle; do not double-fire a node click (D2, q1=b)
- [ ] 1.4 Keep `touch-action: none`; ensure two-finger gesture is not treated as a tap (D3)
- [ ] 1.5 Tests: two-finger move zooms within clamp; double-tap zooms then resets; double-tap does not open a panel; mouse wheel/drag unchanged

## 2. Abandon outline; canvas on all viewports
- [ ] 2.1 Replace the `useIsMobile()` render fork with an unconditional canvas render (D4, q4)
- [ ] 2.2 Delete `mindmap-outline.tsx`; remove its import; update the `node-status.ts` comment
- [ ] 2.3 Delete `resource-graph-outline.test.tsx` and `mindmap-outline-search.test.tsx`; drop outline assertions from shared tests
- [ ] 2.4 Verify one-time `fitToView` frames the whole tree on a narrow viewport (q7=a)

## 3. Collapsible mobile control panel
- [ ] 3.1 Collapse the control card to an icon button on a narrow viewport; expand on tap; desktop unchanged (D5, q6=a)
- [ ] 3.2 Toggle is local UI state only — never mutates query / filter / expand sets
- [ ] 3.3 Add `graph.controls.*` i18n key(s) in `en` and `zh`; use shadcn `<Button>`
- [ ] 3.4 Tests: collapsed by default on mobile, expands on tap, preserves search/filter/expand state

## 4. Sticky search-clear expansion
- [ ] 4.1 Remove the snapshot/restore effect and `expandSnapshotRef`/`wasSearchingRef` plumbing (D6, q3=a)
- [ ] 4.2 On search-clear, reset only cursor/camera (`currentMatchIndex`, `centerNodeId`); leave expand sets intact
- [ ] 4.3 Tests: search auto-expands → clear keeps hubs expanded; highlight/dim/count/cursor cleared; manual collapse still works after clear

## 5. Verification
- [ ] 5.1 `pnpm lint`, `npx tsc --noEmit`, `pnpm test` (graph suite) all green; coverage thresholds hold
- [ ] 5.2 Manual e2e: touch-emulated pinch + double-tap zoom; mobile control-panel collapse; search-clear stickiness; desktop regression check (wheel/drag, hover tooltip, search nav)
- [ ] 5.3 Update `docs/design.pen` for the mobile canvas + collapsed control panel
