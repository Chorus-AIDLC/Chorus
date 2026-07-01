# Design — Graph Mobile Canvas + Sticky Search-Clear Expand

## Context

The resource graph is three files under `graph/`:

- **`resource-graph.tsx`** owns the data (`graph`), the type filter (`visible`),
  the two-level expand state (`expandedIdeas` / `expandedProposals`), and the
  search state (`searchQuery`, `matchIds`, `currentMatchIndex`, `centerNodeId`).
  It derives `forceNodes`/`forceLinks` from `computeVisibleSet(...)` and today
  hands them to **either** `<MindMapOutline>` (when `useIsMobile()` is true,
  ≤767px) **or** `<ForceGraphCanvas>` (otherwise) at the `!isEmpty && (isMobile
  ? … : …)` fork (~line 1027). It also renders the four reused side panels
  (`IdeaDetailPanel`, `TaskDetailPanel`, `DocumentPanel`, and the idea-tracker
  Proposal tab via `openPanel`).
- **`mindmap-canvas.tsx`** is the Canvas-2D renderer. It owns `viewRef =
  { scale, tx, ty }` and paints graph→screen as `screenX = x*scale + tx`. Zoom
  is wheel-only (`handleWheel`, clamps `scale` to `[0.2, 2.5]`, anchors on the
  cursor). Pan is a single-pointer drag in `handlePointerDown/Move/Up` (a >3px
  move becomes a pan; a clean tap becomes an `onNodeClick`). A one-time
  `fitToView(layout, dims, viewRef)` runs on the first non-empty layout
  (`fittedRef` guard) and there is no auto-refit after. The `<canvas>` carries
  `className="… touch-none"` (`touch-action: none`). There is **no** double-tap
  or multi-touch handling anywhere.
- **`mindmap-outline.tsx`** is the DOM vertical indented outline used only on
  mobile. Imported solely by `resource-graph.tsx` (plus a comment reference in
  `node-status.ts`), and exercised by `resource-graph-outline.test.tsx` and
  `mindmap-outline-search.test.tsx`.

The elaboration decision is to make the canvas the **sole** rendering on all
viewports and delete the outline, then add the touch and layout adaptations that
mobile needs.

## Goals / Non-Goals

**Goals**
- Two-finger pinch zoom (midpoint-anchored, pans to follow the midpoint) and
  double-tap zoom/reset on the canvas, reusing `viewRef` and the `[0.2, 2.5]`
  clamp; single-finger pan and all mouse behavior unchanged.
- Canvas renders on every viewport; delete `mindmap-outline.tsx` and the
  `useIsMobile()` fork.
- Control card collapses to an icon on a narrow viewport, expands on tap; desktop
  unchanged.
- Tap opens the reused side panel (already the click behavior); no long-press
  tooltip; hover tooltip simply never fires on touch.
- Clearing search is sticky: remove snapshot/restore, keep expanded hubs, clear
  only pure-search visual state.

**Non-Goals**
- No rotate/zoom inertia or momentum scrolling.
- No long-press tooltip on mobile (q5=a chose tap→panel).
- No change to the aggregation service, tree-layout algorithm, SSE
  live-reconcile, node status vocabulary, or the four side panels' internals.
- No redesign of the side panels for mobile beyond what they already do
  (`w-full md:w-[480px]` is already responsive).

## Decisions

### D1 — Multi-touch pinch via pointer events, tracking active pointers

Keep the existing Pointer Events model (do not switch to `TouchEvent`). Maintain
a small map of active pointers keyed by `pointerId` in a ref, updated in
`handlePointerDown` / `handlePointerMove` / `handlePointerUp` (and
`onPointerCancel`). Gesture arbitration by active-pointer count:

- **1 active pointer** → existing drag-pan / tap logic, unchanged.
- **2 active pointers** → pinch mode. On the second pointer-down, capture the
  gesture start: the two screen points, their **midpoint** `m0`, their distance
  `d0`, and the current `viewRef`. On each move that updates either pointer,
  recompute the live midpoint `m` and distance `d`:
  - `nextScale = clamp(view0.scale * (d / d0), 0.2, 2.5)` — same clamp as wheel.
  - Anchor the zoom on the **start** midpoint's graph point (so the graph point
    under the fingers stays put) AND translate by the midpoint delta `(m - m0)`
    so the tree follows the fingers (q2=a map feel):
    `gx = (m0.x - view0.tx) / view0.scale`, similarly `gy`;
    `tx = m.x - gx * nextScale`, `ty = m.y - gy * nextScale`.
    (Because `tx`/`ty` are computed from the live midpoint `m`, the pan-follow is
    already folded into the anchor math — no separate delta term needed.)
  - `scheduleRender()`.
- Dropping from 2 → 1 pointer ends pinch; the remaining pointer does **not**
  resume a pan mid-gesture (clear the drag start so the leftover finger doesn't
  jump-pan). Dropping to 0 clears all gesture state.

A two-finger gesture must **not** be treated as a tap or fire `onNodeClick`: mark
the gesture "moved/consumed" once a second pointer joins, so `handlePointerUp`'s
clean-tap branch is skipped for both lifts.

### D2 — Double-tap zoom / reset

Track the last tap's timestamp and screen position in a ref. In the tap branch
of `handlePointerUp` (single pointer, not moved), if a previous tap occurred
within ~300ms and ~30px, treat it as a double-tap instead of a node click:

- **Toggle:** if the view is currently at (approximately) the fit scale, zoom
  **in** to a fixed target scale (e.g. `min(2.5, fitScale * 2)` or a sensible
  constant like `1.5`) centered on the tap point (reuse the wheel anchor math
  with the tap point as the cursor). Otherwise, **reset** to the fit view by
  recomputing `fitToView(layout, dims, viewRef)`.
