## Why

The device-inference wheel classifier shipped for idea 9d326265 still intermittently mis-scrolls (a smooth-scroll mouse is indistinguishable from a trackpad on the event stream), and the interim "scroll pans / Ctrl+wheel zooms" model was reversed by the user. The final decision (idea elaboration round 3, 2026-07-09): **protect mouse-wheel zoom** — a plain wheel ALWAYS ZOOMS at any speed (no modifier), the trackpad two-finger-pan optimization is abandoned, a trackpad pinch zooms, and panning is via drag. This is a return to the pre-#408 behavior and is fully deterministic (no device guessing → no flakiness).

## What Changes

- **Remove the device-inference classifier entirely.** Delete `src/lib/wheel-gesture.ts` + test, and `src/components/dag-wheel-nav.tsx` + test — the whole "infer mouse vs trackpad" layer is abandoned.
- **`/graph` mind-map canvas** (`mindmap-canvas.tsx`): the non-passive wheel handler always ZOOMS around the cursor — `ev.preventDefault()` then `zoomAround(Math.exp(-ev.deltaY * sensitivity), sx, sy)`. No pan branch, no stream state, no modifier requirement. A trackpad pinch (synthetic ctrlKey wheel) uses the finer ZOOM_PINCH_SENSITIVITY; a plain wheel uses ZOOM_WHEEL_SENSITIVITY. Panning stays available via the existing single-pointer drag path (unchanged). Existing touch pinch/double-tap/drag are untouched.
- **Interactive task DAG** (tasks view + proposal editor): use ReactFlow's default wheel-zoom — `zoomOnScroll:true`, `panOnDrag:true`, `zoomOnPinch:true` (drop `panOnScroll`, drop `zoomActivationKeyCode`, drop the custom `<DagWheelNav/>` listener). This is exactly the config the readonly dashboard preview already uses, so all three DAG mounts converge on ReactFlow defaults. The readonly preview stays unchanged.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `project-resource-graph`: the canvas wheel requirement becomes "a plain wheel always zooms around the cursor; pinch zooms; drag pans" — no device inference, no pan-on-wheel.
- `task-dag-navigation`: the interactive DAG's wheel requirement becomes ReactFlow default wheel-zoom (drag pans, pinch zooms), dropping the shared pan-on-scroll config.

## Impact

- Code: DELETE `src/lib/wheel-gesture.ts`, `src/lib/__tests__/wheel-gesture.test.ts`, `src/components/dag-wheel-nav.tsx`, `src/components/__tests__/dag-wheel-nav.test.tsx`. Rewrite the `mindmap-canvas.tsx` wheel handler (always-zoom). Point the two interactive DAG mounts (`tasks/dag-view.tsx`, `proposals/[proposalUuid]/proposal-editor.tsx`) at inline `zoomOnScroll/panOnDrag/zoomOnPinch` (drop `<DagWheelNav/>` + the shared constant). Remove the now-unused `DAG_INTERACTIVE_PAN_ZOOM_PROPS` from `task-dag.tsx`.
- Tests: rewrite `mindmap-canvas-wheel.test.tsx` (every wheel zooms) and `task-dag-pan-zoom.test.tsx` (interactive mounts use zoomOnScroll:true, no DagWheelNav; readonly preview unchanged).
- No API/DB/dependency changes. Behavior-only, front-end only.
- `docs/design.pen`: graph interaction notes updated to the always-zoom model.
