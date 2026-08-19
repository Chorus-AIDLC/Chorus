## ADDED Requirements

### Requirement: Chorus accepts dsh daemon client connections

The server SHALL recognize `dsh` as a supported daemon client type and SHALL apply the existing daemon connection registration behavior to a self-report whose `clientType` is `dsh`.

#### Scenario: dsh self-report passes the server client-type gate

- **WHEN** an authenticated daemon connection self-reports `clientType=dsh`
- **THEN** the server MUST treat the client type as supported rather than reject it as unknown

#### Scenario: Existing client types remain supported

- **WHEN** a daemon self-reports any previously supported client type
- **THEN** the server MUST preserve the existing acceptance behavior

### Requirement: The CLI recognizes dsh backend metadata

The daemon CLI SHALL include `dsh` in its known agent backends, SHALL resolve its executable descriptor to `{ name: "dsh", envVar: "CHORUS_DSH_PATH" }`, and SHALL map the backend to the self-reported client type `dsh`. The default backend SHALL remain `claude-code`, and unknown backend values SHALL remain rejected.

#### Scenario: Operator selects dsh

- **WHEN** the operator selects `dsh` through any existing agent-selection source
- **THEN** agent resolution MUST return `dsh`
- **AND** the CLI descriptor MUST name the `dsh` executable and `CHORUS_DSH_PATH`
- **AND** the daemon client type MUST be `dsh`

#### Scenario: No backend is selected

- **WHEN** no agent backend is configured
- **THEN** the CLI MUST continue to resolve `claude-code` as the default

#### Scenario: Unknown backend is selected

- **WHEN** an operator selects a backend outside the known set
- **THEN** the CLI MUST continue to reject the value without silently falling back

### Requirement: Presence surfaces display a localized dsh label

The shared client-type label resolver SHALL map `dsh` to the `agentConnections.clientDsh` translation key, and every supported locale (`en`, `zh`, `ja`, and `ko`) MUST define that key. Components that already use the shared resolver SHALL display `DeepSeek Harness` for dsh connections.

#### Scenario: A dsh connection is rendered

- **WHEN** a presence, connection, or session surface renders a connection whose client type is `dsh`
- **THEN** the surface MUST display the localized `clientDsh` product label instead of the unknown-client label

#### Scenario: Each supported locale resolves the label

- **WHEN** the interface locale is English, Chinese, Japanese, or Korean
- **THEN** resolving `agentConnections.clientDsh` MUST produce `DeepSeek Harness`

### Requirement: dsh registration requires no persistence migration

The implementation SHALL continue storing daemon client types in the existing string field and SHALL NOT add or alter a database migration solely to register `dsh`.

#### Scenario: The change is deployed

- **WHEN** dsh client-type support is released
- **THEN** existing daemon connection and session records MUST remain compatible without a schema or data migration
