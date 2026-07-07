# project-resource-graph — Trackpad gestures & on-screen zoom controls (delta)

## ADDED Requirements

### Requirement: Trackpad two-finger pan and pinch-zoom on the canvas

The canvas mind-map SHALL support a trackpad (touchpad) two-finger swipe to pan the tree and a trackpad pinch to zoom it, following the Figma/Miro interaction model, while preserving the existing mouse-wheel-to-zoom behavior. Wheel events over the canvas SHALL be classified as follows: a wheel event carrying `ctrlKey` (how a browser reports a trackpad pinch, and also the explicit Ctrl/⌘+wheel zoom shortcut) SHALL zoom the tree around the cursor; a plain wheel event that carries a horizontal component or reads as a fine-grained trackpad scroll SHALL pan the tree by the event's horizontal and vertical deltas; and a plain, coarse, vertical-only wheel event (a mouse-wheel notch) SHALL zoom the tree around the cursor exactly as it did before this change. Panning and zooming SHALL reuse the existing view transform and SHALL clamp the resulting scale to the same minimum and maximum bounds the touch and prior wheel paths use. While the pointer is over the canvas and a gesture is classified, the graph SHALL prevent the browser's default page scroll so the page does not move during a pan or zoom. These wheel-gesture changes SHALL NOT alter the existing touch gestures (two-finger pinch, double-tap, single-finger drag) or the single-pointer drag-to-pan behavior.

#### Scenario: Two-finger trackpad swipe pans the tree

- **WHEN** a user performs a two-finger swipe on a trackpad while the pointer is over the canvas
- **THEN** the tree pans in the direction of the swipe (both horizontally and vertically) and the browser page does not scroll

#### Scenario: Trackpad pinch zooms around the cursor

- **WHEN** a user performs a pinch gesture on a trackpad over the canvas (reported by the browser as a wheel event with the control modifier)
- **THEN** the tree zooms in or out around the cursor position, clamped to the same minimum and maximum zoom bounds as the other zoom paths

#### Scenario: Ctrl or Command plus wheel zooms

- **WHEN** a user holds Ctrl or Command and scrolls the wheel over the canvas
- **THEN** the tree zooms around the cursor rather than panning

#### Scenario: Mouse wheel still zooms

- **WHEN** a user scrolls a plain mouse wheel (a coarse, vertical-only notch with no modifier) over the canvas
- **THEN** the tree zooms around the cursor exactly as it did before this change

#### Scenario: Existing touch and drag behavior unchanged

- **WHEN** a user uses a two-finger touch pinch, a double-tap, a single-finger touch drag, or a single-pointer mouse drag on the canvas
- **THEN** those gestures behave exactly as they did before the trackpad wheel gestures were added

### Requirement: On-screen zoom and fit controls on the graph canvas

The graph canvas SHALL present an on-screen control cluster offering zoom-in, zoom-out, and fit-to-view (reset) actions, so a user can change the zoom and re-frame the whole tree without relying on any trackpad gesture, mouse wheel, or modifier key. Zoom-in and zoom-out SHALL step the zoom by a fixed factor centered on the viewport, clamped to the same minimum and maximum zoom bounds as the gesture paths. Fit-to-view SHALL re-frame the entire tree centered in the viewport, using the same fit computation the first-load fit and the double-tap reset use. Each control SHALL carry an accessible label and a tooltip, and all of its user-facing text SHALL be internationalized in both supported locales. The control cluster SHALL be hidden when the graph is empty (there is nothing to zoom or fit).

#### Scenario: Zoom-in and zoom-out buttons change the zoom

- **WHEN** a user clicks the zoom-in or zoom-out control
- **THEN** the tree zooms in or out by a fixed step centered on the viewport, staying within the minimum and maximum zoom bounds

#### Scenario: Fit control re-frames the whole tree

- **WHEN** a user clicks the fit-to-view control
- **THEN** the view re-frames the entire tree centered in the viewport, matching the first-load fit

#### Scenario: Controls are accessible and localized

- **WHEN** the control cluster is shown
- **THEN** each button exposes an accessible label and a tooltip whose text is internationalized in both supported locales

#### Scenario: Controls hidden when the graph is empty

- **WHEN** the project has no Ideas, Proposals, Tasks, or Documents to graph
- **THEN** the zoom/fit control cluster is not shown
