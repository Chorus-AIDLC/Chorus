# agent-connection-observability — delta

## REMOVED Requirements

### Requirement: The dashboard SHALL provide an Agent Connections page reflecting live status

## ADDED Requirements

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
