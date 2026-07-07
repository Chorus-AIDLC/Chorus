# task-dag-navigation — Trackpad-first pan/zoom for the ReactFlow task DAG (delta)

## ADDED Requirements

### Requirement: Trackpad-first pan and zoom on the interactive task-dependency DAG

The interactive, full-canvas task-dependency DAG — the ReactFlow graph rendered on the tasks view and in the proposal editor — SHALL adopt a Figma/Miro-style trackpad navigation model, applied consistently across those mounts. A two-finger trackpad swipe (and, generally, a scroll gesture) SHALL pan the graph freely on both axes rather than zoom it. Zooming SHALL remain available through a trackpad pinch, through holding Ctrl or Command while scrolling, and through the on-screen zoom controls that these mounts display. Dragging SHALL continue to pan the graph, and node dragging, selection, and connection behavior SHALL be unchanged. The pan/zoom configuration SHALL be defined once as a single shared constant and applied to every in-scope mount so the surfaces cannot drift apart. The compact, readonly DAG preview embedded in the dashboard proposal panel (which hides the on-screen controls and lives inside a scrollable page) SHALL be excluded from this model and SHALL retain its existing wheel-zoom / drag-pan behavior, so that its only zoom affordance is not removed and it does not hijack page scroll.

#### Scenario: Two-finger swipe pans the DAG

- **WHEN** a user performs a two-finger trackpad swipe over the tasks-view or proposal-editor DAG
- **THEN** the graph pans on both axes rather than zooming

#### Scenario: Pinch and Ctrl/Command+scroll still zoom the DAG

- **WHEN** a user pinches on a trackpad, or holds Ctrl or Command while scrolling, over the tasks-view or proposal-editor DAG
- **THEN** the graph zooms in or out

#### Scenario: On-screen controls still zoom and fit

- **WHEN** a user clicks the on-screen zoom-in, zoom-out, or fit controls on the tasks-view or proposal-editor DAG
- **THEN** the graph zooms or re-frames as before

#### Scenario: Consistent across the in-scope mounts via one shared config

- **WHEN** the DAG is shown on the tasks view or in the proposal editor
- **THEN** both use the same shared pan-on-scroll / zoom configuration constant

#### Scenario: Readonly dashboard preview is excluded

- **WHEN** the compact readonly DAG preview is shown in the dashboard proposal panel
- **THEN** it retains its existing wheel-zoom and drag-pan behavior and is not switched to pan-on-scroll, so its zoom affordance is preserved and it does not hijack page scroll

#### Scenario: Node interaction unchanged

- **WHEN** a user drags a node, selects a node, or (in an editable DAG) creates a connection
- **THEN** those interactions behave exactly as they did before the navigation model changed
