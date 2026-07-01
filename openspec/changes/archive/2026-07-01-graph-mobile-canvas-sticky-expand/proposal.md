# Graph Mobile Canvas + Sticky Search-Clear Expand

## Why

Two UI problems with the project resource mind-map (capability
`project-resource-graph`, `src/app/(dashboard)/projects/[uuid]/graph/`), plus a
scope decision that surfaced during elaboration:

1. **Mobile can't zoom the graph.** The canvas element carries
   `touch-action: none` (`mindmap-canvas.tsx`), which suppresses the browser's
   native touch gestures, but the pointer handlers only implement a
   single-finger drag-pan — there is **no two-finger pinch handling at all**.
   Zoom exists solely on the mouse-wheel path (`handleWheel`). So on a phone or
   tablet the graph cannot be zoomed by pinch or spread; it is stuck at its
   initial scale.

2. **Clearing search yanks the located branch shut.** When a search runs, the
   graph auto-expands the ancestor hubs of every match so the matches become
   visible. On the leading edge of a search it snapshots the pre-search expand
   set, and on clear it **restores that snapshot** — collapsing every hub the
   search had opened. The user searches, the graph expands and locates the
   match, they clear the box to look around, and the branch they were just
   reading snaps closed. This restore was a deliberate design choice; the
   product decision now reverses it.

3. **Scope decision (from elaboration): abandon the mobile outline entirely.**
   Today the graph renders two different ways: a DOM vertical indented outline
   (`mindmap-outline.tsx`) on a narrow viewport, and the Canvas-2D mind-map
   (`mindmap-canvas.tsx`) on a wide one, switched by `useIsMobile()` (≤767px).
   The stakeholder chose to **drop the outline and render the canvas on all
   viewports**, with the touch adaptations that requires — rather than only
   patching pinch onto a canvas mobile users never see today.

## What Changes

Author decisions recorded across two elaboration rounds on the driving idea
(q1–q7):

1. **Touch gestures on the canvas (q1=b, q2=a).** Add two-finger pinch zoom
   anchored on the finger midpoint, panning to follow the midpoint as it moves
   (map-like combined zoom + move), reusing the existing `scale`/`tx`/`ty` view
   model and the wheel path's zoom clamp. Add double-tap to zoom in centered on
   the tapped point, and a second double-tap to reset to the fit view.
   Single-finger drag-pan and all mouse behavior are unchanged.

2. **Abandon the outline; canvas on all viewports (q4).** Delete
   `mindmap-outline.tsx` and remove the `useIsMobile()` render fork in
   `resource-graph.tsx` so the canvas renders unconditionally. The one-time
   fit-to-view on the first non-empty layout already frames the whole tree on
   any viewport, so a phone screen initially shows the entire tree before the
   user pinches in (q7=a).

3. **Mobile control panel collapses to an icon (q6=a).** The top-right control
   card (search + type filter + expand/collapse-all) overlays the canvas. On a
   narrow viewport it now collapses to a single icon button and expands on tap,
   so it no longer obscures the graph. Desktop is unchanged. (This card was
   originally placed top-right specifically so it would not overlap the mobile
   outline's left-edge rows; once mobile switches to the canvas the card would
   overlap the graph — the collapse resolves that.)

4. **Tap = select + open side panel on mobile (q5=a).** A tap already routes
   through the same click handler as desktop, opening the reused per-entity
   side panel (Idea / Proposal / Task / Document), which is already responsive
   (`w-full md:w-[480px]`). The desktop hover tooltip has no touch trigger and
   simply does not appear on touch; the full title is read in the side panel. No
   long-press tooltip is added.

5. **Sticky search-clear expansion (q3=a).** Remove the snapshot/restore effect.
   Clearing a search (clear button, Escape, or blank query) now clears only the
   pure-search visual state — match highlight, non-match dim, match count, and
   the current-match cursor — and leaves every expanded node expanded, including
   hubs the search opened. Auto-expansion remains add-only.

This is a **MODIFIED** change to the `project-resource-graph` capability. Three
requirements are removed (the mobile vertical outline; "search available in both
renderings"; "search restores the pre-search expand state"), three are added
(touch gestures; collapsible mobile control panel; sticky search-clear
expansion), and four are reworded to drop the two-rendering / outline language
now that the canvas is the sole rendering (mind-map tree rendering, type
styling/filter, presence highlighting, hover tooltip, match navigation). The
aggregation service, the tree-layout algorithm, SSE live-reconcile, node status,
and the four side panels are unchanged.

## Capabilities

- `project-resource-graph` (MODIFIED)

## Impact

- **Affected code:**
  - `mindmap-canvas.tsx` — add two-finger pinch (zoom + midpoint pan) and
    double-tap (zoom / reset) in the pointer handlers; reuse the wheel clamp and
    `fitToView`. **Keep** `touch-action: none` on the canvas — it is required to
    receive continuous multi-touch move events; the missing pinch handler, not
    the CSS, was the problem (see Tech Design D3).
  - `resource-graph.tsx` — remove the `useIsMobile()` render fork and the
    `MindMapOutline` import/usage; delete the snapshot/restore effect so clearing
    search is sticky; make the control card collapse to an icon on a narrow
    viewport.
  - `mindmap-outline.tsx` — **deleted**.
  - `__tests__/` — delete `resource-graph-outline.test.tsx` and
    `mindmap-outline-search.test.tsx`; add canvas touch-gesture tests and a
    sticky-clear test; drop outline assertions from shared tests.
  - `node-status.ts` — comment reference to the outline row is updated (shared
    status vocabulary itself is unchanged).
  - i18n — a `graph.controls.*` key (or equivalent) for the collapsed-panel
    toggle's accessible label, added to both `en` and `zh`.
- **No** data migration, API/endpoint, schema, or aggregation change.
- **Cross-platform:** no new dependencies; pointer/touch events and canvas are
  browser built-ins.
