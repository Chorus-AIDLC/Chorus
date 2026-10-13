## ADDED Requirements

### Requirement: Portable and isolated deployment example
The deployment example SHALL run a single Chorus instance with PostgreSQL 16 without Redis, SHALL persist application signing material and database data, SHALL require private credentials and explicit image selection, and SHALL not publish database ports or reuse existing named resources.

#### Scenario: Local HTTP deployment
- **WHEN** a reader supplies private environment values and selects local mode
- **THEN** the app is accessible only on a configurable loopback port, secure-cookie settings match HTTP, and database health gates app startup.

#### Scenario: Optional public HTTPS deployment
- **WHEN** a reader supplies a Named Tunnel token and routes their hostname to the app container
- **THEN** the Tunnel mode publishes no host ports, uses secure cookies and the reader's external HTTPS URL, and keeps the token out of tracked configuration and command-line values.

### Requirement: Reader-oriented operations
The guide SHALL describe prerequisites and support limits, reproducible setup, authentication including team OIDC limitations of the test login, cost and cache boundaries, health/login/API/MCP/SSE/daemon validation, persistence, backup, isolated restore, upgrade and schema-aware rollback. R2 SHALL be optional encrypted backup storage only.

#### Scenario: Different reader machine
- **WHEN** a reader follows the guide on a qualifying Linux Docker host
- **THEN** all host-specific values are replaceable, no access to the author's accounts or machine paths is needed, and local deployment is distinct from optional Cloudflare public access.

#### Scenario: Restore rehearsal
- **WHEN** the reader follows the backup/restore instructions
- **THEN** fresh isolated resources restore the logical database and needed signing material without modifying the source instance or treating an image downgrade as a database rollback.

### Requirement: Honest and sanitized validation evidence
The change SHALL include separate local evidence with tested versions, commands/results, resource isolation and outstanding checks; it SHALL not expose credentials or claim unexecuted public-path checks succeeded.

#### Scenario: User cloud prerequisites unavailable
- **WHEN** a domain or user-created Tunnel is unavailable
- **THEN** local guide validation proceeds independently and the evidence explicitly marks public HTTPS, edge SSE/MCP and external daemon reconnect as unverified with actionable verification steps.

#### Scenario: Existing host resources
- **WHEN** local validation runs
- **THEN** it uses fresh test data and project-scoped resources without stopping, deleting or reusing existing containers, volumes or databases.
