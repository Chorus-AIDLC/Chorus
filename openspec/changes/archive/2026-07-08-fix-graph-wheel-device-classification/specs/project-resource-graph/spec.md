## MODIFIED Requirements

### Requirement: Trackpad two-finger pan and pinch-zoom on the canvas

The canvas mind-map SHALL support a trackpad (touchpad) two-finger swipe to pan the tree and a trackpad pinch to zoom it, following the Figma/Miro interaction model, while preserving the existing mouse-wheel-to-zoom behavior at ANY scroll speed. Wheel events over the canvas SHALL be classified by inferring the pointing device from the rhythm and continuity of the recent stream of wheel events, and SHALL NOT use any single event's delta magnitude, fractional value, or per-event magnitude ramp as a mouse-versus-trackpad signal (because a high-resolution or smooth-scroll mouse produces small, fractional, ramping deltas indistinguishable per-event from a trackpad). The classification SHALL behave as follows: a wheel event carrying `ctrlKey` (how a browser reports a trackpad pinch, and also the explicit Ctrl/⌘+wheel zoom shortcut) SHALL zoom the tree around the cursor; a wheel event with a line or page delta mode SHALL be treated as a mouse wheel and zoom; a wheel event carrying a horizontal component SHALL be treated as a trackpad swipe and pan; a stream that becomes a sustained continuous run (many closely-spaced events over a minimum duration, as a two-finger swipe and its momentum tail produce) SHALL be treated as a trackpad and pan by the event's horizontal and vertical deltas; and an otherwise-ambiguous vertical wheel event — including a slow mouse-wheel notch and the leading events of any gesture before a device is inferred — SHALL default to a mouse-wheel zoom around the cursor. A slow mouse-wheel notch SHALL zoom, not pan. After a brief idle gap the inferred device SHALL reset so a new gesture is classified on its own evidence. Panning and zooming SHALL reuse the existing view transform and SHALL clamp the resulting scale to the same minimum and maximum bounds the touch and prior wheel paths use. While the pointer is over the canvas and a gesture is classified, the graph SHALL prevent the browser's default page scroll so the page does not move during a pan or zoom. These wheel-gesture changes SHALL NOT alter the existing touch gestures (two-finger pinch, double-tap, single-finger drag) or the single-pointer drag-to-pan behavior.

#### Scenario: Two-finger trackpad swipe pans the tree

- **WHEN** a user performs a two-finger swipe on a trackpad while the pointer is over the canvas
- **THEN** the tree pans in the direction of the swipe (both horizontally and vertically) and the browser page does not scroll

#### Scenario: Trackpad pinch zooms around the cursor

- **WHEN** a user performs a pinch gesture on a trackpad over the canvas (reported by the browser as a wheel event with the control modifier)
- **THEN** the tree zooms in or out around the cursor position, clamped to the same minimum and maximum zoom bounds as the other zoom paths

#### Scenario: Ctrl or Command plus wheel zooms

- **WHEN** a user holds Ctrl or Command and scrolls the wheel over the canvas
- **THEN** the tree zooms around the cursor rather than panning

#### Scenario: Slow mouse wheel zooms

- **WHEN** a user scrolls a plain mouse wheel slowly over the canvas, so each notch reports a small vertical pixel delta separated by gaps
- **THEN** the tree zooms around the cursor rather than panning, because a short bounded vertical burst is not a sustained continuous run and defaults to a mouse-wheel zoom

#### Scenario: High-resolution or smooth-scroll mouse wheel zooms

- **WHEN** a user scrolls a high-resolution or smooth-scroll mouse whose vertical notch reports small, fractional, ramping pixel deltas over the canvas
- **THEN** the tree zooms around the cursor rather than panning, because the classifier does not treat small, fractional, or ramping deltas as a trackpad signal and the short vertical burst defaults to zoom

#### Scenario: Fast mouse wheel still zooms

- **WHEN** a user scrolls a plain mouse wheel quickly over the canvas (a coarse or rapidly repeated vertical-only notch with no modifier)
- **THEN** the tree zooms around the cursor exactly as it did before this change

#### Scenario: Existing touch and drag behavior unchanged

- **WHEN** a user uses a two-finger touch pinch, a double-tap, a single-finger touch drag, or a single-pointer mouse drag on the canvas
- **THEN** those gestures behave exactly as they did before the wheel-classification change
