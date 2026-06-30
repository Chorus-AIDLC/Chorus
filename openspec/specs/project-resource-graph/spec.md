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

The system SHALL provide a project-scoped aggregation that returns the project's Ideas, Proposals, Tasks, and Documents as graph nodes, and their relationships as typed graph edges, scoped strictly by company and project so no entity from another company or project is ever returned. Each node SHALL carry its UUID, entity type, and title. Each edge SHALL carry a relationship kind of `derive`, `lineage`, or `depends`. An entity with no relationships SHALL still be returned as a standalone node. To keep the graph legible, a Proposal SHALL emit a `derive` edge to a Task only when that Task is a **root task** of the proposal — i.e. it has no dependency on another task within the same proposal; non-root tasks SHALL be reached only transitively through `depends` edges and SHALL NOT receive a direct Proposal→Task `derive` edge. A Proposal SHALL emit a `derive` edge to every Document it materialized.

#### Scenario: Aggregation returns the four entity types as nodes

- **WHEN** the aggregation runs for a project containing ideas, proposals, tasks, and documents
- **THEN** it returns one node per entity, each tagged with its type (`idea`, `proposal`, `task`, or `document`) and title

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
- **THEN** the aggregation returns it as a node with no incident edges

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

Each node SHALL encode its entity type by color and icon and a type label, and SHALL NOT display an entity status badge on the node itself. The graph SHALL provide a filter that toggles the visibility of each of the four entity types.

#### Scenario: Node styling encodes type, not status

- **WHEN** the graph renders a node
- **THEN** the node shows a type-specific color, icon, and label, and does not show a status badge

#### Scenario: Filtering hides a node type

- **WHEN** a user toggles off an entity type in the filter
- **THEN** nodes of that type are hidden from the graph, and toggling it back on restores them

### Requirement: Agent-presence node highlighting

A graph node SHALL highlight in real time when any agent operates on its
corresponding entity, reusing the existing per-entity presence signal and
presence indicator. A node being viewed by an agent SHALL be highlighted with
the read (dashed) treatment; a node being mutated by an agent SHALL be
highlighted with the write (solid) treatment; when both occur for a node, the
write treatment SHALL take precedence. The highlight SHALL identify the acting
agent. When no agent is operating on an entity, its node SHALL show no presence
highlight. The highlight SHALL apply in both the horizontal canvas and the
vertical outline renderings.

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

The graph view SHALL render the aggregated nodes and edges as a deterministic,
collapsible **mind-map tree** rather than a force-directed layout. On a
wide (desktop) viewport the tree SHALL be laid out horizontally — root Ideas on
the left with derivation growing rightward, so a node's horizontal depth encodes
its derivation level — and multiple root Ideas SHALL stack vertically. Node
coordinates SHALL be computed deterministically (a tree layout, not a physics
simulation), so that identical inputs and expand state produce identical
positions and no node moves except in response to an expand, collapse, or user
action. The view SHALL support zoom and pan. The `derive` and `lineage` edges
form the tree's connectors and SHALL be drawn as solid links that convey
direction toward the derived node. The `depends` edges and any multi-source
proposal links are NOT tree edges: they SHALL be drawn as a distinct
dashed-style overlay that does not affect the tree layout, SHALL be visually
quiet by default, and SHALL emphasize only when a node they connect is hovered
or selected. The three relationship kinds SHALL remain visually distinguishable
from one another.

#### Scenario: Tree renders horizontally with pan and zoom on desktop

- **WHEN** a user opens the graph view for a project with entities on a wide viewport
- **THEN** the entities render as a horizontal mind-map tree with root Ideas on the left and derivatives to the right, and the user can zoom and pan the canvas

#### Scenario: Layout is deterministic and does not jitter

- **WHEN** the graph is displayed and the user expands or collapses a node, or drags a node, or a live update arrives
- **THEN** node positions are recomputed deterministically and only the affected nodes move (animating to their new positions), with no force-simulation re-settling of the whole graph

#### Scenario: Relationship kinds are visually distinguished and tree vs non-tree edges differ

- **WHEN** the graph contains `derive`, `lineage`, and `depends` edges
- **THEN** `derive` and `lineage` render as solid tree connectors indicating direction toward the derived node, while `depends` (and any multi-source proposal link) renders as a distinct dashed overlay that does not change the tree layout

#### Scenario: Non-tree overlay edges stay quiet until related node is focused

- **WHEN** no node is hovered or selected
- **THEN** the `depends` / multi-source overlay edges are visually quiet, and hovering or selecting a node they connect emphasizes those edges

### Requirement: Responsive vertical outline on narrow viewports

On a narrow (mobile) viewport the graph SHALL render the same tree — with the
same expand/collapse state — as a **vertical indented outline** that scrolls
top-to-bottom, instead of the horizontal canvas. Each visible node SHALL appear
as a row indented in proportion to its derivation depth, preserving the
left-to-right desktop hierarchy as a top-to-bottom indented hierarchy. The
outline SHALL present the same expand/collapse affordance and the same
node-activation behavior (opening the node's side panel) as the desktop view,
operating on the same shared expand state so switching viewport size does not
lose the user's expansion.

#### Scenario: Narrow viewport renders a vertical indented outline

- **WHEN** a user opens the graph view on a narrow (mobile) viewport
- **THEN** the tree renders as a vertical, top-to-bottom indented outline where each node's indentation reflects its derivation depth, rather than the horizontal canvas

#### Scenario: Expand state is shared across viewport sizes

- **WHEN** a user expands a node and the viewport changes between wide and narrow
- **THEN** the same nodes remain expanded in both the horizontal canvas and the vertical outline, because both render from the same expand state

#### Scenario: Outline supports expand and panel-open

- **WHEN** a user activates a node's expand affordance, or activates the node body, in the vertical outline
- **THEN** the affordance toggles that node's subtree, and activating the body opens the same per-entity side panel the desktop view opens

