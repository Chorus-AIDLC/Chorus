## REMOVED Requirements

### Requirement: The dashboard SHALL surface daemon connections through a resident sidebar presence indicator, a popover, and a modal

**Reason**: The three-step drill-down (sidebar pill → roster popover → "View all" → chat modal) plus a separate, disjoint bottom-right pixel-canvas widget is being consolidated into a single bottom-right floating entry. This requirement is replaced by "The dashboard SHALL surface daemon connections through a single bottom-right floating entry" below.

**Migration**: The resident sidebar presence pill is removed. Its resident online-count + status information moves to the new floating entry's button; its online-connection roster popover (agent-name-led, running/queued execution rows, deep-links, interrupted-rows-excluded, 0-online CTA) moves into the floating entry's popover; the "View all" chat modal is opened directly from a prominent action in that popover. All preserved behaviors are re-asserted in the new requirement's scenarios. The still-true standing guarantees carried by the removed requirement — the former `/agent-connections` standalone page stays removed with its path redirected, no `RadioTower` global-nav item, and no surface labeled "Daemons" — are re-asserted in the new floating-entry requirement below so they are not lost from the cumulative spec at archive time.

## ADDED Requirements

### Requirement: The dashboard SHALL surface daemon connections through a single bottom-right floating entry

The dashboard SHALL surface the caller's visible daemon connections through a **single floating entry pinned to the bottom-right of the viewport**, present on every dashboard page, replacing BOTH the resident sidebar presence pill and the separate bottom-right pixel-canvas widget button. There SHALL be no presence pill in the sidebar rail or mobile drawer, and no second standalone bottom-right widget button; the floating entry is the one affordance for daemon presence and conversation.

The floating entry SHALL be driven by the single shell-level presence data source (the same source that backs the connection list and the chat modal), so it is company-wide and remains live across route changes without starting a second poll of the connection list.

The change SHALL preserve the standing guarantees established when the standalone `/agent-connections` page was retired: there SHALL be no standalone `/agent-connections` page route and no `RadioTower` global-navigation item for it, a request to the former `/agent-connections` path SHALL be redirected rather than returning a broken route, and no surface SHALL be labeled "Daemons".

The entry's trigger button SHALL display a glanceable status indicator that distinguishes, without silently conflating them, an idle state when the online count is zero (which MUST remain visible rather than disappearing), a loading state (a muted placeholder that does not flash a misleading count), and a request-failure state (a distinguished unavailable indicator that MUST NOT render as "0 online"). For a non-zero online count the button SHALL surface an online-count badge and a liveness dot that honors the user's reduced-motion preference (a static dot when reduced motion is preferred).

#### Scenario: A single floating entry appears bottom-right on every dashboard page

- **GIVEN** an authenticated user on any dashboard page (project or global)
- **WHEN** the shell renders
- **THEN** a single floating entry MUST be pinned to the bottom-right of the viewport
- **AND** there MUST be no presence pill in the sidebar rail or mobile drawer
- **AND** there MUST be no separate standalone bottom-right widget button beside it

#### Scenario: The zero state stays visible and is distinct from failure

- **GIVEN** an authenticated user with zero online connections and a successful fetch
- **WHEN** the entry button renders
- **THEN** it MUST show a visible idle "0 online" state rather than disappearing
- **AND** when instead the fetch fails, the button MUST show a distinguished unavailable state that is NOT presented as "0 online"

#### Scenario: A non-zero online count shows a badge and reduced-motion-aware liveness

- **GIVEN** a user with at least one online connection
- **WHEN** the entry button renders
- **THEN** it MUST surface an online-count badge reflecting the number of online connections
- **AND** the liveness dot MUST animate only when the user has not requested reduced motion (otherwise a static dot conveys online status)

#### Scenario: The entry uses the shared presence source with no duplicate polling

- **GIVEN** the dashboard shell is mounted
- **WHEN** the floating entry button, its popover, and the opened chat modal are showing connection data
- **THEN** they MUST be driven by one shared shell-level presence data source
- **AND** opening the popover or the chat modal MUST NOT start a second independent poll of the connection list

#### Scenario: The former standalone page stays removed and redirected

- **GIVEN** the change is implemented
- **WHEN** a request is made to the former `/agent-connections` path
- **THEN** there MUST be no standalone page route and no `RadioTower` global-nav item for it
- **AND** the request MUST be redirected rather than rendering a broken route
- **AND** no surface MUST be labeled "Daemons"

### Requirement: A single click on the floating entry SHALL open a slim online roster with a prominent open-chat action

Clicking the floating entry button SHALL open a click-triggered popover (not a hover tooltip) that lists the caller's **online** connections in a slim, glanceable roster, and that popover SHALL present a **prominent one-click action that opens the daemon chat modal directly**. Reaching the conversation SHALL therefore take at most two user actions (open the entry, then activate open-chat), removing the prior intermediate "View all" step.

Each connection in the roster SHALL be led by its agent display name (`agentName`, with a localized fallback when absent) as the primary identifier, with the client type as a secondary badge. Under each online connection the roster SHALL list that connection's current `running` and `queued` executions and SHALL NOT render `interrupted` executions (the roster exposes no resume control). A task row in the roster SHALL deep-link to its entity (task or idea). When the caller has zero online connections, the roster SHALL show the shared daemon-connect call-to-action rather than a dead-end empty message.

