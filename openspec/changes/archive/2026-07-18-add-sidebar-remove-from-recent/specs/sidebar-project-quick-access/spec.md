## ADDED Requirements

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
