# Design: Trackpad zoom & pan gestures for the project graph views

## Context

Two independent graph renderers exist and must both be addressed (elaboration Q1=b):

| Surface | File(s) | Tech | Zoom/pan today |
|---|---|---|---|
| `/graph` mind-map | `mindmap-canvas.tsx` | hand-rolled `<canvas>` 2D | custom `handleWheel` (zoom-only), pointer drag pan, touch pinch/double-tap |
| Task-dependency DAG | `task-dag.tsx`, `dag-view.tsx`, `proposal-editor.tsx` | `@xyflow/react` v12 | @xyflow defaults (`zoomOnScroll`, `panOnDrag`) |

They share **no** code, so this change has two implementation halves with intentionally different mechanisms but a single user-facing model: **two-finger swipe pans, pinch (or Ctrl/⌘+scroll) zooms, mouse wheel zooms** (elaboration Q2=a, Q3=a). Non-functional stance is "solid & responsive, no inertia" (Q5=a); on-screen `+`/`−`/fit controls are added to the canvas (Q4=a). The DAG already ships `<Controls>`.

## Goals / Non-goals

- **Goal:** a trackpad user can pan the graph by two-finger swipe and zoom by pinch, on both surfaces, without learning a modifier key.
- **Goal:** mouse users keep wheel-to-zoom on the canvas; on the DAG, mouse users zoom via Ctrl/⌘+wheel, pinch, or the Controls buttons.
- **Goal:** page never scrolls while the pointer is over a graph and gesturing.
- **Non-goal:** momentum/inertia physics; a MiniMap; touch-device changes (the existing touch pinch/double-tap path is untouched); any layout/data change.

## Decision 1 — Canvas wheel classifier (`mindmap-canvas.tsx`)

Replace `handleWheel` (currently `deltaY`→zoom only) with a pure classifier + a native, non-passive `wheel` listener.

### D1.1 The classifier (pure, exported, unit-tested)

```ts
export type WheelGesture =
  | { kind: "zoom"; scaleFactor: number }   // pinch or mouse-wheel notch
  | { kind: "pan"; dx: number; dy: number }; // two-finger swipe

export function classifyWheel(ev: {
  ctrlKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number; // 0 = pixel, 1 = line, 2 = page
}): WheelGesture;
```

Classification order:

1. **`ctrlKey === true` → zoom.** This is exactly how browsers surface a trackpad **pinch** (synthetic ctrl+wheel) *and* the explicit Ctrl/⌘+wheel zoom shortcut. `scaleFactor = Math.exp(-deltaY * ZOOM_PINCH_SENSITIVITY)`. Pinch deltas are pixel-mode and fine, so a smaller sensitivity constant than the mouse notch keeps pinch from over-zooming.
2. **Else if the event looks like a trackpad swipe → pan.** A plain wheel is treated as a two-finger pan when it carries a horizontal component (`deltaX !== 0`) OR it is a fine-grained pixel-mode vertical scroll (`deltaMode === 0` and `abs(deltaY)` below `MOUSE_NOTCH_MIN` px). `dx = deltaX`, `dy = deltaY`. Panning applies `tx -= dx; ty -= dy` (content follows the fingers).
3. **Else → zoom** (classic mouse wheel: coarse, vertical-only, often line-mode). `scaleFactor = Math.exp(-deltaY * ZOOM_WHEEL_SENSITIVITY)` — the current `0.0015` constant, preserving today's mouse feel exactly.

> **Heuristic honesty.** No web API cleanly separates "mouse wheel" from "trackpad two-finger scroll"; both are `WheelEvent`s. The `deltaX`-present / fine-pixel-vertical test is the same signal Figma, tldraw, and Excalidraw use. Edge case: a plain (no-ctrl) vertical two-finger trackpad swipe with pixel deltas at or above `MOUSE_NOTCH_MIN` is indistinguishable from a mouse notch and will zoom. This is the accepted, documented trade-off of Q3=a ("mouse wheel still zooms"); the pinch and horizontal-swipe paths cover the common trackpad zoom/pan intents, and the on-screen controls + Ctrl+wheel are the unambiguous fallbacks. Constants live next to `SCALE_MIN`/`SCALE_MAX` with a comment.

### D1.2 Native non-passive listener

