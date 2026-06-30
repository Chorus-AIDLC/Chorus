# project-resource-graph Specification (delta)

## ADDED Requirements

### Requirement: Desktop hover tooltip previewing a node's title and status

On the desktop (canvas) rendering of the resource graph, hovering a node SHALL,
after a short delay, display a tooltip anchored beside that node's card. The
tooltip SHALL show the entity's full (untruncated) title and a single badge
conveying the entity's state: for an Idea, Proposal, or Task the badge SHALL
show that entity's lifecycle status; for a Document, which has no lifecycle
status, the badge SHALL show its document type. The tooltip's detail SHALL be
fetched on demand per entity (reusing the existing per-entity read endpoints)
rather than carried in the project aggregation payload, and repeated fetches for
the same node SHALL be avoided (cached for the duration of the view) and a fast
hover sweep across nodes SHALL NOT issue a request for every node passed over.
The tooltip SHALL be anchored to the node card (not tracking the cursor), SHALL
NOT occlude the hovered card, SHALL disappear when the pointer leaves the node,
and SHALL NOT interfere with the existing hover lineage-highlight or with
clicking a node. This tooltip is desktop-only; the mobile vertical outline SHALL
NOT show it. All user-facing text in the tooltip SHALL be localized in both
supported locales.

#### Scenario: Hovering a node shows its title and status badge

- **WHEN** a user hovers a node on the desktop graph canvas and pauses briefly
- **THEN** a tooltip appears beside that node's card showing the entity's full title and a badge with its lifecycle status (or, for a Document, its document type)

#### Scenario: Tooltip detail is fetched on demand and reused

- **WHEN** a node is hovered for the first time
- **THEN** the tooltip's status/type detail is fetched for that single entity via the existing per-entity read endpoint, and hovering the same node again reuses the cached detail without re-fetching

#### Scenario: A fast hover sweep does not fire a request per node

- **WHEN** the pointer moves quickly across many nodes without pausing
- **THEN** no per-node detail request is issued for nodes merely passed over (the fetch is debounced until the hover settles)

#### Scenario: Tooltip clears on mouse-out and does not block interaction

- **WHEN** the pointer leaves the hovered node
- **THEN** the tooltip disappears, and while shown it neither occludes the hovered card nor intercepts clicks intended for the canvas

#### Scenario: Tooltip is desktop-only

- **WHEN** the graph is rendered as the mobile vertical outline (narrow viewport)
- **THEN** no hover tooltip is shown (tapping a row opens the entity's side panel instead)
