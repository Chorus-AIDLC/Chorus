# project-resource-graph Specification

## Purpose
TBD - created by archiving change add-project-resource-graph. Update Purpose after archive.
## Requirements
### Requirement: Per-project Graph navigation entry and route

The project left navigation SHALL include a "Graph" entry that links to a per-project route `/projects/[uuid]/graph`, alongside the existing Overview / Documents / Proposals / Tasks / Activity entries. The entry SHALL use a localized label (`nav.graph`) available in both `en` and `zh`, and the route SHALL be project-scoped, resolving the project from the `uuid` route param. The Graph entry SHALL show as active when the current path is the graph route.

#### Scenario: Graph entry appears in project nav

- **WHEN** a user views any page within a project
- **THEN** the left navigation shows a "Graph" entry linking to `/projects/<projectUuid>/graph`, localized per the active locale

#### Scenario: Graph route renders the project's graph

- **WHEN** a user navigates to `/projects/<projectUuid>/graph`
- **THEN** the graph view for that project renders and the "Graph" nav entry is shown active

### Requirement: Project resource aggregation across four entity types

The system SHALL provide a project-scoped aggregation that returns the project's Ideas, Proposals, Tasks, and Documents as graph nodes, and their relationships as typed graph edges, scoped strictly by company and project so no entity from another company or project is ever returned. Each node SHALL carry its UUID, entity type, title, and a **status value** describing the entity's state for display on the node. The status value SHALL be: for an Idea, its derived pipeline status (the same derivation the idea tracker uses, reflecting the idea's proposals and tasks, not merely its stored three-state value); for a Proposal, its lifecycle status; for a Task, its lifecycle status; for a Document, its document type (a Document has no lifecycle status). The status value SHALL be computed server-side from existing columns with no additional per-entity query (no N+1). Each edge SHALL carry a relationship kind of `derive`, `lineage`, or `depends`. An entity with no relationships SHALL still be returned as a standalone node. To keep the graph legible, a Proposal SHALL emit a `derive` edge to a Task only when that Task is a **root task** of the proposal — i.e. it has no dependency on another task within the same proposal; non-root tasks SHALL be reached only transitively through `depends` edges and SHALL NOT receive a direct Proposal→Task `derive` edge. A Proposal SHALL emit a `derive` edge to every Document it materialized.

#### Scenario: Aggregation returns the four entity types as nodes

- **WHEN** the aggregation runs for a project containing ideas, proposals, tasks, and documents
- **THEN** it returns one node per entity, each tagged with its type (`idea`, `proposal`, `task`, or `document`), title, and status value

#### Scenario: Node status reflects the entity's state per type

- **WHEN** the aggregation builds a node
- **THEN** an Idea node's status is its derived pipeline status (computed from its proposals and tasks), a Proposal node's status is its lifecycle status, a Task node's status is its lifecycle status, and a Document node's status is its document type

#### Scenario: Aggregation derives the three relationship kinds

- **WHEN** the aggregation runs for a project
- **THEN** it emits a `lineage` edge for each `Idea.parentUuid` link, a `derive` edge from an Idea to each Proposal whose inputs include that idea, a `derive` edge from a Proposal to each Document materialized from it and to each of its root Tasks, and a `depends` edge for each task dependency

#### Scenario: Proposal links only to its root tasks

- **WHEN** a proposal has materialized a task A with no dependency and a task B that depends on A
- **THEN** the aggregation emits a `derive` edge from the proposal to A but not to B, and B is reachable from A via a `depends` edge

#### Scenario: Aggregation is scoped to the company and project

- **WHEN** the aggregation runs for a project
- **THEN** every returned node and edge belongs to that project within the caller's company, and no entity outside that company or project is included

#### Scenario: Orphan entity appears as a standalone node

- **WHEN** a project contains an entity with no relationships to any other entity
- **THEN** the aggregation returns it as a node with no incident edges, still carrying its status value

### Requirement: Per-Idea expand and collapse of derivative subgraphs

The graph SHALL group derivatives under their originating Idea and collapse them
by default, showing each Idea as the root of its subtree. A collapsed expandable
node SHALL display a count of its hidden direct children. Activating a collapsed
Idea SHALL reveal its derivative Proposals as the next tree level; activating a
collapsed Proposal SHALL reveal its Tasks and Documents as the next level;
activating an expanded node SHALL collapse its revealed children again. A node
with no further derivatives SHALL NOT present an expand affordance. Idea-to-Idea
lineage SHALL always be part of the tree regardless of expand state, so child
Ideas remain visible as subtrees of their parent Idea.

#### Scenario: Ideas are collapsed by default with a derivative count

- **WHEN** a user opens the graph view
- **THEN** each Idea renders as the root of its subtree showing a count of its hidden direct derivatives, and those derivatives are not yet shown

#### Scenario: Expanding a node reveals its next tree level

- **WHEN** a user activates the expand affordance on a collapsed Idea or Proposal node
- **THEN** that node's direct children (an Idea's Proposals, or a Proposal's Tasks and Documents) and the connectors to them are added to the tree, and the affordance changes to a collapse state

#### Scenario: Collapsing a node hides its subtree again

- **WHEN** a user activates the collapse affordance on an expanded node
- **THEN** that node's revealed children are removed from the visible tree and the node returns to showing the child count

#### Scenario: Leaf node shows no expand affordance

- **WHEN** a node has no further derivatives in the four-type model
- **THEN** it renders without any expand or collapse affordance

### Requirement: Type-based node styling and entity-type filtering

Each node SHALL encode its entity type by color and icon and a type label, and SHALL display a status indicator drawn from the node's status value. The status indicator SHALL show: for an Idea, Proposal, or Task, a label and color reflecting the entity's status; for a Document, a label and color reflecting its document type. The status indicator's labels and colors SHALL reuse the application's existing status/type vocabulary (the idea tracker's pipeline-status labels and colors for Ideas; the established proposal, task, and document-type labels and colors for the others) so a node reads consistently with the rest of the app. The status indicator SHALL be placed so it does not overflow the card or obscure the node's title (a long label may be truncated). The graph SHALL provide a filter that toggles the visibility of each of the four entity types.

#### Scenario: Node shows type and status

- **WHEN** the graph renders a node
- **THEN** the node shows a type-specific color, icon, and label, plus a status indicator whose label and color reflect the entity's status (or, for a Document, its document type)

#### Scenario: Status indicator updates live on entity change

- **WHEN** an entity shown in the graph changes status (for example a task moves to done, or a proposal is approved) while a user has the graph open
- **THEN** the affected node's status indicator updates without a manual page refresh

#### Scenario: Filtering hides a node type

- **WHEN** a user toggles off an entity type in the filter
- **THEN** nodes of that type are hidden from the graph, and toggling it back on restores them

### Requirement: Agent-presence node highlighting

A graph node SHALL highlight in real time when any agent operates on its corresponding entity, reusing the existing per-entity presence signal and presence indicator. A node being viewed by an agent SHALL be highlighted with the read (dashed) treatment; a node being mutated by an agent SHALL be highlighted with the write (solid) treatment; when both occur for a node, the write treatment SHALL take precedence. The highlight SHALL identify the acting agent. When no agent is operating on an entity, its node SHALL show no presence highlight. The highlight SHALL apply in the canvas rendering.

#### Scenario: Viewing agent highlights a node with the read treatment

- **WHEN** an agent performs a read operation on an entity shown in the graph
- **THEN** that entity's node is highlighted with the read (dashed) treatment and identifies the acting agent

#### Scenario: Mutating agent highlights a node with the write treatment

- **WHEN** an agent performs a write operation on an entity shown in the graph
- **THEN** that entity's node is highlighted with the write (solid) treatment and identifies the acting agent

#### Scenario: Highlight clears when presence ends

- **WHEN** no agent has operated on an entity within the presence signal's active window
- **THEN** that entity's node shows no presence highlight

### Requirement: Live structural updates on entity changes

The graph SHALL update its structure in real time as the project's entities
change, reusing the same project-scoped realtime delivery it uses for presence,
without requiring a manual page refresh. When an entity is created, deleted, or
updated, or when a dependency or lineage relationship changes, the graph SHALL
add, remove, or update the corresponding nodes and edges. On such an update, the
graph SHALL recompute the deterministic tree layout and animate surviving nodes
to their new positions (rather than re-randomizing or re-simulating), and SHALL
preserve the user's current expand/collapse state where the affected subtree is
still present. This live structural update SHALL be distinct from presence
highlighting, which changes only a node's highlight and not the set of nodes and
edges.

#### Scenario: New entity appears in the graph live

- **WHEN** an entity relevant to the project is created while a user has the graph open
- **THEN** a corresponding node (and any new connectors) appears in the tree without a manual refresh, and surviving nodes animate to their recomputed positions

#### Scenario: Deleted entity disappears from the graph live

- **WHEN** an entity shown in the graph is deleted
- **THEN** its node and incident edges are removed from the tree without a manual refresh, and the remaining nodes animate to their recomputed positions

#### Scenario: Dependency change updates edges live

- **WHEN** a task dependency is added or removed, or an idea is reparented
- **THEN** the graph updates the affected `depends` or `lineage` edges (and any Proposal→root-task `derive` connector that changes as a result) without a manual refresh

### Requirement: Node click opens a reused side panel

Clicking a node SHALL open a side preview panel for that entity, reusing the existing per-entity panels rather than navigating away from the graph. An Idea node SHALL open the existing Idea detail panel; a Task node SHALL open the existing Task detail panel; a Proposal node SHALL open the idea tracker focused on its Proposal tab; a Document node SHALL open the existing standalone Document panel. The graph SHALL remain mounted while the panel is open so exploration can continue, and the selected node SHALL retain a selection indication.

#### Scenario: Clicking an Idea node opens the Idea panel

- **WHEN** a user clicks an Idea node
- **THEN** the existing Idea detail panel opens for that idea while the graph stays mounted

#### Scenario: Clicking a Proposal node opens the Proposal tab

- **WHEN** a user clicks a Proposal node
- **THEN** the idea tracker opens focused on the Proposal tab for that proposal's source idea

#### Scenario: Clicking a Task node opens the Task panel

- **WHEN** a user clicks a Task node
- **THEN** the existing Task detail panel opens for that task while the graph stays mounted

#### Scenario: Clicking a Document node opens the Document panel

- **WHEN** a user clicks a Document node
- **THEN** the existing standalone Document panel opens for that document while the graph stays mounted

### Requirement: Mind-map tree rendering

The graph view SHALL render the aggregated nodes and edges as a deterministic, collapsible mind-map tree on every viewport; there is no separate narrow-viewport rendering. The tree SHALL be laid out horizontally on all viewports — root Ideas on the left with derivation growing rightward, so a node's horizontal depth encodes its derivation level — and multiple root Ideas SHALL stack vertically. Node coordinates SHALL be computed deterministically (a tree layout, not a physics simulation), so that identical inputs and expand state produce identical positions and no node moves except in response to an expand, collapse, or user action. The view SHALL support zoom and pan; on a device with a mouse this is the wheel-to-zoom and drag-to-pan behavior, and on a touch device this is the pinch, double-tap, and drag behavior defined by the touch-gesture requirement. On the first non-empty layout the view SHALL fit the whole tree to the viewport exactly once, so that on any viewport (including a small phone screen) the user initially sees the entire tree before zooming in, and the view SHALL NOT auto-refit on later updates. The `derive` and `lineage` edges form the tree's connectors and SHALL be drawn as solid links that convey direction toward the derived node. The `depends` edges and any multi-source proposal links are NOT tree edges: they SHALL be drawn as a distinct dashed-style overlay that does not affect the tree layout, SHALL be visually quiet by default, and SHALL emphasize only when a node they connect is hovered or selected. The three relationship kinds SHALL remain visually distinguishable from one another.

#### Scenario: Tree renders horizontally with pan and zoom on any viewport

- **WHEN** a user opens the graph view for a project with entities on any viewport
- **THEN** the entities render as a horizontal mind-map tree with root Ideas on the left and derivatives to the right, and the user can zoom and pan the view

#### Scenario: Graph fits the whole tree to the viewport on first load

- **WHEN** the graph view first renders a non-empty tree on any viewport, including a narrow phone screen
- **THEN** the view is fit once so the entire tree is visible, and it is not automatically refit on subsequent updates

#### Scenario: Layout is deterministic and does not jitter

- **WHEN** the graph is displayed and the user expands or collapses a node, or drags a node, or a live update arrives
- **THEN** node positions are recomputed deterministically and only the affected nodes move (animating to their new positions), with no force-simulation re-settling of the whole graph

#### Scenario: Relationship kinds are visually distinguished and tree vs non-tree edges differ

- **WHEN** the graph contains `derive`, `lineage`, and `depends` edges
- **THEN** `derive` and `lineage` render as solid tree connectors indicating direction toward the derived node, while `depends` (and any multi-source proposal link) renders as a distinct dashed overlay that does not change the tree layout

#### Scenario: Non-tree overlay edges stay quiet until related node is focused

- **WHEN** no node is hovered or selected
- **THEN** the `depends` / multi-source overlay edges are visually quiet, and hovering or selecting a node they connect emphasizes those edges

### Requirement: Desktop hover tooltip previewing a node's title and status

On the canvas rendering of the resource graph, hovering a node with a pointer SHALL, after a short delay, display a tooltip anchored beside that node's card showing the entity's full (untruncated) title. Because the node card itself already shows the entity's status, the tooltip SHALL NOT show a status badge — its sole purpose is to reveal the full title that the card may truncate. The tooltip SHALL be anchored to the node card (not tracking the cursor), SHALL NOT occlude the hovered card, SHALL disappear when the pointer leaves the node, and SHALL NOT interfere with the existing hover lineage-highlight or with clicking a node. The title shown by the tooltip SHALL come from data already present in the graph payload, so the tooltip SHALL NOT issue a per-entity network request on hover. Because it is driven by a hovering pointer, the tooltip appears only on a device with a mouse; on a touch device, where there is no hover, the tooltip SHALL NOT appear, and a tap SHALL instead open the node's side panel so the full title is read there. All user-facing text in the tooltip SHALL be localized in both supported locales.

#### Scenario: Hovering a node shows its full title

- **WHEN** a user hovers a node on the graph canvas with a pointer and pauses briefly
- **THEN** a tooltip appears beside that node's card showing the entity's full, untruncated title and no status badge

#### Scenario: Tooltip does not fetch on hover

- **WHEN** a user hovers nodes on the graph canvas
- **THEN** no per-entity detail network request is issued for the tooltip (the title is taken from the already-loaded graph payload)

#### Scenario: Tooltip clears on mouse-out and does not block interaction

- **WHEN** the pointer leaves the hovered node
- **THEN** the tooltip disappears, and while shown it neither occludes the hovered card nor intercepts clicks intended for the canvas

#### Scenario: Tooltip does not appear on touch

- **WHEN** the graph is used on a touch device, where there is no hover
- **THEN** no hover tooltip is shown, and tapping a node opens that entity's side panel instead

### Requirement: Node search with highlight, dim, and auto-expand to matches

The resource-graph view SHALL provide a search input that filters nodes by a case-insensitive substring match on the node title only (not on type or status text, and not fuzzy). As the query changes, the graph SHALL keep every matching node at full opacity, SHALL dim every non-matching node using the same dim treatment the hover lineage-highlight uses, and SHALL automatically expand the ancestor hubs (the matching node's idea and, where applicable, its proposal) so that every match becomes visible even when it was hidden under a collapsed hub. Matching SHALL be restricted to entity types currently visible under the type filter, so a filtered-out type produces no matches, and search SHALL NOT change the type-filter selections. The title used for matching SHALL come from data already present in the graph payload, so search SHALL NOT issue any per-entity or backend search request. When the query is empty or blank the graph SHALL behave as if no search is active (all nodes at normal opacity, no forced expansion). All user-facing search text SHALL be localized in both supported locales.

#### Scenario: Typing a query highlights matches and dims the rest

- **WHEN** a user types a query that matches one or more node titles
- **THEN** the matching nodes stay at full opacity, every other node is dimmed, and the ancestor hubs of each match are expanded so the matches are visible

#### Scenario: Match is case-insensitive substring on title only

- **WHEN** a user types a query in any letter case
- **THEN** a node matches when its title contains the query as a case-insensitive substring, and a node does not match merely because the query appears in its type or status text

#### Scenario: Search does not query the backend

- **WHEN** a user types or edits the query
- **THEN** matching is computed from the already-loaded graph payload and no per-entity detail request or backend search request is issued

#### Scenario: Search respects the type filter

- **WHEN** a type is toggled off in the filter and the query would match a node of that type
- **THEN** that node does not count as a match and the type-filter checkboxes are left unchanged by the search

#### Scenario: Clearing the query returns to the unsearched view

- **WHEN** the query becomes empty or blank
- **THEN** all nodes return to normal opacity and no node is dimmed by search

### Requirement: Hover lineage-highlight takes over during an active search

While a search is active, the hover (and selection) lineage-highlight SHALL take precedence over the search highlight. When the user hovers a node during an active search, the graph SHALL light that node's full upstream-and-downstream lineage and dim everything else — including other search matches — exactly as it does without a search; the search match set SHALL drive node opacity only when no node is hovered or selected. The current-match navigation cursor SHALL NOT trigger the lineage-highlight, so stepping through matches does not light up a match's ancestors and descendants.

#### Scenario: Hovering during search lights only the hovered node's lineage

- **WHEN** a search is active and the user hovers a node
- **THEN** only that node's upstream and downstream lineage is highlighted and everything else is dimmed, including other matches

#### Scenario: Matches drive opacity only when nothing is hovered

- **WHEN** a search is active and the pointer is not over any node
- **THEN** the matching nodes are highlighted and non-matching nodes are dimmed

#### Scenario: Stepping to a match does not light its lineage

- **WHEN** the user navigates to a match via the previous/next controls
- **THEN** the current match is indicated and centered but its ancestors and descendants are not lineage-highlighted

### Requirement: Match count and previous/next navigation centered on each match

The search controls SHALL display a match count and SHALL support stepping through matches. The controls SHALL show the current position and total number of matches (for example `3 / 12`), and SHALL provide previous and next actions that move a current-match cursor through the matches in their top-to-bottom reading order, wrapping around from the last match to the first and from the first to the last. Pressing Enter in the search input SHALL step to the next match and pressing Shift+Enter SHALL step to the previous match, using the same wrap-around cursor as the previous/next actions; this key handling SHALL be suppressed while an IME composition is in progress so confirming a candidate word does not advance the match. Activating a match as current SHALL bring it into view by centering the camera on that node; because the graph renders as a canvas on all viewports, camera centering is the single bring-into-view behavior. The current match SHALL receive a distinct visual indication separate from the plain-match highlight and from the selection indication. Recentering the camera in response to query edits SHALL be debounced so the view does not jump on every keystroke.

#### Scenario: Count shows current position and total

- **WHEN** a search has one or more matches
- **THEN** the controls show the current match position and the total match count, and a current match is indicated distinctly

#### Scenario: Next and previous step with wrap-around

- **WHEN** the user activates next on the last match, or previous on the first match
- **THEN** the cursor wraps to the first match (for next) or the last match (for previous), and the newly current match is brought into view and centered

#### Scenario: Enter and Shift+Enter step through matches

- **WHEN** the user presses Enter (or Shift+Enter) in the search input while not composing with an IME
- **THEN** the current-match cursor advances to the next match (or the previous match for Shift+Enter) with the same wrap-around and brings the new current match into view

#### Scenario: Enter during IME composition does not advance

- **WHEN** the user presses Enter to confirm an IME candidate word in the search input
- **THEN** the match cursor does not advance (the key handling is suppressed while composing)

#### Scenario: Current match is centered on the canvas

- **WHEN** a match becomes the current match
- **THEN** the canvas centers the camera on that node so it is brought into view

#### Scenario: Empty result shows a no-matches hint and disables stepping

- **WHEN** a query matches no nodes
- **THEN** the controls show a localized no-matches hint, the count shows zero, the previous/next actions are disabled, and all nodes remain at normal opacity (the tree is not dimmed)

### Requirement: Touch pinch, double-tap, and drag gestures on the canvas

The canvas mind-map SHALL be zoomable and pannable by touch on a touch device, reusing the same view transform (scale plus translation) and the same zoom clamp the mouse-wheel path uses. A two-finger pinch SHALL zoom the tree — spreading the fingers zooms in and pinching them together zooms out — anchored on the midpoint between the two touch points so the graph point under that midpoint stays under it during the gesture; while the two fingers move, the tree SHALL also pan to follow the midpoint, giving a map-like feel where the graph both scales and moves with the fingers. A double-tap SHALL zoom in centered on the tapped point, and a subsequent double-tap SHALL reset the zoom, so a double-tap toggles between a zoomed-in view and the fit view. A single-finger drag SHALL pan the tree as it does today. The resulting scale SHALL be clamped to the same minimum and maximum bounds the wheel zoom uses. These touch gestures SHALL NOT change the existing mouse behavior (wheel zoom, drag pan) on a pointer device.

#### Scenario: Two-finger pinch zooms around the midpoint

- **WHEN** a user places two fingers on the canvas and spreads them apart or pinches them together
- **THEN** the tree zooms in or out around the midpoint between the fingers, staying within the same minimum and maximum zoom bounds as the wheel zoom

#### Scenario: Pinch follows the two-finger midpoint

- **WHEN** a user moves two fingers across the canvas during a pinch
- **THEN** the tree pans to follow the midpoint of the two fingers while zooming, giving a map-like combined zoom-and-move

#### Scenario: Double-tap zooms in and toggles back

- **WHEN** a user double-taps a point on the canvas
- **THEN** the view zooms in centered on that point, and a further double-tap resets the view to the fit zoom

#### Scenario: Single-finger drag still pans

- **WHEN** a user drags with one finger on the canvas
- **THEN** the tree pans, unchanged from the existing single-pointer pan behavior

#### Scenario: Mouse behavior is unchanged

- **WHEN** a user uses a mouse wheel or a drag on a pointer device
- **THEN** zoom and pan behave exactly as they did before the touch gestures were added

### Requirement: Collapsible control panel on narrow viewports

The graph's control panel (the top-right card holding the node-search input, the entity-type filter, and the expand-all / collapse-all action) SHALL, on a narrow (mobile) viewport, collapse by default to a single compact control (an icon button) so it does not obscure the canvas, and SHALL expand to reveal the full panel only when the user activates that control. On a wide (desktop) viewport the panel SHALL remain shown as it is today. When expanded on a narrow viewport the panel SHALL offer all the same controls (search, type filter, expand / collapse-all) as the desktop panel, and the user SHALL be able to collapse it again. Collapsing or expanding the panel SHALL NOT change the search query, the type-filter selections, or the expand / collapse state of the tree.

#### Scenario: Panel is collapsed to an icon on a narrow viewport

- **WHEN** a user opens the graph view on a narrow (mobile) viewport
- **THEN** the control panel is collapsed to a single compact control that does not obscure the canvas

#### Scenario: Activating the control expands the full panel

- **WHEN** a user activates the collapsed control on a narrow viewport
- **THEN** the full panel opens with the search input, the type filter, and the expand / collapse-all action, and the user can collapse it again

#### Scenario: Desktop panel is unchanged

- **WHEN** a user opens the graph view on a wide (desktop) viewport
- **THEN** the control panel is shown expanded as before, not collapsed to an icon

#### Scenario: Toggling the panel preserves state

- **WHEN** a user collapses or expands the panel while a search query, a type-filter change, or a tree expansion is active
- **THEN** the query, the filter selections, and the tree expand / collapse state are all preserved

### Requirement: Clearing search preserves search-expanded nodes

When a search ends, the graph SHALL keep every currently expanded node expanded — including hubs that were auto-expanded to reveal matches — rather than collapsing back to the pre-search layout. Clearing the query (via the clear control, the Escape key, or the query becoming blank) SHALL clear only the pure-search visual state — the match highlight, the non-match dim, the match count, and the current-match navigation cursor — and SHALL NOT collapse any expanded hub. The graph SHALL NOT snapshot the pre-search expand state and SHALL NOT restore it on exit. Auto-expansion during a search SHALL continue to only add expanded hubs and SHALL never collapse a hub the user had expanded.

#### Scenario: Cleared search keeps the nodes it expanded

- **WHEN** a search auto-expanded hubs to reveal matches and the user then clears the query
- **THEN** those hubs stay expanded and the located branches remain visible, rather than collapsing back to the pre-search layout

#### Scenario: Clearing search removes only the search visual state

- **WHEN** the user clears the query
- **THEN** the match highlight, the non-match dim, the match count, and the current-match cursor are removed, while the expand / collapse state of every node is left unchanged

#### Scenario: Manual collapse still works after clearing

- **WHEN** the user clears a search and then collapses a hub that had been expanded to reveal a match
- **THEN** that hub collapses normally, because expansion is now ordinary user-controlled state with no search snapshot overriding it