- A double-tap on a **node** zooms rather than opening the panel — the
  double-tap is consumed; the first tap of the pair must not also fire a node
  click. Simplest correct rule: defer the single-tap `onNodeClick` slightly and
  cancel it if a second tap lands within the window, OR (preferred, simpler)
  only zoom on double-tap in empty space and let a double-tap on a node be a
  normal click + zoom — pick the deferred-click approach so a fast double-tap
  never both navigates and zooms. The implementer verifies the chosen rule with
  a test (see tasks).

> Note: `time`/window comparisons use `performance.now()` (already used in the
> render loop), not `Date.now()`.

### D3 — Release `touch-action` so the browser hands us the gestures

The `touch-none` class sets `touch-action: none`, which is actually **required**
to receive continuous multi-touch move events without the browser hijacking them
for native scroll/zoom. So we **keep** `touch-action: none` on the canvas — the
problem was never the CSS, it was the missing pinch handler. Re-confirm during
implementation that `touch-action: none` is retained (removing it would let the
browser scroll the page instead of feeding us the second pointer). The idea
description's "去掉/放开 touch-none" is superseded by this: keep it; add the
handler. This correction is the single most likely place to get the fix wrong.

### D4 — Canvas on all viewports; delete the outline

In `resource-graph.tsx`, replace the `!isEmpty && (isMobile ? <MindMapOutline …>
: <ForceGraphCanvas …>)` fork with an unconditional `<ForceGraphCanvas …>`.
Remove the `import { MindMapOutline }` and the now-unused `useIsMobile` import
**iff** no other code in the file needs it (the control-panel collapse in D5
needs a mobile signal, so `useIsMobile` stays — see D5). Delete
`mindmap-outline.tsx`. Delete `resource-graph-outline.test.tsx` and
`mindmap-outline-search.test.tsx`. Update the `node-status.ts` comment that
references the outline row. The one-time `fitToView` already frames the whole
tree on first layout for any dims, so q7 (mobile first-load fit) needs no new
code — just verify it fires on a narrow viewport.

### D5 — Control panel collapses to an icon on narrow viewports (q6=a)

The control card (`absolute right-3 top-3`) keeps its desktop form. On a narrow
viewport (reuse `useIsMobile()`), render a collapsed state: a single icon
`<Button size="icon">` (e.g. a sliders/search icon) that, when tapped, toggles a
local `panelOpen` boolean revealing the full card (search + filter +
expand/collapse-all). Default `panelOpen = false` on mobile, always-open on
desktop. The toggle is pure local UI state — it must not touch `searchQuery`,
`visible`, or the expand sets. Add one i18n key for the toggle's `aria-label`
(e.g. `graph.controls.toggle`) in both locales; the collapsed control is a
shadcn `<Button>` per the UI rules. Because search now lives behind a tap on
mobile, ensure the collapsed icon gives an affordance that search/filter live
there (icon choice + `aria-label`).

### D6 — Sticky search-clear (q3=a): delete snapshot/restore

Remove the snapshot/restore `useEffect` (the `isSearching` leading/trailing-edge
effect, ~lines 677–697) and the `expandSnapshotRef` / `wasSearchingRef` plumbing
that exists only to serve it. The auto-expand effect (D2 of the search change)
stays — it is already add-only and never removes a user's expansion. On the
trailing edge (search cleared) we must still reset the **pure-search** cursor
state that the removed effect used to reset: `setCurrentMatchIndex(0)` and
`setCenterNodeId(null)`. Move those two resets to fire when `isSearching` goes
false (a minimal effect keyed on `isSearching`, or fold into the existing
query-change effect) so the match ring/count/camera clear on exit **without**
touching the expand sets. Net effect: `matchIds` going null clears highlight and
dim (already derived from `matchIds`), the count/prev-next disappear (derived
from the ordered match list), the cursor resets, and every expanded hub — manual
or search-forced — stays expanded.

### D7 — Tap → side panel on mobile (q5=a), tooltip is hover-only

No code change is required for tap-to-select: `handlePointerUp`'s clean-tap
branch already calls `onNodeClick`, which `resource-graph.tsx` maps to
`openPanel` / `openTask` / doc-panel — the same responsive panels
(`w-full md:w-[480px]`). The hover tooltip is driven by `hoverId` set from
pointer-move hit-testing; on touch there is no hover dwell, so it does not
appear. We only verify (test) that a tap opens the panel on a touch-style
pointer and that the tooltip does not require a touch path. No long-press
handler is added.

## Risks / Trade-offs

- **Keeping `touch-action: none` (D3) is counter-intuitive** vs. the idea's
  "放开 touch-none" wording. Removing it would break the fix (the browser would
  eat the gesture). Called out explicitly so the implementer doesn't "fix" the
  CSS and regress the feature; covered by a test that a two-finger move zooms.
- **Double-tap vs. single-tap navigation race (D2).** A naive implementation can
  both open the panel and zoom. The deferred-click rule (cancel the pending
  single-tap when a second tap lands in the window) avoids it; a test asserts a
  double-tap does not open a panel.
- **Losing the outline removes a non-canvas fallback.** Very old / low-power
  touch devices now always run the Canvas-2D renderer. Accepted per the product
  decision; the renderer is already the desktop default and the tree is small
  (project-scoped).
- **`useIsMobile()` stays** (used by D5) even though the render fork is gone —
  keep the import; only the outline branch is deleted.

## Migration

Pure front-end change. No data migration, no API/endpoint change, no schema
change. Deletes `mindmap-outline.tsx` and two outline test files. New i18n key(s)
under `graph.controls.*` in both locales. No dependency changes (pointer/touch
and canvas are browser built-ins).
