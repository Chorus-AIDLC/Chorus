# agent-connection-observability Specification

## Purpose
Defines the owner-scoped observability layer over the daemon-connection registry:
the `GET /api/agent-connections` read API (agent-key + user-cookie callable, not
an MCP tool, no new permission bit), the server-derived `effectiveStatus` liveness
projection that reuses the registry's `STALE_THRESHOLD_MS` so producer and consumer
cannot drift, and the Agent Connections dashboard page (global nav item, periodic
polling, empty state). Visibility is owner-scoped for users (`agent.ownerUuid`) and
self-scoped for agent keys, enforcing the binding contract from the
daemon-connection registry. This is the read/observability slice of idea f2fe9a7f;
live transcript ingest, per-connection `AgentSession` nesting, and connection
management verbs are out of scope and deferred to a follow-on.
## Requirements
### Requirement: The server SHALL expose a read API listing the caller's visible daemon connections

The server SHALL expose `GET /api/agent-connections` returning the
`DaemonConnection` rows visible to the authenticated caller. The endpoint SHALL
require authentication and SHALL be callable both by a browser session (user
cookie / user Bearer) and by an agent API key, mirroring the existing root-idea
resolution endpoint's "REST, agent-key callable" contract. The endpoint SHALL NOT
be implemented as an MCP tool and SHALL NOT introduce a new permission bit; the
returned set is scoped by the query itself. The response SHALL use the standard
API envelope (`{ success: true, data: { connections: [...] } }`).

#### Scenario: Unauthenticated request is rejected

- **GIVEN** a request to `GET /api/agent-connections` with no valid auth
- **WHEN** the server handles it
- **THEN** the response status MUST be 401 and no connection data MUST be returned

#### Scenario: Authenticated request returns the standard envelope

- **GIVEN** an authenticated caller
- **WHEN** the caller requests `GET /api/agent-connections`
- **THEN** the response MUST be `{ success: true, data: { connections } }` where
  `connections` is the caller's visible connection list

### Requirement: The read API SHALL scope visibility by owner for users and by self for agents

