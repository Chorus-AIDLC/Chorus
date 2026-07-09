# Trackpad zoom & pan gestures for the project graph views

## Why

The project graph views do not behave the way a trackpad user expects.

- The `/projects/[uuid]/graph` canvas mind-map (`mindmap-canvas.tsx`) maps **every** `wheel` event to a zoom (`handleWheel` reads only `deltaY`, ignores `deltaX` and `ctrlKey`). A two-finger trackpad swipe — which the browser reports as a `wheel` event with `deltaX`/`deltaY` — therefore zooms instead of panning, and there is no way to pan except a single-finger/mouse drag. A trackpad pinch, which the browser reports as `wheel` with `ctrlKey=true`, is treated as an ordinary zoom by accident rather than by design and its granularity is wrong.
- The canvas page has **no on-screen zoom or reset controls** at all, so a user on a device without a usable scroll-to-zoom (or who does not know the Ctrl+wheel convention) has no discoverable way to zoom or return to the full view.
- The ReactFlow task-dependency DAG (rendered by `task-dag.tsx`, `dag-view.tsx`, and `proposal-editor.tsx`) relies on @xyflow defaults (`zoomOnScroll=true`, `panOnScroll=false`), so a two-finger trackpad swipe zooms there too instead of panning — the same mismatch, in a second surface.

The net effect is that the industry-standard trackpad interaction of design/whiteboard tools (two-finger swipe pans, pinch zooms) is unavailable in Chorus's graph views.

## What Changes

Adopt a **Figma/Miro-style** trackpad interaction model across **both** graph surfaces, keeping mouse users fully supported:

1. **Canvas mind-map (`/graph`):** replace the zoom-only wheel handler with a gesture classifier that distinguishes, on the raw `WheelEvent`:
   - **pinch-zoom** — `ctrlKey === true` (how browsers report a trackpad pinch, and the explicit Ctrl/⌘+wheel zoom convention) → zoom around the cursor.
   - **two-finger pan** — a plain wheel event that carries a horizontal component or reads as a fine-grained trackpad scroll → pan the canvas by `(deltaX, deltaY)`.
   - **mouse-wheel zoom** — a plain, coarse, vertical-only wheel event (a classic mouse wheel notch) → zoom around the cursor, exactly as today.
   The listener is attached natively (non-passive) so it can `preventDefault()` inside the graph region and stop the page from scrolling during a gesture. Pan and zoom reuse the existing `viewRef` transform and the shared `SCALE_MIN`/`SCALE_MAX` clamp.

2. **Canvas on-screen controls:** add a small control cluster to the `/graph` canvas — zoom-in (`+`), zoom-out (`−`), and reset/fit-to-view — as a fallback zoom entry point that does not depend on any gesture or the Ctrl convention. These reuse the canvas's existing zoom-around-center and `fitTransformFor` math.

3. **ReactFlow DAG (the two full-canvas surfaces):** configure the tasks-view DAG (`dag-view.tsx`) and the proposal-editor DAG (`proposal-editor.tsx`) so a two-finger scroll pans (`panOnScroll` + `panOnScrollMode="free"`, `zoomOnScroll={false}`), while zoom stays available via pinch (`zoomOnPinch`, on by default), Ctrl/⌘+scroll (ReactFlow zooms on scroll while `zoomActivationKeyCode` is held even when `zoomOnScroll` is off), and the already-present `<Controls>` buttons that both surfaces render unconditionally. Node dragging and selection are unchanged. The shared config constant lives in `task-dag.tsx` (so all DAG code has one source of truth) and is spread into those two mounts.

   The **compact readonly DAG preview** rendered by `task-dag.tsx` in the dashboard `proposal-view` panel is intentionally **excluded** from the pan-on-scroll model. It is a small, height-bounded thumbnail embedded in a scrollable dashboard; making its wheel pan-the-graph would hijack page scroll, and it deliberately hides `<Controls>` (gated behind `!readonly`), so flipping `zoomOnScroll` off there would strip its only zoom path. It keeps its current behavior unchanged.

### Explicitly out of scope

- Inertia / momentum / damping animation on the canvas gestures — the non-functional decision (elaboration Q5=a) is "solid & responsive," not native-app polish. Gestures track the input frame-for-frame; no fling physics.
- The MiniMap (none exists today; not added here).
- Any change to the graph's data model, layout, expand/collapse, search, or side panels.

## Capabilities

- `project-resource-graph` (MODIFIED) — the canvas mind-map gains trackpad pan / pinch-zoom gesture classification and an on-screen zoom/fit control cluster; the existing touch and mouse behavior is preserved.
- `task-dag-navigation` (ADDED) — a new capability describing the ReactFlow task-dependency DAG's trackpad-first pan/zoom navigation configuration, shared across the two full-canvas interactive mounts (tasks view + proposal editor); the compact readonly dashboard preview is explicitly out of scope.

## Impact

- **Code:**
  - `src/app/(dashboard)/projects/[uuid]/graph/mindmap-canvas.tsx` — wheel classifier + native non-passive listener + on-screen control cluster.
  - `src/components/task-dag.tsx` — export the shared `DAG_PAN_ZOOM_PROPS` constant (the `task-dag.tsx` `<ReactFlow>` itself, being the readonly dashboard preview, does **not** apply it).
  - `src/app/(dashboard)/projects/[uuid]/tasks/dag-view.tsx`, `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx` — spread the shared ReactFlow pan/zoom props into their `<ReactFlow>` mounts.
  - `messages/en.json`, `messages/zh.json` — i18n keys for the new control buttons' labels/tooltips.
- **Tests:** new unit coverage for the wheel classifier (pinch vs. pan vs. mouse-zoom) and the canvas control cluster; the existing `mindmap-canvas-touch.test.tsx` touch contract stays green.
- **Docs:** `docs/design.pen` updated for the `/graph` canvas control cluster.
- **No** database, API, MCP, or permission changes.
