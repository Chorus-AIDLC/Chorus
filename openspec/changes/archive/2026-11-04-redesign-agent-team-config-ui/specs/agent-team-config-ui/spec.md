## ADDED Requirements

### Requirement: Project team configuration lives in Project Settings
The project dashboard header SHALL expose a single Settings entry, and project team configuration SHALL be a "Team" tab inside the Project Settings dialog alongside General and Access.

#### Scenario: Header has one settings entry
- **WHEN** a user opens a project dashboard
- **THEN** no standalone Project Team button is rendered and the Settings button is the only settings entry in the header

#### Scenario: Team tab deep link
- **WHEN** the dashboard is opened with `?settings=team`
- **THEN** the Project Settings dialog opens with the Team tab active

### Requirement: Team tab keeps the personal-team access model
The Team tab SHALL configure the caller's personal, owner-private project team and SHALL NOT be disabled by the Project Settings access lock; Idea handoff SHALL require project Editor access.

#### Scenario: Viewer configures personal team
- **WHEN** a project Viewer opens Project Settings → Team
- **THEN** they can edit and save their personal role overrides, and Hand off… is unavailable with an explanation that Editor access is required

#### Scenario: Non-admin on a private project
- **WHEN** a non-admin member of a private project opens Project Settings → Team while General settings are locked
- **THEN** the Team tab controls remain enabled and saving their personal team succeeds

### Requirement: Compact role rows
Each team role (product, development, review, lead) SHALL be shown as one row with role name, inherited/overridden/snapshot status badge, member avatar chips, a trailing add control, and a "…" menu containing Clear role and Reset to template.

#### Scenario: Remove and add members
- **WHEN** an editor clicks a member chip's remove control or picks an agent from the row's add control
- **THEN** the row updates locally, the status badge shows overridden, and the Save button becomes enabled

#### Scenario: Ineligible member is explained
- **WHEN** a member lacks required permissions or project access
- **THEN** its chip shows a warning state and the reason is available to sighted and screen-reader users

### Requirement: Destructive and multi-step actions use dialogs
Unbinding a team and handing off to a lead SHALL be performed in dedicated dialogs, never by inserting inline content into the settings surface.

#### Scenario: Unbind confirmation
- **WHEN** an editor clicks Unbind team
- **THEN** an AlertDialog asks for confirmation, and the team is unbound only after the confirm action

#### Scenario: Lead handoff dialog
- **WHEN** an editor clicks Hand off… with no unsaved changes
- **THEN** a dialog lets them choose an eligible lead, preview affected Ideas, and confirm; closing it discards the preview

#### Scenario: Unsaved changes guard
- **WHEN** the Team tab has unsaved changes and the user switches tabs or closes Project Settings
- **THEN** a confirmation asks whether to discard the changes

### Requirement: Feedback placement
Successful save, unbind and handoff SHALL show a toast; failures SHALL show inline next to the related control.

#### Scenario: Save success
- **WHEN** a team save succeeds
- **THEN** a success toast appears and no status paragraph is appended to the dialog body

### Requirement: Template page consistency
The `/settings/teams` page SHALL render template members and the template editor with the same role-row and member-chip components used in the project Team tab.

#### Scenario: Template list uses role rows
- **WHEN** a user views team templates
- **THEN** each template shows its roles as read-only role rows and destructive actions are reached via a menu with an AlertDialog confirmation

### Requirement: Theme and i18n compliance
All new UI SHALL use i18n keys present in every shipped locale (en, zh, ja, ko), and render correctly in light and dark themes.

#### Scenario: Dark theme
- **WHEN** the dark theme is active
- **THEN** role rows, chips, badges, warning states and dialogs use semantic tokens or explicit `dark:` variants with readable contrast