The server SHALL scope the returned connections so that a **user** caller sees
only connections whose agent is owned by that user (`agent.ownerUuid` equals the
acting user's uuid) within the caller's company, and an **agent-key** caller sees
only its own connections (`agentUuid` equals the calling agent's uuid) within the
company. Every query SHALL be `companyUuid`-scoped. The API SHALL NOT return a
connection belonging to an agent owned by a different user to other members of the
same company, enforcing the owner-scoped visibility contract defined by the
daemon-connection registry.

#### Scenario: A user sees only connections for agents they own

- **GIVEN** user U owns agent A, another user V owns agent B, both in the same company
- **AND** agent A and agent B each hold a registered `DaemonConnection`
- **WHEN** user U requests `GET /api/agent-connections`
- **THEN** the response MUST include agent A's connection
- **AND** the response MUST NOT include agent B's connection

#### Scenario: An agent key sees only its own connections

- **GIVEN** agent A holds a registered `DaemonConnection` and agent B holds another
- **WHEN** a request authenticates with agent A's API key
- **THEN** the response MUST include only agent A's connection

#### Scenario: Visibility never crosses company boundaries

- **GIVEN** a connection belonging to an agent in company C2
- **WHEN** a caller in company C1 requests `GET /api/agent-connections`
- **THEN** the response MUST NOT include that connection

### Requirement: The server SHALL derive an effectiveStatus applying the staleness rule

The server SHALL compute, for each returned connection, an `effectiveStatus` of
`online` if and only if the persisted `status` is `online` AND the elapsed time
since `lastSeenAt` is at most the registry's staleness threshold
(`STALE_THRESHOLD_MS`); otherwise `effectiveStatus` SHALL be `offline`. The server
SHALL reuse the staleness threshold constant exported by the daemon-connection
registry rather than redefining the rule, so producer and consumer cannot drift.
The projection SHALL also include the raw `status`, `connectedAt`, `lastSeenAt`,
`clientType`, `clientVersion`, `host`, and `startedAt` so a client can render
uptime and last-active without re-implementing liveness.

#### Scenario: A fresh online row reads as online

- **GIVEN** a connection with `status = "online"` and `lastSeenAt` within the staleness threshold
- **WHEN** the read API projects it
- **THEN** `effectiveStatus` MUST be `online`

#### Scenario: A stale online row reads as offline

- **GIVEN** a connection with `status = "online"` whose `lastSeenAt` is older than the staleness threshold
- **WHEN** the read API projects it
- **THEN** `effectiveStatus` MUST be `offline`

#### Scenario: An offline row reads as offline regardless of lastSeenAt

- **GIVEN** a connection with `status = "offline"`
- **WHEN** the read API projects it
- **THEN** `effectiveStatus` MUST be `offline`

### Requirement: This change SHALL add no management actions and no schema change

The change SHALL be read-only over the existing registry: it SHALL NOT add a
manual disconnect or delete control, SHALL NOT modify the `DaemonConnection`
schema, SHALL NOT add a database migration, and SHALL NOT alter the SSE routes or
the registry write path. A manual offline control is intentionally excluded
because a genuinely connected daemon's next heartbeat would immediately flip the
row back to online.

#### Scenario: No manual disconnect control is present

- **WHEN** a user views a connection on the Agent Connections page
- **THEN** there MUST be no control that marks the connection offline or deletes it

#### Scenario: No schema or migration is introduced

- **WHEN** the change is implemented
- **THEN** no change to the `DaemonConnection` Prisma model and no new database
  migration MUST be introduced
- **AND** the SSE routes and the registry write functions MUST remain unchanged

### Requirement: The read API SHALL project the owning agent's display name

The `GET /api/agent-connections` projection SHALL include, for each connection, the
display name of the agent that owns the connection (joined from `Agent.name` via
`DaemonConnection.agentUuid`), exposed as `agentName`. The field SHALL be additive to the
existing `ConnectionView` and SHALL NOT remove or rename any existing field. When the
related agent record cannot be resolved, `agentName` SHALL be `null` rather than causing
the projection to fail. Adding this field SHALL NOT introduce a database schema change, a
migration, or a new permission bit, and SHALL preserve the existing owner/self visibility
scoping.

#### Scenario: A connection projects its owning agent's name

- **GIVEN** a registered connection whose owning agent has display name "Admin Claude"
- **WHEN** the read API projects that connection for an authorized caller
- **THEN** the projected connection MUST include `agentName` equal to "Admin Claude"

#### Scenario: A connection with an unresolvable agent projects a null name

- **GIVEN** a registered connection whose owning agent record cannot be resolved
- **WHEN** the read API projects that connection
- **THEN** the projected connection MUST include `agentName` equal to `null`
- **AND** the projection MUST NOT throw or omit the connection

### Requirement: The server SHALL expose an aggregate read API for the caller's visible executions

The server SHALL expose `GET /api/daemon/executions` returning, for the
authenticated caller, the full set of currently active (`running` / `queued`)
executions across **all** of the caller's visible connections in one response, so
the sidebar presence surface can render correct first-paint state without issuing
one request per connection. The endpoint SHALL reuse the existing owner-scoped
visibility rule — a user caller sees only executions of connections whose agent the
user owns (`agent.ownerUuid`); an agent-key caller sees only its own connections'
executions; every query is `companyUuid`-scoped. The endpoint SHALL require
authentication, SHALL be callable by both a browser session and an agent API key,
SHALL NOT be implemented as an MCP tool, and SHALL NOT introduce a new permission
bit. The response SHALL use the standard API envelope
(`{ success: true, data: { executions: [...] } }`) and SHALL reuse the existing
execution projection shape so the client shares one type with the per-connection
and SSE paths.

#### Scenario: Authenticated request returns the caller's aggregate executions

- **GIVEN** a user who owns two online connections, each running a task
- **WHEN** the user requests `GET /api/daemon/executions`
- **THEN** the response MUST be `{ success: true, data: { executions } }` including both connections' active executions

#### Scenario: Aggregate executions are owner-scoped

- **GIVEN** user U owns agent A and user V owns agent B in the same company, each with a running task
- **WHEN** user U requests `GET /api/daemon/executions`
- **THEN** the response MUST include agent A's executions
- **AND** it MUST NOT include agent B's executions

#### Scenario: Unauthenticated request is rejected

- **GIVEN** a request to `GET /api/daemon/executions` with no valid auth
- **WHEN** the server handles it
- **THEN** the response status MUST be 401 and no execution data MUST be returned

#### Scenario: The aggregate endpoint introduces no schema change and no new permission bit

- **WHEN** the aggregate executions endpoint is added
- **THEN** it MUST reuse the existing owner/self visibility scoping and the existing execution projection
- **AND** it MUST NOT introduce a database schema change, a migration, or a new permission bit

### Requirement: The presence popover SHALL display each execution's task in a readable, non-truncated layout

The sidebar presence popover SHALL present each connection's `running` and `queued`
executions so that the task title is legible without being hard-truncated by the
popover's width. The popover container SHALL be wider than a single narrow column and
SHALL be clamped to the viewport so it never overflows a small screen (a
viewport-relative max width). Within the popover, each execution row SHALL use a layout
in which the task title occupies the full available row width and is NOT forced to
share that width with the row's trailing controls; the elapsed-time indicator and the
Interrupt control (for `running` rows) SHALL be positioned so they do not crowd or
truncate the title (for example, on a second line beneath the title).

The popover SHALL remain actionable: the elapsed-time indicator and the Interrupt
control SHALL continue to be available in the popover for `running` executions — they
SHALL be relaid out, not removed. The deep-link from a task row to its entity, the
running/queued grouping, and the rule that the popover shows only `running`/`queued`
executions (never `interrupted`) SHALL be preserved unchanged.

This readable layout SHALL be specific to the popover surface. The "View all" modal and
its master-detail connection view SHALL retain their existing execution-row layout; the
shared execution-row renderer SHALL expose the roomy layout as an opt-in that the modal
surfaces do not adopt, so that widening the popover introduces no visual change to the
modal. The change SHALL remain frontend-only over the existing data source: it SHALL NOT
modify the presence data spine, the `GET /api/daemon/executions` or
`GET /api/agent-connections` APIs, the `DaemonConnection` schema, add a migration, or add
a new permission bit.

#### Scenario: A long task title is readable in the popover

- **GIVEN** an online connection running a task whose title is long
- **WHEN** the user opens the presence popover
- **THEN** the popover MUST be rendered at a width wider than the prior narrow column and clamped to the viewport
- **AND** the task title MUST be presented in a layout where it is not hard-truncated to a small fraction of the row by the trailing controls

#### Scenario: Running-row controls do not crowd the title

- **GIVEN** the popover is open showing a `running` execution
- **WHEN** the row renders
- **THEN** the elapsed-time indicator and the Interrupt control MUST both still be present in the popover
- **AND** they MUST be positioned so they do not share the title's horizontal width (for example, on a separate line beneath the title)

#### Scenario: The popover stays within a small viewport

- **GIVEN** the popover opens on a narrow (mobile-width) viewport
- **WHEN** it renders
- **THEN** its width MUST be clamped to the viewport so the popover does not overflow horizontally

#### Scenario: The modal execution-row layout is unchanged

- **GIVEN** the change is implemented
- **WHEN** the user opens the "View all" modal and its connection detail
- **THEN** the modal's execution rows MUST retain their existing (single-line) layout
- **AND** the popover-specific roomy layout MUST be an opt-in not adopted by the modal surfaces

#### Scenario: Popover information architecture is preserved

- **GIVEN** a connection with `running`, `queued`, and `interrupted` executions
- **WHEN** the user views it in the widened popover
- **THEN** the popover MUST still show only the `running` and `queued` executions grouped as before
- **AND** it MUST NOT render the `interrupted` row (which remains modal-only)
- **AND** a task row MUST still deep-link to its entity

### Requirement: Daemon connection lists SHALL render in a deterministic order across equivalent refreshes

The `GET /api/agent-connections` read path and the resident agent-presence UI SHALL apply deterministic ordering so an equivalent set of daemon connections renders in the same order regardless of database row order, API array order, or heartbeat-only timestamp changes. The server SHALL be the authoritative source for the API's connection order. The frontend SHALL defensively normalize any locally derived agent/cwd grouping before rendering so it does not depend on accidental input order.

The backend connection order SHALL rank `effectiveStatus = "online"` before `effectiveStatus = "offline"`, then tie-break by normalized `agentName`, `agentUuid`, cwd full path string, host, `clientType`, and connection `uuid`. Missing agent names and `null` cwd values SHALL use deterministic sentinels. `lastSeenAt`, `connectedAt`, and `startedAt` SHALL remain projected for display but SHALL NOT be primary ordering keys because they can change during refresh without changing the logical set of connections.

When the frontend has local execution state, it MAY apply an activity rank before the stable identity tie-breaks, such as running before queued before online-idle before offline. Any such rank MUST still be deterministic and MUST still tie-break by agent identity and cwd identity. A row MAY move when its actual status or activity changes; it MUST NOT move solely because an equivalent array was returned in a different order.

#### Scenario: API order is stable for shuffled equivalent rows

- **GIVEN** two reads observe the same logical daemon connection set in different raw database orders
- **WHEN** `GET /api/agent-connections` projects and sorts the rows
- **THEN** both responses MUST return the same connection uuid sequence

#### Scenario: Heartbeat-only timestamp changes do not reorder equivalent rows

- **GIVEN** two online connections whose identity fields and statuses are unchanged
- **WHEN** only `lastSeenAt` or other display timestamps change due to heartbeat refresh
- **THEN** their relative order MUST remain determined by agent identity and cwd identity
- **AND** the rows MUST NOT swap solely because one heartbeat timestamp is newer

#### Scenario: Agent groups are ordered by status and stable identity

- **GIVEN** the presence UI receives visible connections for multiple agents
- **WHEN** the UI renders the popover or full connections modal
- **THEN** agent groups MUST be ordered by status or activity rank first
- **AND** groups with the same rank MUST be tie-broken by agent display name and agent uuid
- **AND** repeated refreshes with the same logical set MUST preserve the same group order

#### Scenario: cwd rows are ordered by full path string

- **GIVEN** one agent has multiple visible cwd connections in the same status/activity rank
- **WHEN** the UI renders the expanded cwd rows for that agent
- **THEN** the cwd rows MUST be ordered by full cwd path string ascending with a deterministic `null` cwd sentinel
- **AND** repeated refreshes with the same cwd set in different raw input order MUST preserve the same row order

#### Scenario: Meaningful status changes may move a row

- **GIVEN** an agent or cwd row changes from offline to online, online idle to running, or another supported status/activity rank transition
- **WHEN** the UI refreshes
- **THEN** the row MAY move to the appropriate status/activity group
- **AND** rows within the same resulting group MUST still use deterministic identity tie-breaks

#### Scenario: Local E2E verifies refresh stability

- **GIVEN** a local end-to-end test renders the daemon presence surface with fixture daemon connections
- **WHEN** repeated refreshes return the same logical agent/cwd set in different raw array orders
- **THEN** the visible agent group order and cwd sub-row order MUST remain unchanged

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

