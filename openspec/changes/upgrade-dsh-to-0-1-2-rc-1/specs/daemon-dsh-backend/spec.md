# daemon-dsh-backend Specification (delta)

## MODIFIED Requirements

### Requirement: External dsh runtime discovery
The daemon SHALL resolve the DeepSeek Harness runtime by locating the `dsh` CLI executable (or an equivalent prebuilt SDK-runtime executable) from `CHORUS_DSH_PATH` or `PATH`, SHALL launch it in SDK mode via the `sdk` profile with a Chorus-supplied Cordis `--patch` overlay and a managed `DSH_HOME`, SHALL NOT depend on the removed `dsh-jsonrpc-agent` binary or a standalone `DSH_CORDIS_CONFIG` env file, and SHALL fail visibly without affecting other backends when the runtime executable cannot be resolved.

#### Scenario: Runtime is available
- **WHEN** `--agent dsh` is selected and the `dsh` runtime executable is resolvable
- **THEN** the daemon launches it as `dsh --profile sdk` with the Chorus Cordis patch overlay and a managed `DSH_HOME`, adding neither the prompt nor credentials to argv

#### Scenario: Runtime is unavailable
- **WHEN** `--agent dsh` is selected and no `dsh` runtime executable can be resolved from `CHORUS_DSH_PATH` or `PATH`
- **THEN** the wake returns a non-success result and logs an actionable diagnostic without crashing the daemon

#### Scenario: Legacy runtime name is not required
- **WHEN** resolution runs against a dsh 0.1.2-rc.1 installation
- **THEN** the daemon SHALL NOT require the removed `dsh-jsonrpc-agent` binary or a `DSH_CORDIS_CONFIG` file to launch a wake

## ADDED Requirements

### Requirement: Managed dsh SDK-profile composition
The daemon-managed dsh composition SHALL build the runtime environment using the `dsh` `sdk` profile — installing the `@deepseek-ai/dsh` runtime and the `@chorus-aidlc/chorus-dsh` bundle under a managed `DSH_HOME` and applying the Chorus Cordis rows through the bundle's patch overlay — SHALL validate that the composed profile boots before marking it active, and SHALL NOT install or require the removed demo runtime packages.

#### Scenario: Managed composition is built
- **WHEN** the daemon prepares a managed dsh runtime for the `sdk` profile
- **THEN** it installs `@deepseek-ai/dsh` and `@chorus-aidlc/chorus-dsh`, applies the Chorus patch overlay, and boots `dsh --profile sdk` to validate the composition before atomically activating it

#### Scenario: Removed demo packages are not required
- **WHEN** managed composition runs against dsh 0.1.2-rc.1
- **THEN** it SHALL NOT install or require `@deepseek-ai/dsh-agent-spine-demo` or `@deepseek-ai/dsh-sdk-jsonrpc-demo`
