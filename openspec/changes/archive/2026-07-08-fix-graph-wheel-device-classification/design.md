# Technical Design: Device-inferred wheel classification for the graph surfaces

## Overview

Both graph surfaces need the same rule: **a mouse wheel zooms at any speed; a trackpad two-finger swipe pans (both axes, including a purely vertical swipe).** Today they diverge and both get it partly wrong for a mouse:

- **`/graph` canvas** (`mindmap-canvas.tsx`) classifies each wheel event in isolation with a magnitude threshold `MOUSE_NOTCH_MIN = 30px`: a pixel-mode wheel with `|deltaY| < 30` is treated as a trackpad pan. A slow / high-resolution / smooth-scroll mouse notch is < 30px, so it pans — the reported bug.
- **Task DAG** (`task-dag.tsx`, ReactFlow) uses `panOnScroll: true, zoomOnScroll: false` (from #408): **every** plain wheel pans, including a mouse wheel. No magnitude bug, but a mouse wheel never zooms — the same principle, violated the other way.

The fix is a single shared, stateful **device classifier** that infers the pointing device from the *rhythm and continuity of the recent wheel stream* (elaboration Q2=b), not from any one event's size or fractionality. Both surfaces consume it (Q3=b). It preserves the mouse-zoom / trackpad-pan split (Q1=b), including a **vertical** trackpad swipe still panning.

## Why magnitude / fractionality / ramping are the WRONG signals (the Round-1 blocker)

The reported device is a **high-resolution or smooth-scroll mouse**. Its notches are small (< 30px), often **fractional**, and **ramp** in magnitude within a notch. A trackpad two-finger scroll produces the *same* per-event shape — small, fractional, ramping. Therefore **none of {delta magnitude, fractional deltas, per-event ramp} can separate the two devices**; keying "trackpad" on any of them (as the threshold does, and as a naive stream heuristic would) re-breaks the exact device that filed the bug. This is the mistake Round 1 caught and this design must not repeat.

What actually differs is the **shape of the event stream over time**, plus two hard device tells:

| Signal | Mouse wheel | Trackpad two-finger scroll | Reliable? |
|---|---|---|---|
| `deltaMode` | sometimes line/page (`1`/`2`) | always pixel (`0`) | **line/page ⇒ mouse** (hard tell) |
| `deltaX` (horizontal component) | ~always `0` (no tilt) | frequently non-zero | **horizontal ⇒ trackpad** (hard tell) |
| stream continuity / duration | **short bounded bursts** — a notch (or a few events) then a gap; even fast scrolling is repeated discrete notches | **one sustained, uninterrupted run** — many closely-spaced events over a long gesture, typically with an inertial **momentum decay tail** after the fingers lift | primary vertical separator |
| delta magnitude / fractionality / per-event ramp | small, fractional, ramping on hi-res mice | small, fractional, ramping | **NOT reliable — do not use** |

So the axis is **"short bounded burst vs sustained continuous run,"** not "coarse vs fine."

## Module contract — `src/lib/wheel-gesture.ts`

A pure, framework-agnostic classifier so both a raw DOM `wheel` listener (canvas) and a ReactFlow wrapper (DAG) can share it and it stays unit-testable without a browser.

```ts
export type WheelGesture =
  | { kind: "zoom"; deltaY: number }   // caller maps deltaY→scaleFactor with its own sensitivity
  | { kind: "pan"; dx: number; dy: number };

export interface WheelSample {
  ctrlKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;   // 0 pixel, 1 line, 2 page
  timeStamp: number;   // ev.timeStamp (ms); monotonic within a document
}

// Opaque rolling state. Create one per surface instance; feed every wheel event.
export interface WheelClassifierState { /* device, lastTs, run bookkeeping */ }
export function createWheelClassifierState(): WheelClassifierState;

// Pure: returns the gesture AND the next state (no mutation of the input),
// so tests can drive a scripted event stream and assert each classification.
// Field name is `state` everywhere (contract + call sites + ACs) — no `nextState`.
export function classifyWheelStream(
  state: WheelClassifierState,
  sample: WheelSample,
): { gesture: WheelGesture; state: WheelClassifierState };
```

The `zoom` variant carries raw `deltaY` (not a pre-multiplied `scaleFactor`) — the classifier is device-only; each surface keeps its own zoom sensitivity (the canvas already has `ZOOM_WHEEL_SENSITIVITY` / `ZOOM_PINCH_SENSITIVITY`; the DAG uses a fixed zoom step). One classifier, two feels.

### Decision procedure (precedence order)

Given the current `state` and a new `sample`, in order:

1. **`ctrlKey` → `zoom`.** A browser reports a trackpad pinch as a synthetic ctrl+wheel, and Ctrl/⌘+wheel is the explicit zoom shortcut. Device-agnostic; does not touch the mouse/trackpad decision. (Unchanged from today.)
2. **Idle reset.** If `sample.timeStamp - state.lastTs > IDLE_RESET_MS`, clear the inferred device to `unknown` and reset the run bookkeeping (count, first/last timestamps): a new gesture is classified on its own evidence, never a stale one.
3. **Hard tell — line/page mode** (`deltaMode !== 0`) → device = **mouse**, sticky → `zoom`.
4. **Hard tell — horizontal component** (`deltaX !== 0`) → device = **trackpad**, sticky → `pan`. (A tilt-wheel horizontal scroll is a deliberate horizontal-pan intent anyway, so treating it as pan is correct even on the rare mouse that has one.)
5. **Continuity — sustained run ⇒ trackpad.** Track the current run: increment a count and remember timestamps while successive events stay within `CONTINUITY_GAP_MS` of each other. When the run reaches `CONTINUITY_MIN_EVENTS` **and** has lasted at least `CONTINUITY_MIN_MS`, mark device = **trackpad**, sticky → `pan`. A mouse notch is a short bounded burst that does not reach a sustained-run of this length; a trackpad swipe is one continuous run and does. **Crucially, magnitude/fractionality/ramping are never inspected here** — only cadence and duration.
6. **Default while `unknown` → `zoom`** (mouse). This is the deliberate inversion that fixes the bug and sets the *safe* bias: an ambiguous pure-vertical event — including the leading events of any gesture before continuity is established — is treated as a mouse-wheel **zoom**, not a pan. The old code defaulted small vertical deltas to *pan*; we invert that.
7. Emit `pan {dx, dy}` iff device resolved to `trackpad`; otherwise `zoom {deltaY}`.

Constants (tunable, exported for tests): `IDLE_RESET_MS ≈ 400`, `CONTINUITY_GAP_MS ≈ 60`, `CONTINUITY_MIN_EVENTS ≈ 5`, `CONTINUITY_MIN_MS ≈ 120`. All live in the module; no magic numbers at call sites.

### Accepted residual ambiguity (documented honestly)

Two bounded, self-correcting residuals — both err toward the *safe* direction (zoom) and neither is the reported bug:

- **Leading edge of a vertical trackpad swipe:** its first few pure-vertical events (before the run crosses the continuity thresholds, or before any horizontal drift) classify as `zoom`, then flip to `pan` once the run is established. Bounded to `CONTINUITY_MIN_EVENTS` events; in practice trackpad swipes drift horizontally almost immediately (step 4 fires sooner). This is the Q1=b trade the user accepted.
- **A fast free-spinning mouse wheel** that produces one long uninterrupted dense run with no gaps *could* cross the continuity thresholds and reclassify to `pan` mid-spin. The **slow / notched mouse — the reported device — never does** (short bounded bursts stay `zoom` by the step-6 default), so the filed bug is definitively fixed. `CONTINUITY_MIN_EVENTS`/`_MS` are tuned to require a genuinely sustained run so ordinary mouse scrolling stays zoom; pinch, Ctrl/⌘+wheel, and the on-screen controls remain unambiguous zoom paths regardless.

The key contrast with the Round-1 design: we no longer read magnitude/fractionality/ramping at all, and the default flips to zoom — so a small, fractional, ramping mouse notch (the reported shape) is zoom, not pan.

## Surface integration

### `/graph` canvas (`mindmap-canvas.tsx`)
- Replace the pure `classifyWheel(ev)` + `MOUSE_NOTCH_MIN` with a per-mount `WheelClassifierState` held in a ref, fed from the existing non-passive `wheel` listener (already `{ passive: false }`, already `preventDefault()`s classified gestures).
- `pan` → the existing `viewRef` translate; `zoom` → existing `zoomAroundRef.current(scaleFactor, sx, sy)`, where `scaleFactor = Math.exp(-deltaY * ZOOM_WHEEL_SENSITIVITY)` (unchanged feel). Pinch/ctrl path uses `ZOOM_PINCH_SENSITIVITY` as today.
- Delete `MOUSE_NOTCH_MIN` and the old `classifyWheel`/single-event `WheelGesture` export; update `mindmap-canvas-wheel.test.tsx` to drive the new stream classifier.

### Task DAG (interactive mounts) — CORRECTED file locations
Round-1 note: the interactive `<ReactFlow>` mounts are **NOT** in `task-dag.tsx`. Verified against code:
- Interactive mounts that spread `DAG_PAN_ZOOM_PROPS`: **`src/app/(dashboard)/projects/[uuid]/tasks/dag-view.tsx:160`** and **`src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx:754`**.
- `src/components/task-dag.tsx`'s own `<ReactFlow>` (`zoomOnScroll={true}`, exported `TaskDag`) is the **readonly/compact preview** rendered by `dashboard/panels/proposal-view.tsx`. It **must stay unchanged** (Round-1 note; also the existing `task-dag-navigation` "readonly preview excluded" scenario).

ReactFlow has no per-event classifier hook, so own the wheel on the two interactive mounts:
- Replace the shared `DAG_PAN_ZOOM_PROPS` (which lives in `task-dag.tsx` and is *imported* by the two mounts) with a new shared helper — a small hook/props bundle (e.g. `useDagWheelNav()` exported from a shared module) that sets `zoomOnScroll={false}` and `panOnScroll={false}` while keeping `zoomOnPinch: true`, `zoomActivationKeyCode: ["Meta","Control"]`, and `panOnDrag: true`, and attaches a non-passive `wheel` listener running the shared classifier. Both mounts consume the one helper so they cannot drift.
- In the listener: for a `pan`, `preventDefault()` and pan via the ReactFlow instance API (`setViewport({ x: x - dx, y: y - dy, zoom })`); for a mouse `zoom`, `preventDefault()` and zoom around the cursor by a fixed step clamped to the DAG's existing `minZoom=0.3`/`maxZoom=1.5`; leave `ctrlKey` events to ReactFlow (do NOT `preventDefault`, so its native pinch/⌘-wheel zoom still runs — avoids double-handling).
- **Implementer note (hallucination guard):** verify the exact ReactFlow 12 (`@xyflow/react`) instance-API names (`useReactFlow`, `setViewport`, `zoomTo`, `getViewport`, `screenToFlowPosition`) against the installed version's types/docs before wiring — do not trust memory.

## Testing

- `wheel-gesture.test.ts` (new) — scripted streams, one assertion per event. Must include streams that would have tripped the Round-1 design:
  - **REPORTED-DEVICE regression guard:** a short, bounded, pure-vertical stream of **small fractional ramping** deltas (a hi-res/smooth mouse slow notch: e.g. 3–4 events like 3.4, 6.1, 8.2 px then a gap) → **every event `zoom`**. This is the exact shape the Round-1 classifier mis-panned.
  - slow single mouse notch from idle (small px, vertical-only) → `zoom`.
  - classic line-mode notch → `zoom`.
  - fast repeated notches with inter-notch gaps → `zoom` (bursts, not one sustained run).
  - trackpad horizontal / diagonal swipe → `pan` (step-4 horizontal tell).
  - trackpad pure-vertical sustained swipe → `zoom` for the leading events, then `pan` once the run crosses `CONTINUITY_MIN_EVENTS`/`_MS`; momentum tail stays `pan` (sticky).
  - `ctrlKey` wheel → `zoom` regardless of device.
  - idle gap (> `IDLE_RESET_MS`) between two gestures re-classifies the second independently.
- Update `mindmap-canvas-wheel.test.tsx` and `task-dag-pan-zoom.test.tsx` to the new module.

## Risks & Mitigations

- **R1 (Round-1 blocker) — hi-res/smooth-scroll mouse re-broken.** Eliminated by construction: the classifier never inspects magnitude/fractionality/ramping; the default is zoom; only a horizontal component or a genuinely sustained continuous run flips to pan, neither of which a slow/notched mouse produces. Covered by the explicit REPORTED-DEVICE regression-guard test above.
- **R2 — ReactFlow wheel takeover regresses pinch/drag/node interaction.** Mitigated by leaving `ctrlKey` (pinch) to ReactFlow, keeping `panOnDrag`, and covering the DAG with the updated pan-zoom test; the readonly preview is untouched.
- **R3 — editing the wrong DAG mount.** Round-1 note corrected: edits target `dag-view.tsx` + `proposal-editor.tsx`; `task-dag.tsx`'s `<ReactFlow>` (readonly `TaskDag`) is explicitly out of scope.
- **R4 — `timeStamp` source.** Use `ev.timeStamp` consistently; the classifier uses only *differences*, so the epoch is irrelevant as long as one source is used per stream.
- **R5 — fast free-spin mouse reclassified to pan.** See residual: bounded, err-toward-safe, not the reported bug; continuity thresholds tuned so ordinary mouse scrolling stays zoom.
