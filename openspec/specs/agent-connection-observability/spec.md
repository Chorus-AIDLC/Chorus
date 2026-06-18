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

### Requirement: The dashboard SHALL surface daemon connections through a resident sidebar presence indicator, a popover, and a modal

The dashboard SHALL surface the caller's visible daemon connections through a
**resident presence indicator in the global sidebar**, replacing the standalone
`/agent-connections` page. The standalone page route and its `RadioTower` global
navigation item SHALL be removed; a request to the former `/agent-connections`
path SHALL be redirected rather than returning a broken route, preserving external
or bookmarked links. The navigation item SHALL NOT be re-added, and no surface
SHALL be labeled "Daemons".

The presence indicator SHALL be a small pill rendered directly above the
user-profile block in both the desktop sidebar and the mobile drawer. It SHALL
display a count of the caller's **online** connections (where online means
server-derived `effectiveStatus === "online"`) together with a status dot. The
indicator SHALL be permanently visible and SHALL distinguish three states without
silently conflating them: an idle state when the count is zero (a static
indicator reading "0 online", which MUST remain visible rather than disappearing,
so the user can tell "no agents" apart from "not rendered"); a loading state
(a muted placeholder that does not flash a misleading count); and a request-failure
state (a distinguished unavailable indicator that MUST NOT render as "0 online").
For a non-zero online count the dot SHALL convey liveness (a pulsing indicator)
while honoring the user's reduced-motion preference.

The indicator SHALL open, on click, a popover (a click-triggered surface, not a
hover tooltip) that lists the caller's **online** connections. Each connection
SHALL be led by its agent display name (`agentName`, with a localized fallback when
absent) as the primary identifier, with the client type as a secondary badge — the
same identity-primary rule the prior page applied. Under each online connection the
popover SHALL list that connection's current `running` and `queued` executions (see
the daemon-execution-state capability). The popover is a glanceable surface and
SHALL show only active (`running`/`queued`) executions; it SHALL NOT render
`interrupted` rows that the underlying data source also carries, because the popover
exposes no resume control. A task row in the popover SHALL deep-link to its entity
(task or idea). The popover SHALL provide a "View all" action that opens the modal.

The modal ("View all") SHALL present the full connection view at capability parity
with the prior standalone page: a master-detail composition of the caller's
connections (ordered online-first) with a per-connection detail showing client type
and version, an online/offline indicator from `effectiveStatus`, host, last-active
(`lastSeenAt`), uptime (`connectedAt`) shown only for online connections, the
running/queued execution state, any `interrupted` executions retained by the data
source, and the interrupt/resume controls that the prior page exposed (so the modal,
unlike the glanceable popover, both renders `interrupted` rows and offers their
resume control). The modal SHALL show an empty state explaining how to start a daemon
when the caller has no connections.

The indicator, popover, and modal SHALL be driven by a single shared presence data
source mounted at the dashboard shell so that the resident indicator stays live on
every page and no duplicate polling occurs across the indicator and the modal. All
user-facing strings (indicator states, popover headers, "View all", modal title,
empty/idle states) SHALL be localized in both supported locales.

This surface SHALL remain read-only over the existing registry plus the
interrupt/resume controls already provided by the daemon-interrupt-resume
capability: it SHALL NOT add a manual disconnect or delete control, SHALL NOT modify
the `DaemonConnection` schema, SHALL NOT add a database migration, and SHALL NOT
alter the SSE routes or the registry write path.

#### Scenario: The presence pill is resident above the profile block

- **GIVEN** an authenticated user on any dashboard page
- **WHEN** the sidebar (or mobile drawer) renders
- **THEN** a presence pill MUST appear directly above the user-profile block
- **AND** it MUST show the count of the user's online connections

#### Scenario: The zero state stays visible and is distinct from failure

- **GIVEN** an authenticated user with zero online connections and a successful fetch
- **WHEN** the pill renders
- **THEN** it MUST show a visible "0 online" idle state rather than disappearing
- **AND** when instead the fetch fails, the pill MUST show a distinguished unavailable state that is NOT presented as "0 online"

#### Scenario: Clicking the pill opens a popover listing online connections

- **GIVEN** a user with at least one online connection
- **WHEN** the user clicks the presence pill
- **THEN** a click-triggered popover MUST open listing the online connections
- **AND** each connection MUST be led by its agent name with the client type as a secondary badge

#### Scenario: A popover task row deep-links to its entity

- **GIVEN** the popover is open showing a connection running a task
- **WHEN** the user activates that task row
- **THEN** the user MUST be navigated to that task's (or its idea's) entity page

#### Scenario: "View all" opens the modal at parity with the former page

- **GIVEN** the popover is open
- **WHEN** the user activates "View all"
- **THEN** a modal MUST open presenting the master-detail connection view including execution state and the interrupt/resume controls the prior page exposed
- **AND** no navigation to a standalone `/agent-connections` page MUST occur

#### Scenario: Interrupted executions appear in the modal but not the popover

- **GIVEN** a visible connection that has an `interrupted` execution (carried by the data source alongside running/queued)
- **WHEN** the user views that connection in the sidebar popover
- **THEN** the popover MUST NOT render the `interrupted` row (it shows only running/queued)
- **AND** when the user opens the modal, the modal MUST render the `interrupted` execution together with its resume control

#### Scenario: The former page route is removed and redirected

- **GIVEN** the change is implemented
- **WHEN** a request is made to the former `/agent-connections` path
- **THEN** there MUST be no standalone page route and no `RadioTower` sidebar nav item for it
- **AND** the request MUST be redirected rather than rendering a broken route

#### Scenario: Uptime is shown only for online connections in the modal

- **GIVEN** the modal is open with an online connection and an offline connection
- **WHEN** the connections render
- **THEN** the online connection MUST show an uptime derived from `connectedAt`
- **AND** the offline connection MUST NOT show an uptime

#### Scenario: Liveness honors reduced motion

- **GIVEN** a user with a reduced-motion preference and at least one online connection
- **WHEN** the pill and popover render
- **THEN** the online indicator MUST NOT animate (a static dot is shown) while still conveying online status

#### Scenario: The presence source is shared with no duplicate polling

- **GIVEN** the dashboard shell is mounted
- **WHEN** both the resident pill and an opened modal are showing connection data
- **THEN** they MUST be driven by one shared presence data source
- **AND** opening the modal MUST NOT start a second independent poll of the connection list

#### Scenario: No manual disconnect control is present

- **WHEN** a user views a connection in the popover or modal
- **THEN** there MUST be no control that marks the connection offline or deletes it (interrupt/resume of an execution is not a connection-management control)

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

