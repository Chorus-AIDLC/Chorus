## ADDED Requirements

### Requirement: Packaged child roles are host independent
The package SHALL explicitly load role tool providers for all three reviewers and the worker on native MCP and adapter hosts, without requiring optional gateway names, script mode, user agent overrides or role MCP aliases.

#### Scenario: Nicobailon children start on both hosts
- **WHEN** packaged agents launch under Pi 1.1.x with pi-subagents 0.76.1 in native mode or pi-mcp-adapter 5.1.0 default mode
- **THEN** required tools exist before the first turn, reviewers can publish verdicts, workers can access Chorus, and no unavailable-tool false failure occurs

#### Scenario: Bundled dispatcher remains supported
- **WHEN** the package dispatcher launches the same agents
- **THEN** it loads their provider paths relative to the agent file and exposes the intended tools without forwarding paths as tool names

### Requirement: Role operations follow the confirmed boundary
Reviewer Chorus operations SHALL be limited to `chorus_get_*`, `chorus_list_tasks`, `chorus_list_projects`, `chorus_search`, `chorus_checkin`, and `chorus_add_comment`. Workers SHALL additionally support task claim/release/update/report/self-check/submit and task session checkin/checkout. Other mutations and lifecycle/admin operations SHALL NOT be exposed or forwarded by these providers.

#### Scenario: Disallowed operation is denied
- **WHEN** a reviewer requests approval, task update, verification, session creation or an arbitrary gateway operation
- **THEN** the tool fails visibly before any network dispatch

#### Scenario: Query family stays broad
- **WHEN** discovery lists a new `chorus_get_*` tool
- **THEN** it is available to the reviewer, while unrelated operations remain absent

#### Scenario: Worker submits a task
- **WHEN** a worker discovers schemas and calls report, self-check and submit with valid arguments
- **THEN** the real Chorus state changes are returned faithfully without requiring parent native MCP inheritance

### Requirement: Discovery and transport fail transparently
Role providers SHALL return actual allowed tool schemas, honor pagination, and propagate transport, protocol, tool and cancellation failures. They SHALL reuse configured credentials without revealing them or rewriting user configuration.

#### Scenario: Tool call fails
- **WHEN** Chorus returns a tool error or the transport fails
- **THEN** the child receives an error rather than a success-shaped empty object

#### Scenario: Configuration is missing
- **WHEN** a child lacks a usable Chorus connection
- **THEN** its stable role tool remains registered but calls explain the missing configuration without exposing secrets

### Requirement: Isolation claims and full lifecycle are verified
Documentation SHALL distinguish tool-surface restrictions from strong security isolation and preserve local read/test capabilities. Verification SHALL include actual child execution and real model-driven complete AI-DLC workflows against local Chorus on native and adapter hosts.

#### Scenario: Full local workflow
- **WHEN** a Pi orchestrator runs a small local idea through proposal and task execution
- **THEN** proposal, task and aggregate reviewers publish verdicts, the worker implements and submits, the orchestrator verifies completion and writes a report, and child exit statuses agree with successful execution

#### Scenario: Read-only limitation is documented
- **WHEN** a user reads the Pi connection guide
- **THEN** it states that bash/inherited credentials are not sandboxed, comment target scope is behavioral, and tests/builds may create outputs