React's `onWheel` is registered passively in some browsers, so `preventDefault()` inside it can be ignored (and logs a console warning). Attach the handler via `addEventListener("wheel", handler, { passive: false })` in an effect on the canvas element and `preventDefault()` on every classified graph gesture, so the page does not scroll while the cursor is over the canvas. Remove on cleanup. The current JSX `onWheel` prop is dropped. This keeps `touch-none` (already present) doing the touch-side job and adds the wheel-side job.

Pan and zoom both mutate `viewRef.current` and call `scheduleRender()` — the same transform channel the drag-pan and pinch paths already use — and zoom clamps to `[SCALE_MIN, SCALE_MAX]` via the existing cursor-anchored math extracted into a small `zoomAround(scaleFactor, sx, sy)` helper (shared by the wheel-zoom and the new `+`/`−` buttons).

## Decision 2 — Canvas on-screen controls (Q4=a)

Add a bottom-left (mirroring ReactFlow's Controls placement, but on the opposite side from the top-right search card) vertical cluster of three shadcn `<Button size="icon">` in a rounded card, over the canvas:

- **Zoom in** (`Plus`) → `zoomAround(ZOOM_BUTTON_STEP, cx, cy)` centered on the viewport center.
- **Zoom out** (`Minus`) → `zoomAround(1 / ZOOM_BUTTON_STEP, cx, cy)`.
- **Fit / reset** (`Maximize`/`Frame` lucide icon) → set `viewRef.current = fitTransformFor(layout, dims)` (the existing pure fit helper) and repaint.

These render in `mindmap-canvas.tsx` as sibling DOM over the `<canvas>` (like the existing tooltip overlay), so they participate in normal layout and are keyboard/pointer accessible. Each carries an `aria-label` and a shadcn `<Tooltip>`, all i18n-driven (`graph.zoom.in` / `graph.zoom.out` / `graph.zoom.fit`). `data-testid`s: `graph-zoom-in`, `graph-zoom-out`, `graph-zoom-fit`. The buttons are hidden while the layout is empty (nothing to zoom), consistent with the search row.

> The buttons live in the canvas component (not the parent `resource-graph.tsx`) because the zoom math, `viewRef`, `layout`, and `dims` are all canvas-local; lifting them to the parent would mean exporting the transform. Keeping them here reuses `zoomAround` + `fitTransformFor` directly.

## Decision 3 — ReactFlow DAG configuration (two full-canvas mounts only)

@xyflow/react v12 supports the Figma model declaratively — no custom wheel handling. The target prop set:

```tsx
panOnScroll                       // two-finger / wheel scroll pans
panOnScrollMode={PanOnScrollMode.Free}  // pan on both axes
zoomOnScroll={false}              // scroll no longer zooms…
zoomOnPinch                       // …pinch still zooms (default true; set explicit)
zoomActivationKeyCode={["Meta", "Control"]}  // …and Ctrl/⌘+scroll zooms (cross-platform)
panOnDrag                         // drag still pans (default true)
```

### D3.0 Scope: which mounts get this (BLOCKER fix, review round 1)

There are **three** `<ReactFlow>` instances, but only **two** get `DAG_PAN_ZOOM_PROPS`:

| Mount | Renders `<Controls>`? | Gets pan-on-scroll? |
|---|---|---|
| `dag-view.tsx` (tasks view) | yes, unconditional | **yes** |
| `proposal-editor.tsx` (proposal editor) | yes, unconditional | **yes** |
| `task-dag.tsx`'s own `<ReactFlow>` (readonly dashboard preview) | **no** — gated behind `!readonly`, and it is only ever mounted `readonly` (dashboard `proposal-view.tsx`) | **no — excluded** |

The `task-dag.tsx` `<ReactFlow>` is a small, height-bounded thumbnail embedded inside a scrollable dashboard panel, always mounted `readonly`, and it deliberately hides `<Controls>` when readonly. Applying `zoomOnScroll={false}` there would strip its **only** zoom affordance (no Controls, no Ctrl+wheel discoverability for a preview), and making its wheel pan-the-graph would hijack the dashboard's page scroll. So it keeps its current defaults. `task-dag.tsx` still **owns** the exported `DAG_PAN_ZOOM_PROPS` constant (one source of truth for the DAG code), it just doesn't spread it into its own preview `<ReactFlow>`.

The `task-dag-navigation` capability's "On-screen controls still zoom and fit" scenario is therefore satisfiable on both in-scope mounts (both render Controls); the excluded preview is not covered by that capability.

Behavior this yields (on the two in-scope mounts):
- **Two-finger trackpad swipe →** `panOnScroll` pans (Free = x+y).
- **Trackpad pinch →** `zoomOnPinch` zooms (unaffected by `zoomOnScroll=false`).
- **Ctrl/⌘+scroll →** while `zoomActivationKeyCode` is held, scroll zooms even though `zoomOnScroll` is false.
- **`<Controls>` buttons →** zoom in/out/fit, already present and unconditional on both in-scope mounts.
- **Mouse-only user (no pinch) →** zoom via Ctrl+wheel or the Controls buttons. This is the accepted DAG-side consequence of the Figma model (documented for the reviewer): unlike the canvas, ReactFlow's `panOnScroll` applies to *all* wheel events with no mouse-vs-trackpad heuristic, so a plain mouse wheel pans rather than zooms here. We accept the small canvas/DAG divergence (canvas: plain mouse wheel zooms; DAG: plain mouse wheel pans) in exchange for not fighting the library; both surfaces share the same *trackpad* model, which is the idea's goal.

### D3.1 Single source of truth for the props

`dag-view.tsx` and `proposal-editor.tsx` construct their own `<ReactFlow>` (they are not thin wrappers over `task-dag.tsx`). To avoid drifting copies, export a shared constant from `task-dag.tsx`:

```ts
export const DAG_PAN_ZOOM_PROPS = {
  panOnScroll: true,
  panOnScrollMode: PanOnScrollMode.Free,
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomActivationKeyCode: ["Meta", "Control"],
  panOnDrag: true,
} as const;
```

and spread `{...DAG_PAN_ZOOM_PROPS}` into the **two in-scope** `<ReactFlow>` mounts (`dag-view.tsx`, `proposal-editor.tsx`) — NOT into `task-dag.tsx`'s own readonly preview mount (D3.0). `minZoom`/`maxZoom`/`fitView` stay per-mount as they are.

> `zoomActivationKeyCode={["Meta","Control"]}` activates on ⌘ (macOS) **and** Ctrl (Windows/Linux), covering the `task-dag-navigation` spec's "Ctrl or Command + scroll zooms" scenario cross-platform (addresses review round-1 NOTE). @xyflow/react v12 accepts a `KeyCode` array here.

## Decision 4 — Testing strategy

- **`classifyWheel` unit tests** (new, pure — mirrors how `pinchTransform`/`fitTransformFor` are already tested): ctrl+wheel → zoom; horizontal wheel → pan; fine pixel vertical → pan; coarse/line vertical → zoom; zoom `scaleFactor` sign matches scroll direction.
- **Canvas control cluster tests** (extend the jsdom canvas harness in `mindmap-canvas-touch.test.tsx` or a sibling): clicking `+`/`−` changes the recorded `setTransform` scale; clicking fit resets toward the fit scale; buttons carry their `aria-label`s.
- **Existing `mindmap-canvas-touch.test.tsx`** must stay green (touch pinch/double-tap/drag contract unchanged).
- **DAG props:** a light render/prop assertion that the three mounts receive `panOnScroll` + `zoomOnScroll=false` (guards against a future edit dropping the shared spread). No behavioral ReactFlow simulation — @xyflow's own tests cover the mechanics.
- **Type check + lint + full `pnpm test`** green.
- **E2E:** manual browser verification (Playwright MCP) of the `/graph` canvas — the on-screen zoom/fit buttons visibly work and the page doesn't scroll on a wheel gesture — is the human/browser AC on the integration task, since trackpad `deltaX`/pinch cannot be synthesized headlessly with fidelity.

## Risks

- **Heuristic false-classify (canvas):** a plain vertical trackpad swipe with large pixel deltas zooms instead of panning. Mitigated by the horizontal-component test catching most two-finger pans and by the explicit controls. Documented, accepted (Q3=a).
- **`preventDefault` scope:** the non-passive listener must be scoped to the canvas element only, never the document, so normal page scrolling elsewhere is unaffected. Cleanup on unmount required.
- **Canvas/DAG divergence:** plain mouse wheel zooms on the canvas but pans on the DAG. Accepted trade-off of not custom-writing ReactFlow wheel handling (D3). The shared model is the *trackpad* model.
