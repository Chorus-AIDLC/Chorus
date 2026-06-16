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

The dashboard SHALL provide a top-level page at `/agent-connections`, reachable
from a global sidebar navigation item labeled "Agent Connections" (and its
localized equivalent), that lists the caller's visible connections. The page SHALL
display, per connection, the client type and version, an online/offline indicator
driven by the server-derived `effectiveStatus`, the host, and the last-active time
(from `lastSeenAt`). The page SHALL display the uptime (from `connectedAt`) only
for connections whose `effectiveStatus` is `online`; an offline connection SHALL
NOT show an uptime, because `now - connectedAt` for a connection that is no longer
up is an ever-growing, misleading value. The page SHALL refresh on a periodic
interval so that online↔offline transitions appear without a manual reload, and
SHALL show an empty state explaining how to start a daemon when the caller has no
connections. All user-facing strings SHALL be localized in both supported locales.
The navigation item SHALL NOT be labeled "Daemons".

#### Scenario: The page lists the caller's connections

- **GIVEN** an authenticated user with one online and one offline visible connection
- **WHEN** the user opens `/agent-connections`
- **THEN** the page MUST render both connections with their client type, host, and
  an indicator reflecting each connection's `effectiveStatus`

#### Scenario: Uptime is shown only for online connections

- **GIVEN** an online connection and an offline connection
- **WHEN** the user opens `/agent-connections`
- **THEN** the online connection MUST show an uptime derived from `connectedAt`
- **AND** the offline connection MUST NOT show an uptime

#### Scenario: The page shows an empty state with no connections

- **GIVEN** an authenticated user with no visible connections
- **WHEN** the user opens `/agent-connections`
- **THEN** the page MUST render an empty state describing how to start a daemon
  rather than an empty or broken list

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

