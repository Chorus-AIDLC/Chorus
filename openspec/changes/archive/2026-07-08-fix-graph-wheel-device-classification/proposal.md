## Why

The trackpad pan gestures added in #408 introduced a mouse-wheel regression on the project graph canvas (`/graph`): a **slow** mouse-wheel notch now pans the tree up/down instead of zooming, and only a **fast** notch zooms. The cause is a per-event magnitude threshold (`MOUSE_NOTCH_MIN = 30px`) in `classifyWheel` — a pixel-mode wheel below 30px is assumed to be a trackpad swipe. High-resolution and smooth-scroll mice emit sub-30px pixel deltas per notch, so slow scrolling is misclassified as a pan. This is the exact "accepted ambiguity" the code comments flagged, but it degrades ordinary mouse use.

## What Changes

- Replace the single-event magnitude heuristic with a **stateful device classifier** that infers the device from the **rhythm and continuity** of recent wheel events — a mouse produces short bounded bursts (or line/page deltas), a trackpad produces a horizontal component or a sustained continuous run (swipe + momentum tail) — so a mouse-wheel notch zooms at **any** scroll speed while a two-finger trackpad swipe still pans. It deliberately does **not** use delta magnitude, fractional value, or per-event ramp as a device signal, because a high-resolution/smooth-scroll mouse (the reported device) produces exactly those and would otherwise be re-misclassified as a trackpad. Extracted into one shared, unit-tested module both graph surfaces consume.
- **`/graph` mind-map canvas**: route its non-passive wheel handler through the shared classifier. Slow mouse wheel zooms again; trackpad two-finger swipe pans; trackpad pinch and Ctrl/⌘+wheel still zoom; on-screen +/- / fit controls unchanged.
- **Task-dependency DAG** (ReactFlow — tasks view + proposal editor): align its wheel behavior with the fixed canvas via the same classifier so **mouse wheel zooms** and **trackpad two-finger swipe pans**, resolving the cross-surface inconsistency where #408 left the DAG panning on every wheel. Pinch, Ctrl/⌘+wheel, drag-pan, node interaction, and the on-screen Controls are preserved; the compact readonly dashboard preview stays excluded (unchanged).

## Capabilities

### New Capabilities
_(none — this is a fix to existing gesture behavior)_

### Modified Capabilities
- `project-resource-graph`: the "Trackpad two-finger pan and pinch-zoom on the canvas" requirement changes its wheel classification from a single-event magnitude threshold to a recent-stream device inference, so a slow mouse-wheel notch still zooms.
- `task-dag-navigation`: the interactive DAG's trackpad-first pan/zoom requirement changes so a mouse wheel zooms (any speed) and a trackpad two-finger swipe pans, via the same shared classifier, instead of ReactFlow's blanket pan-on-scroll.

## Impact

- Code: `src/lib/wheel-gesture.ts` (new shared classifier + its tests), `src/app/(dashboard)/projects/[uuid]/graph/mindmap-canvas.tsx` (rewire `classifyWheel`), and the two **interactive** DAG mounts — `src/app/(dashboard)/projects/[uuid]/tasks/dag-view.tsx` and `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx` — which currently spread `DAG_PAN_ZOOM_PROPS` (defined in `task-dag.tsx`); that blanket pan-on-scroll config is replaced by a shared classifier-driven wheel handler. The `<ReactFlow>` inside `task-dag.tsx` itself is the **readonly compact preview** (`TaskDag`, used by `dashboard/panels/proposal-view.tsx`) and stays unchanged.
- Tests: existing `mindmap-canvas-wheel.test.tsx` and `task-dag-pan-zoom.test.tsx` updated; new coverage for the device classifier.
- No API, DB, or dependency changes. Behavior-only, front-end only.
- `docs/design.pen`: the graph interaction notes are updated to reflect the device-inference model.
