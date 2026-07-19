# sidebar-project-quick-access Specification

## Purpose
TBD - created by archiving change add-sidebar-project-quick-access. Update Purpose after archive.
## Requirements
### Requirement: Account-level project quick-access persistence

The system SHALL persist, per signed-in user, a project quick-access state
consisting of a recency timestamp and an optional pin timestamp for each project
the user has visited or pinned. This state SHALL be stored server-side (scoped by
company and user) so it follows the user's account across browsers and devices,
and SHALL be additive to the existing schema (no change to core entity models).

#### Scenario: Recent + pin state survives a device change

- **WHEN** a user visits and pins projects on one device, then signs in on a
  different device or browser
- **THEN** the same recently-visited and pinned projects appear in the sidebar
  quick-access region on the second device

#### Scenario: State is isolated per user and per company

- **WHEN** the quick-access aggregate is read for a user
- **THEN** it SHALL contain only that user's visits within the user's company,
  and SHALL never include another user's or another company's project state

### Requirement: Automatic visit recording

Entering any project sub-page (a URL of the form `/projects/{uuid}/...`) SHALL
record a visit for the signed-in user, updating that project's `lastVisitedAt`
without altering its pin state. Visit recording SHALL be best-effort: a failed
record SHALL NOT surface an error to the user or block navigation, and repeated
renders within the same project SHALL NOT produce redundant writes.

#### Scenario: Visiting a project updates recency

- **WHEN** a signed-in user navigates to any sub-page of a project
- **THEN** that project's `lastVisitedAt` for the user is updated to the current
  time and the project appears at the top of the recent list on the next
  quick-access read

#### Scenario: Forged project UUID from another company is rejected

- **WHEN** a visit is recorded for a `projectUuid` that does not exist in the
  caller's company
- **THEN** no visit row is created and the request does not leak the existence of
  the project

### Requirement: Pin and unpin projects

A user SHALL be able to pin any project to the sidebar and unpin it later. Pins
SHALL be unlimited in number and ordered by the time each project was pinned
(earliest first, stable). Pinning SHALL be idempotent — re-pinning an
already-pinned project SHALL NOT change its position — and unpinning SHALL return
the project to eligibility for the recent list. Pin and unpin SHALL be reachable
both from the sidebar quick-access rows and from the project cards on the
`/projects` list page.

#### Scenario: Pin a project from the projects list

- **WHEN** a user clicks the pin control on a project card in `/projects`
- **THEN** the project becomes pinned and appears in the pinned portion of the
  sidebar quick-access region

#### Scenario: Unpin returns a project to the recent list

- **WHEN** a user unpins a project that was recently visited
- **THEN** the project is removed from the pinned portion and, if its
  `lastVisitedAt` is recent enough, reappears in the recent portion

#### Scenario: Re-pinning does not reorder

- **WHEN** a user pins a project that is already pinned
- **THEN** its position in the pinned list is unchanged

### Requirement: Merged quick-access list with dedupe

The sidebar quick-access region SHALL render a single merged list: pinned
projects first (marked with a pin icon, ordered by pin time), followed by up to
five recently-visited projects ordered most-recent first. A pinned project SHALL
NOT also appear in the recent portion (pinned excludes recent). Each row SHALL
show the project name and, when the project belongs to a project group, the group
name as a secondary sub-line.

#### Scenario: A pinned-and-recently-visited project appears once

- **WHEN** a project is both pinned and recently visited
- **THEN** it appears only in the pinned portion, not in the recent portion

#### Scenario: Recent list is capped at five

- **WHEN** a user has visited more than five non-pinned projects
- **THEN** the recent portion shows only the five most recently visited

#### Scenario: Group name shown as a sub-line

- **WHEN** a quick-access row is for a project that belongs to a project group
- **THEN** the row shows the group name beneath the project name; ungrouped
  projects show only the project name

### Requirement: Sidebar placement and in-project collapse

