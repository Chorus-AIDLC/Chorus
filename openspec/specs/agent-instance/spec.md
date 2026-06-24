# agent-instance Specification

## Purpose
TBD - created by archiving change add-agent-instance-addressing. Update Purpose after archive.
## Requirements
### Requirement: AgentInstance is a durable (company, agent, host, cwd) identity

The system SHALL persist a first-class `AgentInstance` entity uniquely identified by the
tuple `(companyUuid, agentUuid, host, cwd)`. The entity SHALL store only durable identity
fields — `companyUuid`, `agentUuid`, `host`, `cwd`, `createdAt`, `updatedAt` — and SHALL NOT
store liveness fields (status, lastSeenAt, firstSeenAt); liveness is a property of the
`DaemonConnection`, not the instance. `host` SHALL default to the empty string (`""`) to mean
"unknown host" and `cwd` SHALL be nullable to mean "unknown path", matching the existing
`DaemonConnection` sentinels.

#### Scenario: First daemon report creates the instance

- **WHEN** a daemon connection is registered for an `(agentUuid, host, cwd)` that has no
  existing `AgentInstance` row in that company
- **THEN** the system creates exactly one `AgentInstance` row with that identity tuple

#### Scenario: Repeat report does not duplicate the instance

- **WHEN** a daemon connection is registered for an `(agentUuid, host, cwd)` that already has
  an `AgentInstance` row in that company
- **THEN** the system reuses the existing `AgentInstance` row and does not create a duplicate

#### Scenario: Instance identity is stable across reconnects

- **WHEN** a daemon for the same `(agentUuid, host, cwd)` disconnects and reconnects, producing
  a new `DaemonConnection.uuid`
- **THEN** the resolved `AgentInstance.uuid` is unchanged

### Requirement: DaemonConnection links to the instance it serves

A `DaemonConnection` SHALL carry a nullable `agentInstanceUuid` referencing the
`AgentInstance` it currently serves. When a connection is registered or re-registered for an
`(agentUuid, host, cwd)`, the system SHALL set `agentInstanceUuid` to the matching
`AgentInstance`. Online/offline liveness for an instance SHALL be derived from its linked
`DaemonConnection` using the existing rule (`status === "online"` AND
`now - lastSeenAt <= STALE_THRESHOLD_MS`), not from the `AgentInstance` row.

#### Scenario: Connection registration links the instance

- **WHEN** a daemon connection is registered for `(agentUuid, host, cwd)`
- **THEN** that connection row's `agentInstanceUuid` references the `AgentInstance` for the
  same `(companyUuid, agentUuid, host, cwd)`

#### Scenario: Instance liveness comes from the connection

- **WHEN** an instance's linked connection has `effectiveStatus === "online"`
- **THEN** the instance is reported online; and when the connection is stale or offline, the
  instance is reported offline

### Requirement: Instances are retained while referenced

The system SHALL NOT automatically delete `AgentInstance` rows. An `AgentInstance` that is
referenced by any assignment (an `agent_instance` assignee on an Idea or Task) SHALL remain
persisted regardless of whether any connection is currently online.

#### Scenario: Offline instance referenced by an assignment is retained

- **WHEN** an `AgentInstance` is the `agent_instance` assignee of an Idea and all its
  connections are offline
- **THEN** the `AgentInstance` row is retained and still resolvable by its uuid

