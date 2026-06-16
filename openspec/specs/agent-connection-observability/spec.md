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

### Requirement: The dashboard SHALL provide an Agent Connections page reflecting live status

The dashboard SHALL provide a top-level page at `/agent-connections`, reachable from a
global sidebar navigation item labeled "Agent Connections" (and its localized
equivalent), that lists the caller's visible connections. The navigation item SHALL NOT
be labeled "Daemons".

The page SHALL lead each connection with the **agent display name** (`agentName`) as its
primary identifier; the client type SHALL be presented as a secondary badge, not as the
primary label, so that two connections sharing a client type but belonging to different
agents are distinguishable. When `agentName` is absent, the page SHALL render a localized
fallback label rather than a blank identifier.

The page SHALL present connections in a master-detail composition on wide viewports: a
list of the caller's connections (ordered online-first) and a detail view for the
selected connection. On narrow (mobile) viewports the page SHALL present a single-column
list of connections and a drill-down detail view for a selected connection. Both
compositions SHALL apply the same identity-primary and uptime rules.

The page SHALL display, per connection, the client type and version, an online/offline
indicator driven by the server-derived `effectiveStatus`, the host, and the last-active
time (from `lastSeenAt`). The page SHALL display the uptime (from `connectedAt`) only for
connections whose `effectiveStatus` is `online`; an offline connection SHALL NOT show an
uptime, because `now - connectedAt` for a connection that is no longer up is an
ever-growing, misleading value. For online connections the page SHALL convey liveness
beyond a static value — at minimum a continuously updating uptime — while honoring a
user's reduced-motion preference for any decorative animation.

The page SHALL refresh on a periodic interval so that online↔offline transitions appear
without a manual reload, and SHALL show an empty state explaining how to start a daemon
when the caller has no connections. The page SHALL reserve a clearly-labeled placeholder
for forthcoming per-connection sessions and transcript, conveying that the capability is
not yet available without presenting fabricated data. All user-facing strings SHALL be
localized in both supported locales.

#### Scenario: The page lists the caller's connections

- **GIVEN** an authenticated user with one online and one offline visible connection
- **WHEN** the user opens `/agent-connections`
- **THEN** the page MUST render both connections with their agent name, client type, host,
  and an indicator reflecting each connection's `effectiveStatus`

#### Scenario: Agent name is the primary identifier and client type is a badge

- **GIVEN** two online connections that share the client type but have different agent names
- **WHEN** the user opens `/agent-connections`
- **THEN** each connection MUST be labeled primarily by its distinct agent name
- **AND** the shared client type MUST be shown as a secondary badge, not as the primary label

#### Scenario: A connection without an agent name shows a fallback label

- **GIVEN** a visible connection whose `agentName` is `null`
- **WHEN** the user opens `/agent-connections`
- **THEN** the connection MUST render a localized fallback label rather than a blank identifier

#### Scenario: Uptime is shown only for online connections

- **GIVEN** an online connection and an offline connection
- **WHEN** the user opens `/agent-connections`
- **THEN** the online connection MUST show an uptime derived from `connectedAt`
- **AND** the offline connection MUST NOT show an uptime

#### Scenario: Online uptime updates without a manual reload

- **GIVEN** the page is open showing an online connection with a visible uptime
- **WHEN** time passes while the connection stays online
- **THEN** the displayed uptime MUST advance without the user reloading the page

#### Scenario: The page adapts between wide and narrow viewports

- **GIVEN** the page has at least one visible connection
- **WHEN** the page is viewed on a wide viewport
- **THEN** it MUST present a master-detail composition (a connection list plus a detail view)
- **AND** when viewed on a narrow (mobile) viewport it MUST present a single-column list
  with a drill-down detail view

#### Scenario: The page reserves a placeholder for forthcoming sessions and transcript

- **WHEN** a user views the detail of a connection
- **THEN** the page MUST show a clearly-labeled placeholder indicating that per-connection
  sessions and transcript are coming, without presenting fabricated session or transcript data

#### Scenario: The page shows an empty state with no connections

- **GIVEN** an authenticated user with no visible connections
- **WHEN** the user opens `/agent-connections`
- **THEN** the page MUST render an empty state describing how to start a daemon rather than
  an empty or broken list

#### Scenario: The page refreshes to reflect status transitions

- **GIVEN** the page is open showing an online connection
- **WHEN** that connection later becomes offline and the refresh interval elapses
- **THEN** the page MUST reflect the offline status without a manual reload

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

