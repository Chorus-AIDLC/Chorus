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

### Requirement: Knowledge-graph rendering laid out force-directed

The graph view SHALL render the aggregated nodes and edges as a knowledge graph — an organic node-link layout positioned by a force-directed simulation — rather than a fixed hierarchical tree. The view SHALL support zoom and pan. The three relationship kinds SHALL be visually distinguished from one another, and edges SHALL convey relationship direction.

#### Scenario: Graph renders nodes and edges with pan and zoom

- **WHEN** a user opens the graph view for a project with entities
- **THEN** the entities render as nodes connected by edges in a force-directed layout, and the user can zoom and pan the canvas

#### Scenario: Relationship kinds are visually distinguished

- **WHEN** the graph contains `derive`, `lineage`, and `depends` edges
- **THEN** each kind is rendered distinguishably from the others and indicates its direction

### Requirement: Per-Idea expand and collapse of derivative subgraphs

The graph SHALL group derivatives under their originating Idea and collapse them by default, showing each Idea as a hub. A collapsed Idea node SHALL display a count of its hidden direct derivatives. Activating a collapsed Idea SHALL reveal its derivative Proposals and their Tasks and Documents as a subgraph; activating an expanded Idea SHALL collapse them again. A node with no further derivatives SHALL NOT present an expand affordance. Idea-to-Idea lineage edges SHALL remain visible regardless of expand state.

#### Scenario: Ideas are collapsed by default with a derivative count

- **WHEN** a user opens the graph view
- **THEN** each Idea renders as a hub node showing a count of its hidden direct derivatives, and those derivatives are not yet shown

#### Scenario: Expanding an Idea reveals its subgraph

- **WHEN** a user activates the expand affordance on a collapsed Idea node
- **THEN** that Idea's derivative Proposals, Tasks, and Documents and the edges among them are added to the graph, and the affordance changes to a collapse state

#### Scenario: Collapsing an Idea hides its subgraph again

- **WHEN** a user activates the collapse affordance on an expanded Idea node
- **THEN** that Idea's derivatives are removed from the visible graph and the node returns to showing the derivative count

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

A graph node SHALL highlight in real time when any agent operates on its corresponding entity, reusing the existing per-entity presence signal and presence indicator. A node being viewed by an agent SHALL be highlighted with the read (dashed) treatment; a node being mutated by an agent SHALL be highlighted with the write (solid) treatment; when both occur for a node, the write treatment SHALL take precedence. The highlight SHALL identify the acting agent. When no agent is operating on an entity, its node SHALL show no presence highlight.

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

The graph SHALL update its structure in real time as the project's entities change, reusing the same project-scoped realtime delivery it uses for presence, without requiring a manual page refresh. When an entity is created, deleted, or updated, or when a dependency or lineage relationship changes, the graph SHALL add, remove, or update the corresponding nodes and edges. On such an update, the graph SHALL preserve the force-layout positions of surviving nodes (settling incrementally rather than re-randomizing) and SHALL preserve the user's current expand/collapse state where the affected subgraph is still present. This live structural update SHALL be distinct from presence highlighting, which changes only a node's highlight and not the set of nodes and edges.

#### Scenario: New entity appears in the graph live

- **WHEN** an entity relevant to the project is created while a user has the graph open
- **THEN** a corresponding node (and any new relationship edges) appears in the graph without a manual refresh, and existing nodes keep their positions

#### Scenario: Deleted entity disappears from the graph live

- **WHEN** an entity shown in the graph is deleted
- **THEN** its node and incident edges are removed from the graph without a manual refresh, and the remaining nodes keep their positions

#### Scenario: Dependency change updates edges live

- **WHEN** a task dependency is added or removed, or an idea is reparented
- **THEN** the graph updates the affected `depends` or `lineage` edges (and any Proposal→root-task `derive` edge that changes as a result) without a manual refresh

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

