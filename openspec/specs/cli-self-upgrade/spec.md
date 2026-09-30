# cli-self-upgrade Specification

## Purpose
TBD - created by archiving change add-cli-self-upgrade. Update Purpose after archive.
## Requirements
### Requirement: Explicit self-upgrade command
The CLI SHALL expose equivalent `upgrade` and `update` client commands, defaulting to CLI-only operation, with `--plugins` enabling plugin synchronization. Invalid arguments SHALL fail before mutation; help SHALL avoid server startup and external probes.

#### Scenario: Alias and help
- **WHEN** either verb is invoked with `--help`
- **THEN** upgrade usage is printed and the process exits successfully without starting a server or invoking npm.

#### Scenario: Default isolation
- **WHEN** the user invokes upgrade without `--plugins`
- **THEN** no daemon configuration is read and no plugin operations run.

### Requirement: Verified npm global self-upgrade
On Linux x64/arm64, macOS x64/arm64 and Windows, the CLI SHALL verify that the running package is the active npm global registry installation, resolve a stable latest release, update that installation if older, and verify its resulting version. Unsupported/ambiguous installations SHALL receive guidance and a nonzero exit without mutation. A newer local stable version SHALL NOT be downgraded.

#### Scenario: Supported installation
- **WHEN** the running package belongs to npm's global prefix and an upgrade exists
- **THEN** only that prefix's Chorus package is upgraded and the expected installed version is verified.

#### Scenario: Source or linked installation
- **WHEN** execution originates from a checkout, npm link, npx or other unsupported location
- **THEN** the command refuses self-upgrade with actionable guidance.

#### Scenario: CLI failure
- **WHEN** discovery, install or version verification fails
- **THEN** the CLI reports the failure, exits nonzero and does not start plugin operations.

#### Scenario: CLI current with plugin request
- **WHEN** the CLI is current or newer and `--plugins` was specified
- **THEN** configured plugin synchronization still executes.

### Requirement: Configured plugin targets
Plugin synchronization SHALL read daemon configuration without changing registration or credentials, process explicitly typed Claude Code/Codex/Kiro/Pi records irrespective of wake enablement, and resolve each record’s effective validated environment (including home/config directories and PATH) before detecting, reading or updating its host. It SHALL deduplicate shared installation destinations while preserving distinct per-record homes. Offline/unknown entries and missing host executables SHALL be visibly skipped as incomplete. Conflicting sources for one shared Kiro destination SHALL fail that target.

#### Scenario: Empty and invalid configuration
- **WHEN** daemon configuration is absent or has an empty agents list
- **THEN** synchronization reports no configured targets as a successful no-op.

#### Scenario: Malformed configuration
- **WHEN** daemon configuration is unreadable or invalid JSON
- **THEN** synchronization reports failure rather than claiming an empty successful configuration.

#### Scenario: Shared installation
- **WHEN** multiple configured records use the same host installation
- **THEN** the plugin installation runs once with record associations represented in its result.

### Requirement: Chorus-only plugin mutation
Synchronization SHALL update only Chorus plugins and necessary integration dependencies, supplement missing plugins when the host is installed, and preserve unrelated configuration. It SHALL NOT install host CLIs, seed credentials, run agent registration, or invoke an all-extension updater.

#### Scenario: Missing plugin
- **WHEN** a configured supported host exists but its Chorus plugin is absent
- **THEN** the named Chorus plugin is installed noninteractively.

#### Scenario: No targeted update capability
- **WHEN** a host such as Pi cannot verifiably refresh only the required packages
- **THEN** the command reports an incomplete targeted-update limitation without updating unrelated packages.

#### Scenario: Kiro version source
- **WHEN** a Kiro plugin refresh runs
- **THEN** Chorus assets come from the configured instance and the source is identified in the result.

### Requirement: Observable noninteractive completion
The command SHALL use bounded noninteractive subprocess operations, continue after individual plugin failures, and summarize success/failure/skip outcomes without exposing credentials. Exit status SHALL be nonzero for any incomplete requested target and zero for complete runs, including missing/empty configuration and deduplicated targets. Completed mutations SHALL remain in place without rollback.

#### Scenario: Partial plugin failure
- **WHEN** one plugin update fails
- **THEN** later targets still run, the summary identifies the incomplete target, and the command exits nonzero.

#### Scenario: Runtime activation
- **WHEN** an upgrade changes installed files
- **THEN** the command prints restart/new-session guidance without restarting daemon processes or interrupting active sessions.

#### Scenario: Distinct configured profiles
- **WHEN** two same-type Agent records have different effective plugin homes, including a binary available only in a record's PATH
- **THEN** each destination is refreshed through its own effective environment and neither is collapsed into the invoking user's installation.

#### Scenario: Windows npm installation
- **WHEN** an npm global installation on Windows invokes upgrade through a shim with paths containing spaces
- **THEN** the command supports the Windows global layout and launches npm safely to update that same installation.
