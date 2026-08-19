## MODIFIED Requirements

### Requirement: External dsh runtime discovery

The daemon SHALL resolve `dsh-jsonrpc-agent` from `CHORUS_DSH_PATH` or `PATH`. It SHALL use an explicit non-empty `CHORUS_DSH_CONFIG` or `DSH_CORDIS_CONFIG` when provided; otherwise it SHALL select a validated Chorus-managed Cordis configuration backed by the installed `@chorus-aidlc/chorus-dsh` package. It SHALL fail visibly without affecting other backends when the runtime, explicit config, or managed package/config cannot be prepared or resolved.

#### Scenario: Runtime and explicit config are available

- **WHEN** `--agent dsh` is selected and an external runtime plus explicit config override are available
- **THEN** the daemon launches that runtime without adding the prompt, credentials, or config path to argv
- **AND** it MUST NOT rewrite the operator's config

#### Scenario: Runtime uses managed npm composition

- **WHEN** `--agent dsh` is selected without an explicit config override and managed package/config preparation succeeds
- **THEN** the daemon launches the runtime with the validated managed config through the child environment
- **AND** the child environment MUST include `CHORUS_DAEMON_HEADLESS=1` and the resolved Chorus credentials

#### Scenario: Runtime or composition is unavailable

- **WHEN** the executable cannot be resolved or neither a valid explicit nor managed config is available
- **THEN** the wake returns a non-success result and logs an actionable diagnostic without crashing the daemon

## ADDED Requirements

### Requirement: Daemon installation SHALL prepare dsh package state before service activation

When daemon installation selects dsh, Chorus SHALL install or update the configured `@chorus-aidlc/chorus-dsh` version and its four named peer plugins (`@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-tool-skill`, and `@deepseek-ai/dsh-persona`) in Chorus-owned state. It SHALL generate a secret-free Cordis config and validate every named import plus the effective composition before writing or activating the daemon service. Repeated preparation MUST be idempotent and MUST NOT mutate `$DSH_HOME`.

#### Scenario: dsh daemon installation succeeds

- **WHEN** the package manager, registry package, dsh runtime, and Chorus credentials are available
- **THEN** package/config preparation and composition validation MUST complete before service activation
- **AND** the generated config directory MUST resolve the Chorus bundle and all four peer plugins from its managed `node_modules`
- **AND** the resulting service MUST be able to start from a clean login environment

#### Scenario: package or composition validation fails

- **WHEN** package installation, package resolution, config generation, or dsh composition validation fails
- **THEN** daemon installation MUST stop before activating a broken service
- **AND** it MUST preserve the last validated managed state and report the failing stage
