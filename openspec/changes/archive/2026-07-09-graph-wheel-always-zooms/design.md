# Technical Design: Plain wheel always zooms (protect mouse-wheel zoom)

## Overview

Return to the pre-#408 deterministic model, chosen in idea elaboration round 3:

- **any wheel over the graph → ZOOM around the cursor** (no modifier needed, any speed).
- **trackpad pinch → ZOOM** (browsers deliver a pinch as a synthetic `ctrlKey` wheel, which is still a wheel → zoom).
- **panning → drag** (single-pointer drag on the canvas; `panOnDrag` on the DAG).

No device inference, no pan-on-wheel, no stream state. The accepted cost (elaboration r3): a trackpad two-finger vertical swipe now zooms instead of panning; trackpad users pan by dragging and zoom by pinch. This is unambiguous and eliminates the flaky mis-scroll for good.

## `/graph` canvas (`mindmap-canvas.tsx`)

Replace the classifier-backed listener with an unconditional zoom:

```ts
const onWheel = (ev: WheelEvent) => {
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  ev.preventDefault();                       // never let the page scroll under the canvas
  // A trackpad pinch arrives as a synthetic ctrlKey wheel with fine pixel deltas,
  // so it uses the finer pinch sensitivity; a plain mouse wheel uses the notch feel.
  const sensitivity = ev.ctrlKey ? ZOOM_PINCH_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
  zoomAroundRef.current(Math.exp(-ev.deltaY * sensitivity), sx, sy);
};
```

- Remove `wheelStateRef`, the `classifyWheelStream`/`createWheelClassifierState`/`WheelClassifierState` import, and every pan branch / continuity bookkeeping.
- `zoomAround`, `ZOOM_WHEEL_SENSITIVITY`, `ZOOM_PINCH_SENSITIVITY` are kept as-is.
- Panning stays via the existing single-pointer drag (`handlePointerDown/Move` → `viewRef` translate) — untouched. Touch pinch/double-tap/drag paths — untouched (they never went through the wheel listener).
- This is effectively the pre-#408 wheel handler (which was `zoomAround(Math.exp(-deltaY * ZOOM_WHEEL_SENSITIVITY), …)` on every wheel), plus the pinch-sensitivity split.

## Interactive task DAG (`task-dag.tsx` + two mounts)

Delete `dag-wheel-nav.tsx`; the interactive mounts adopt ReactFlow's default wheel-zoom — the SAME inline props the readonly preview already uses (`task-dag.tsx`'s own `<ReactFlow>` has `panOnDrag={true}` + `zoomOnScroll={true}`):

On both `tasks/dag-view.tsx` and `proposals/[proposalUuid]/proposal-editor.tsx` `<ReactFlow>`:
- set `zoomOnScroll={true}`, `panOnDrag={true}`, `zoomOnPinch={true}` (inline);
- remove `{...DAG_INTERACTIVE_PAN_ZOOM_PROPS}` and `<DagWheelNav/>` (+ their imports).

`zoomOnScroll:true` is ReactFlow's default: a plain wheel zooms around the cursor, a pinch zooms, and drag pans — exactly the model. No custom listener, no `zoomActivationKeyCode`, no `panOnScroll`. Remove the now-unused `DAG_INTERACTIVE_PAN_ZOOM_PROPS` export from `task-dag.tsx`. The readonly compact dashboard preview keeps its identical inline props (already correct) — all three mounts converge.

> Net effect: the interactive DAG returns to ReactFlow defaults (its pre-#408 behavior), and the classifier layer both surfaces briefly shared is gone.

## Deletion ordering (compile-safe)

Learned from the prior proposal's review: drop a module only after its importers are gone, so every task ends tsc-green.

- **Task 1 (canvas):** rewrite `mindmap-canvas.tsx` to remove its `@/lib/wheel-gesture` import. Do NOT delete `wheel-gesture.ts` yet (`dag-wheel-nav.tsx` still imports it). Repo compiles at task-1 end.
- **Task 2 (DAG + deletions):** de-import `<DagWheelNav/>` from both mounts → delete `dag-wheel-nav.tsx` (+test) → then delete `wheel-gesture.ts` (+test), since nothing imports it anymore → grep clean. Repo compiles at task-2 end.

## Testing

- `mindmap-canvas-wheel.test.tsx` — rewrite: every wheel zooms. A plain vertical wheel changes the view scale (not just translate); a `ctrlKey` wheel zooms (pinch); scrolling up zooms in / down zooms out; `preventDefault` always called; a plain wheel does NOT pan (no translate-only change). No classifier import.
- `task-dag-pan-zoom.test.tsx` — assert both interactive mounts pass `zoomOnScroll:true` + `panOnDrag:true` and render neither `<DagWheelNav/>` nor a `panOnScroll`/`DAG_INTERACTIVE_PAN_ZOOM_PROPS`; readonly preview unchanged.
- Delete `wheel-gesture.test.ts` and `dag-wheel-nav.test.tsx` with their modules.

## Risks & Mitigations

- **R1 — trackpad users lose two-finger-swipe pan.** Explicitly accepted (elaboration r3): pan via drag, zoom via pinch. Deterministic and matches pre-#408.
- **R2 — dangling importers after deletion.** Enforced by the task ordering above + a final grep for `wheel-gesture` / `classifyWheelStream` / `createWheelClassifierState` / `DagWheelNav` / `DAG_INTERACTIVE_PAN_ZOOM_PROPS`, guarded by tsc + full test run.
- **R3 — supersedes archived + closed prior work.** The `fix-graph-wheel-device-classification` change is archived; the `graph-wheel-scroll-pans-ctrl-zooms` proposal was closed unbuilt. This change modifies the same two capability specs to the final always-zoom model; the delta specs overwrite the relevant requirements.
