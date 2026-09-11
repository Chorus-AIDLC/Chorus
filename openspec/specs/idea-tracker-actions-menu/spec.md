# idea-tracker-actions-menu Specification

## Purpose
TBD - created by archiving change consolidate-idea-tracker-actions. Update Purpose after archive.
## Requirements
### Requirement: One Tracker action entry
The Tracker idea sidebar SHALL expose a localized header Actions dropdown and independent Close, moving Derive, Move, Edit, Verify Elaborate, Start Development, Yolo and Delete into the menu. It SHALL remove the footer operation bar, retain inline edit Save/Cancel and leave other detail surfaces unchanged.

#### Scenario: View and edit an idea
- **WHEN** a user opens the Tracker sidebar
- **THEN** all seven operations are discoverable inside Actions and Close remains independent
- **AND** no action footer is rendered
- **WHEN** the user selects an enabled Edit operation
- **THEN** Save and Cancel are available inside the edit form and Close preserves cancel-edit behavior

### Requirement: Availability and confirmation safety
Operations SHALL preserve existing mutation eligibility, stage/presence checks, pin-then-wake routing, permissions and confirmations. Unavailable menu actions SHALL remain visible, non-executable and accompanied by localized reasons accessible with pointer and keyboard. Delete SHALL occupy a separated destructive group at the bottom and SHALL require confirmation.

#### Scenario: Unavailable actions
- **WHEN** an action is unavailable due to incomplete elaboration, unsuitable stage, offline assignee, theme/container state, edit lock or an in-flight request
- **THEN** its menu item is disabled with an explanatory tooltip/accessible description
- **AND** mouse or keyboard activation cannot invoke its mutation

#### Scenario: Confirm or cancel a mutation
- **WHEN** the user selects Yolo or Delete
- **THEN** the existing confirmation survives menu closure
- **AND** cancel causes no mutation and returns focus to Actions
- **WHEN** a stage advance requires selecting a cwd
- **THEN** the existing picker survives menu closure and wake executes only through the original pin-then-wake flow

### Requirement: Copy idea identifiers
The menu SHALL copy the exact current idea UUID or its canonical absolute Tracker URL and report localized success only after clipboard success. Failure or unavailable Clipboard API SHALL result in localized error feedback.

#### Scenario: Successful copy
- **WHEN** the user selects Copy link or Copy UUID
- **THEN** clipboard receives respectively the current-origin `/projects/<projectUuid>/dashboard?panel=<ideaUuid>` URL or the exact idea UUID
- **AND** incidental tab/filter/query/hash state is excluded from the link
- **AND** the copied link opens the intended Tracker idea

#### Scenario: Clipboard denied
- **WHEN** clipboard is missing or rejects the write
- **THEN** an error is shown, no success is shown, and the sidebar remains usable

### Requirement: Accessible localized presentation
The menu SHALL use shadcn primitives, translated English/Chinese strings and theme-adaptive styling. Keyboard operation, focus return, narrow viewports and light/dark themes SHALL be verified.

#### Scenario: Keyboard and visual verification
- **WHEN** a user opens Actions via keyboard in either locale and theme
- **THEN** operations have readable labels, unavailable reasons are discoverable, Escape closes the menu and returns focus, and the sidebar/menu fit a narrow viewport
- **AND** light and dark presentation remain legible without overflow