The quick-access region SHALL appear on every dashboard page in both the desktop
sidebar and the mobile drawer. On global pages (project list, project groups,
settings) it SHALL be expanded by default. When the user is inside a project, the
region SHALL default to a collapsed header row that the user can expand, so the
current project's navigation stays primary. The collapsed/expanded choice is a
per-device view-state preference and SHALL degrade gracefully when browser
storage is unavailable.

#### Scenario: Expanded on global pages

- **WHEN** the user is on `/projects`, a project group page, or settings
- **THEN** the quick-access region is shown expanded

#### Scenario: Collapsed by default inside a project

- **WHEN** the user navigates into a project
- **THEN** the quick-access region collapses to a header row, and expanding it
  reveals the pinned + recent list

#### Scenario: Renders correctly in both themes and both layouts

- **WHEN** the region is displayed in light or dark theme, in the desktop sidebar
  or the mobile drawer
- **THEN** it renders with correct, readable contrast using the design-system
  tokens in all four combinations

### Requirement: Remove a project from the recent list

A user SHALL be able to manually remove a non-pinned project from the sidebar
Recent Projects list. Removal is a **soft-remove**: it SHALL delete that user's
visit record for the project (scoped by company and user) so the project is
forgotten from recency, and the project SHALL naturally reappear in the recent
list the next time the user visits it. Removal SHALL NOT create any permanent
"hidden" state and SHALL NOT require a schema change. Removal SHALL apply only to
recent (non-pinned) rows; a pinned project's visit record SHALL NEVER be deleted
by a remove action — a pinned project is removed from the sidebar only by
unpinning it. The remove action SHALL be silent: no confirmation dialog and no
undo toast are shown. Removal SHALL be reflected immediately across every surface
that renders quick-access state, with no page reload.

#### Scenario: Remove a recent project from the sidebar

- **WHEN** a user opens the overflow menu on a recent (non-pinned) quick-access
  row and chooses "Remove from recent"
- **THEN** the project's visit record for that user is deleted and the row
  disappears from the recent list immediately, with no confirmation dialog and no
  undo toast

#### Scenario: A removed project returns on the next visit

- **WHEN** a user removes a project from recent and later navigates to that
  project again
- **THEN** a visit is recorded and the project reappears in the recent list

#### Scenario: Removing a project does not affect its pin state

- **WHEN** a remove request targets a project that is currently pinned
- **THEN** no visit record is deleted and the project remains pinned and visible
  in the pinned portion of the sidebar

#### Scenario: Remove is a human-only, company-scoped action

- **WHEN** a remove request is made without user authentication, or by an agent
  API key, or for a project outside the caller's company
- **THEN** the request is rejected (unauthenticated → 401, agent → 403) or has no
  effect, and no other user's or company's visit records are affected

### Requirement: Per-row overflow menu for recent quick-access rows

Each recent (non-pinned) quick-access row SHALL present its row actions through a
single overflow menu (a "⋯" kebab trigger) rather than inline action icons. The
menu SHALL offer, at minimum, "Pin to sidebar" and "Remove from recent". Pinned
rows SHALL retain their existing one-tap pin (unpin) control and SHALL NOT use the
overflow menu. On the desktop sidebar the overflow trigger SHALL be revealed on
row hover or keyboard focus; in the mobile drawer it SHALL be persistently
visible. The trigger and menu SHALL be keyboard-accessible and carry accessible
labels, and SHALL render correctly in both light and dark themes.

#### Scenario: Recent row exposes actions via the overflow menu

- **WHEN** a user hovers or focuses a recent quick-access row on desktop, or views
  the mobile drawer
- **THEN** a "⋯" overflow trigger is available that opens a menu containing "Pin
  to sidebar" and "Remove from recent"

#### Scenario: Pinned row keeps its direct pin control

- **WHEN** a quick-access row is a pinned project
- **THEN** it shows the existing one-tap pin (unpin) button and does not show the
  overflow menu

#### Scenario: Opening the menu does not navigate

- **WHEN** a user activates the "⋯" trigger on a recent row
- **THEN** the overflow menu opens and the user is not navigated to the project
  dashboard

