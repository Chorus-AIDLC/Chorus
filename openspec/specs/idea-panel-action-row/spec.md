# idea-panel-action-row Specification

## Purpose
TBD - created by archiving change refine-idea-panel-action-row. Update Purpose after archive.
## Requirements
### Requirement: Reassign entry on the assignee block

The dashboard idea-tracker detail panel SHALL trigger reassignment from the assignee block shown in the elaboration tab, and SHALL NOT render a standalone reassign button in the footer action row.

The assignee block acts as the reassign trigger only while the idea is editable — the same condition that previously gated the footer button (`idea.status !== "elaborated"`, i.e. `open` or `elaborating`). Once the idea is `elaborated` the block is read-only and does not open the reassign modal. The clickable affordance is minimal: a pointer cursor plus a tooltip (and an `aria-label`) reading "Reassign" when an assignee exists or "Assign" when unassigned. No hover-background tint or hover pencil icon is added.

The `/ideas` idea-detail panel is out of scope for this change and keeps its own footer reassign button.

#### Scenario: Clicking the assignee block on an elaborating idea opens the reassign modal

- **WHEN** a user views the dashboard idea-tracker detail panel for an idea whose status is `open` or `elaborating`, on the elaboration tab, and clicks the assignee block
- **THEN** the reassign modal (`AssignIdeaModal`) opens
- **AND** the footer action row does not contain a standalone reassign button

#### Scenario: Assignee block is read-only once the idea is elaborated

- **WHEN** the idea's status is `elaborated`
- **THEN** the assignee block is not clickable and clicking it does not open the reassign modal

#### Scenario: Affordance is minimal

- **WHEN** the assignee block is in its clickable (editable) state
- **THEN** it shows a pointer cursor and a tooltip labelled "Reassign" (assigned) or "Assign" (unassigned)
- **AND** it does not add a hover-background tint or a hover pencil icon

### Requirement: Yolo button shows icon and label

The Yolo stage-advance button SHALL render as a rocket icon followed by the "Yolo" text label, and SHALL NOT rely on a tooltip to convey its label.

The button retains its purple styling and its two-step confirmation dialog. Because the Yolo button is a shared component rendered by both idea-detail panels, the icon+label presentation applies wherever the Yolo button appears.

#### Scenario: Yolo button renders icon and text

- **WHEN** the Yolo button is shown on an idea-detail panel for an eligible idea
- **THEN** it displays a rocket icon together with the visible text "Yolo"
- **AND** it does not depend on a hover tooltip to reveal its label

#### Scenario: Confirmation dialog is preserved

- **WHEN** a user clicks the Yolo button
- **THEN** a confirmation dialog is shown before the yolo run is requested