The chat modal opened from this action SHALL be the existing "View all" daemon chat surface at full capability parity (master-detail connections ordered online-first, per-connection client type/version, `effectiveStatus`, host, last-active, uptime for online connections, running/queued state, retained `interrupted` executions and their resume controls, and the conversation/transcript chat). No navigation to a standalone `/agent-connections` page SHALL occur.

#### Scenario: One click opens a slim roster of online connections

- **GIVEN** a user with at least one online connection
- **WHEN** the user clicks the floating entry button
- **THEN** a click-triggered popover MUST open listing the online connections
- **AND** each connection MUST be led by its agent name with the client type as a secondary badge

#### Scenario: A prominent action opens the chat modal directly

- **GIVEN** the roster popover is open
- **WHEN** the user activates the prominent open-chat action
- **THEN** the daemon chat modal MUST open directly
- **AND** reaching the conversation MUST NOT require an intermediate "View all" step
- **AND** no navigation to a standalone `/agent-connections` page MUST occur

#### Scenario: The chat modal retains full parity including resume controls

- **GIVEN** a visible connection that has an `interrupted` execution
- **WHEN** the user opens the chat modal from the entry
- **THEN** the modal MUST render the master-detail connection view with the `interrupted` execution and its resume control
- **AND** the modal MUST present the conversation/transcript chat surface

#### Scenario: Interrupted executions appear in the modal but not the roster

- **GIVEN** a visible online connection that has `running`, `queued`, and `interrupted` executions
- **WHEN** the user views it in the entry's roster popover
- **THEN** the roster MUST show only the `running` and `queued` executions and MUST NOT render the `interrupted` row
- **AND** when the user opens the chat modal, the `interrupted` execution and its resume control MUST be present

#### Scenario: A roster task row deep-links to its entity

- **GIVEN** the roster popover is open showing a connection running a task
- **WHEN** the user activates that task row
- **THEN** the user MUST be navigated to that task's (or its idea's) entity page

#### Scenario: Zero online connections shows the connect CTA

- **GIVEN** a user with zero online connections
- **WHEN** the user opens the roster popover
- **THEN** the popover MUST render the shared daemon-connect call-to-action rather than a dead-end empty message

### Requirement: The pixel-canvas activity visualization SHALL be retained as a project-scoped secondary view reachable from the entry

The pixel-canvas "typing" activity visualization SHALL be retained (not deleted) as a **secondary view reachable from the floating entry**, rather than as its own standalone bottom-right button. Because the visualization renders the **current project's** active daemon sessions and depends on the project-scoped realtime data source, the affordance that opens it SHALL be present **only when a project context is active**; on global pages (for example the projects list, project groups, and settings) the affordance SHALL be **absent** and the entry SHALL offer only the roster and chat.

When present and activated, the affordance SHALL open the pixel-canvas visualization for the current project, driven by the existing project-scoped active-sessions data source (no new data source and no backend change).

#### Scenario: The secondary activity view is reachable within a project

- **GIVEN** an authenticated user on a project page with the floating entry open
- **WHEN** the entry renders its actions
- **THEN** an affordance to open the pixel-canvas activity visualization MUST be present
- **AND** activating it MUST open the pixel-canvas visualization for the current project

#### Scenario: The secondary activity view is absent on global pages

- **GIVEN** an authenticated user on a global page (projects list, project groups, or settings) with no active project context
- **WHEN** the floating entry opens
- **THEN** the affordance to open the pixel-canvas activity visualization MUST be absent
- **AND** the entry MUST still offer the online roster and the open-chat action

#### Scenario: The retained visualization introduces no backend change

- **WHEN** the pixel-canvas view is opened from the entry
- **THEN** it MUST read the existing project-scoped active-sessions source
- **AND** no new API, permission bit, database schema change, or migration MUST be introduced

### Requirement: The unified entry change SHALL remain read-only, localized, and theme-correct

The unified floating-entry change SHALL remain a frontend interaction-layer refactor over the existing data sources. It SHALL NOT add a manual disconnect or delete control (the interrupt/resume of an execution is not connection management), SHALL NOT modify the `DaemonConnection` schema, SHALL NOT add a database migration, SHALL NOT alter the SSE routes or the registry write path, and SHALL NOT introduce a new permission bit. All user-facing strings introduced or relocated by the entry (button aria-label and status text, roster header, the open-chat action label, the secondary-view label) SHALL be localized in both supported locales. The new floating button and its popover SHALL render correctly in both the light and dark themes.

#### Scenario: No manual disconnect control and no backend change

- **WHEN** a user views a connection in the entry's roster or the chat modal
- **THEN** there MUST be no control that marks the connection offline or deletes it
- **AND** the change MUST NOT modify the `DaemonConnection` schema, add a migration, alter the SSE routes, or add a new permission bit

#### Scenario: Entry strings are localized in both locales

- **GIVEN** the app is viewed in each supported locale
- **WHEN** the floating entry, its roster, and its actions render
- **THEN** every user-facing string MUST resolve from the locale message catalog in both locales with no hardcoded literal

#### Scenario: The entry renders correctly in light and dark themes

- **GIVEN** the app is toggled between the light and dark themes
- **WHEN** the floating button and its popover render
- **THEN** both MUST render with theme-appropriate, legible colors in each theme
