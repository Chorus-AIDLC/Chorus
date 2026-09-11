## MODIFIED Requirements

### Requirement: Yolo button shows icon and label

The Yolo stage-advance action SHALL render a rocket icon followed by the visible localized Yolo text label and SHALL NOT rely on a tooltip to convey its label.

In the dashboard Idea Tracker detail panel it SHALL appear as a menu item inside the header Actions dropdown, using the menu's theme-adaptive styling. In other consumers the shared Yolo button SHALL retain its purple button styling. Both presentations SHALL retain the existing two-step confirmation dialog and wake semantics.

#### Scenario: Yolo button renders icon and text
- **WHEN** the standalone Yolo button is shown for an eligible idea outside the Tracker menu
- **THEN** it displays a rocket icon and visible Yolo text with its existing purple styling
- **AND** it does not depend on a tooltip to reveal its label

#### Scenario: Tracker Yolo menu item
- **WHEN** the user opens Actions in the Tracker sidebar
- **THEN** Yolo is a labeled icon menu item instead of a footer button
- **AND** if unavailable it is disabled and explained

#### Scenario: Confirmation dialog is preserved
- **WHEN** a user activates an enabled Yolo button or menu item
- **THEN** a confirmation dialog is shown before the yolo run is requested
