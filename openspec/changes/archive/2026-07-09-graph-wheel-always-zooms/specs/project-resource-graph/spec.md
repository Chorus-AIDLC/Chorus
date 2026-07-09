## MODIFIED Requirements

### Requirement: Trackpad two-finger pan and pinch-zoom on the canvas

The canvas mind-map SHALL use a deterministic wheel model in which a wheel event over the canvas ALWAYS zooms the tree around the cursor, at any scroll speed and with no modifier key required, and SHALL NOT infer the pointing device or pan in response to a wheel. Because a browser reports a trackpad pinch as a wheel event, a trackpad pinch SHALL therefore also zoom. Zooming SHALL reuse the existing view transform and SHALL clamp the resulting scale to the same minimum and maximum bounds the touch path uses. Panning SHALL be available through dragging (the existing single-pointer drag-to-pan), not through the wheel. While the pointer is over the canvas, the graph SHALL prevent the browser's default page scroll so the page does not move while zooming. These wheel changes SHALL NOT alter the existing touch gestures (two-finger pinch, double-tap, single-finger drag) or the single-pointer drag-to-pan behavior.

#### Scenario: Plain mouse wheel zooms the tree at any speed

- **WHEN** a user scrolls a plain mouse wheel (no modifier) over the canvas, whether slowly or quickly
- **THEN** the tree zooms around the cursor (scrolling up zooms in, down zooms out), the browser page does not scroll, and the tree does not pan

#### Scenario: Trackpad pinch zooms around the cursor

- **WHEN** a user performs a pinch gesture on a trackpad over the canvas (reported by the browser as a wheel event)
- **THEN** the tree zooms in or out around the cursor position, clamped to the same minimum and maximum zoom bounds as the other zoom paths

#### Scenario: Panning is via drag, not the wheel

- **WHEN** a user wants to pan the tree
- **THEN** they drag with a single pointer (the wheel never pans), and the drag-to-pan behaves exactly as before

#### Scenario: Existing touch and drag behavior unchanged

- **WHEN** a user uses a two-finger touch pinch, a double-tap, a single-finger touch drag, or a single-pointer mouse drag on the canvas
- **THEN** those gestures behave exactly as they did before the wheel model changed
