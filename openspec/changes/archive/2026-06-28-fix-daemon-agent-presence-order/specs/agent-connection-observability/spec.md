# agent-connection-observability Specification

## ADDED Requirements

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
