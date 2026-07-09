## MODIFIED Requirements

### Requirement: Trackpad-first pan and zoom on the interactive task-dependency DAG

The interactive, full-canvas task-dependency DAG — the ReactFlow graph rendered on the tasks view and in the proposal editor — SHALL use ReactFlow's default wheel-zoom model: a wheel event zooms the graph around the cursor, a trackpad pinch zooms, and panning is by dragging. It SHALL NOT infer the pointing device, SHALL NOT pan on wheel, and SHALL NOT require a modifier key to zoom. This is the same wheel/drag configuration the readonly dashboard-preview DAG uses, so all three DAG mounts converge on the same behavior. Zooming SHALL also remain available through the on-screen zoom controls the interactive mounts display, and the resulting scale SHALL clamp to the DAG's existing minimum and maximum zoom bounds. Node dragging, selection, and connection behavior SHALL be unchanged. The compact, readonly DAG preview embedded in the dashboard proposal panel SHALL retain its existing wheel-zoom / drag-pan behavior (now shared by all mounts).

#### Scenario: Wheel zooms the DAG

- **WHEN** a user scrolls a wheel over the tasks-view or proposal-editor DAG
- **THEN** the graph zooms in or out around the cursor rather than panning

#### Scenario: Pinch zooms and drag pans the DAG

- **WHEN** a user pinches on a trackpad, or drags, over the tasks-view or proposal-editor DAG
- **THEN** the graph zooms (pinch) or pans (drag)

#### Scenario: On-screen controls still zoom and fit

- **WHEN** a user clicks the on-screen zoom-in, zoom-out, or fit controls on the tasks-view or proposal-editor DAG
- **THEN** the graph zooms or re-frames as before

#### Scenario: All mounts share the same wheel/drag configuration

- **WHEN** the DAG is shown on the tasks view, in the proposal editor, or as the readonly dashboard preview
- **THEN** all three use ReactFlow's default wheel-zoom + drag-pan configuration

#### Scenario: Node interaction unchanged

- **WHEN** a user drags a node, selects a node, or (in an editable DAG) creates a connection
- **THEN** those interactions behave exactly as they did before the navigation model changed
