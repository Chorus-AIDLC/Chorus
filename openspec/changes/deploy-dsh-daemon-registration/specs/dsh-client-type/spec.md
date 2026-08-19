## ADDED Requirements

### Requirement: dsh registration is verified in the target deployment

The approved Chorus deployment SHALL include the server-side `dsh` client-type registration behavior, and deployment completion MUST be verified against the current target environment through the authenticated SSE and daemon connection API boundaries. The deployment MUST preserve existing client types and MUST NOT require a database migration solely for `dsh`.

#### Scenario: Deployment requires explicit authorization

- **WHEN** the dsh registration candidate and focused regression evidence are ready
- **THEN** commit, release, and deployment actions MUST remain pending until an authorized human explicitly approves the controlled deployment

#### Scenario: A deployed dsh connection is registered

- **WHEN** an authenticated daemon opens the target environment SSE stream with `clientType=dsh`
- **THEN** the stream MUST emit `connection_registered` with a connection UUID
- **AND** `/api/agent-connections` MUST expose the matching dsh connection

#### Scenario: Existing daemon clients remain compatible

- **WHEN** the dsh registration candidate is tested and deployed
- **THEN** focused registration tests MUST preserve acceptance for every previously supported daemon client type
- **AND** the deployment MUST NOT add or require a dsh-specific persistence migration

#### Scenario: Live evidence is secret-safe

- **WHEN** deployment and registration evidence is recorded
- **THEN** it MUST identify the deployed revision and observed registration result without exposing API keys, authorization headers, provider credentials, or secret-bearing environment values
