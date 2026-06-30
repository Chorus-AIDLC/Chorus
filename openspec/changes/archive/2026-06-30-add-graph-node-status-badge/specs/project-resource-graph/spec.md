## MODIFIED Requirements

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

### Requirement: Type-based node styling and entity-type filtering

Each node SHALL encode its entity type by color and icon and a type label, and SHALL display a **status indicator** drawn from the node's status value. The status indicator SHALL show: for an Idea, Proposal, or Task, a label and color reflecting the entity's status; for a Document, a label and color reflecting its document type. The status indicator's labels and colors SHALL reuse the application's existing status/type vocabulary (the idea tracker's pipeline-status labels and colors for Ideas; the established proposal, task, and document-type labels and colors for the others) so a node reads consistently with the rest of the app, and SHALL be visually consistent between the horizontal canvas and the vertical outline renderings. The status indicator SHALL be placed so it does not overflow the card or obscure the node's title (a long label may be truncated). The graph SHALL provide a filter that toggles the visibility of each of the four entity types.

#### Scenario: Node shows type and status

- **WHEN** the graph renders a node
- **THEN** the node shows a type-specific color, icon, and label, plus a status indicator whose label and color reflect the entity's status (or, for a Document, its document type)

#### Scenario: Status indicator updates live on entity change

- **WHEN** an entity shown in the graph changes status (for example a task moves to done, or a proposal is approved) while a user has the graph open
- **THEN** the affected node's status indicator updates without a manual page refresh

#### Scenario: Status indication is consistent across renderings

- **WHEN** the same node is shown in the horizontal canvas and in the vertical outline
- **THEN** its status indicator conveys the same status with a consistent label and color in both renderings

#### Scenario: Filtering hides a node type

- **WHEN** a user toggles off an entity type in the filter
- **THEN** nodes of that type are hidden from the graph, and toggling it back on restores them

### Requirement: Desktop hover tooltip previewing a node's title and status

On the desktop (canvas) rendering of the resource graph, hovering a node SHALL, after a short delay, display a tooltip anchored beside that node's card showing the entity's full (untruncated) title. Because the node card itself already shows the entity's status, the tooltip SHALL NOT show a status badge — its sole purpose is to reveal the full title that the card may truncate. The tooltip SHALL be anchored to the node card (not tracking the cursor), SHALL NOT occlude the hovered card, SHALL disappear when the pointer leaves the node, and SHALL NOT interfere with the existing hover lineage-highlight or with clicking a node. The title shown by the tooltip SHALL come from data already present in the graph payload, so the tooltip SHALL NOT issue a per-entity network request on hover. This tooltip is desktop-only; the mobile vertical outline SHALL NOT show it. All user-facing text in the tooltip SHALL be localized in both supported locales.

#### Scenario: Hovering a node shows its full title

- **WHEN** a user hovers a node on the desktop graph canvas and pauses briefly
- **THEN** a tooltip appears beside that node's card showing the entity's full, untruncated title and no status badge

#### Scenario: Tooltip does not fetch on hover

- **WHEN** a user hovers nodes on the desktop graph canvas
- **THEN** no per-entity detail network request is issued for the tooltip (the title is taken from the already-loaded graph payload)

#### Scenario: Tooltip clears on mouse-out and does not block interaction

- **WHEN** the pointer leaves the hovered node
- **THEN** the tooltip disappears, and while shown it neither occludes the hovered card nor intercepts clicks intended for the canvas

#### Scenario: Tooltip is desktop-only

- **WHEN** the graph is rendered as the mobile vertical outline (narrow viewport)
- **THEN** no hover tooltip is shown (tapping a row opens the entity's side panel instead)
