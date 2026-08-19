## ADDED Requirements

### Requirement: npm bundle SHALL deliver the lifecycle runtime

The `@chorus-aidlc/chorus-dsh` package SHALL include the self-contained lifecycle runtime and SHALL load it from `cordis.patch.yml` for every composition that activates the bundle. Runtime behavior, configuration bounds, daemon-origin suppression, check-in, tool observation, steering, and cleanup MUST remain equivalent to the existing lifecycle contract.

#### Scenario: Interactive bundle activates lifecycle behavior

- **WHEN** an interactive dsh profile activates the npm bundle without the daemon-origin signal
- **THEN** the lifecycle runtime MUST perform bounded check-in and successful Chorus-tool steering according to the existing requirements

#### Scenario: Daemon bundle suppresses lifecycle behavior

- **WHEN** a daemon composition activates the npm bundle with `CHORUS_DAEMON_HEADLESS=1`
- **THEN** the lifecycle runtime MUST register no Chorus lifecycle automation
- **AND** the daemon MUST remain the sole turn and token reporter

#### Scenario: Package is upgraded

- **WHEN** dsh or the Chorus-managed daemon project installs a newer package version
- **THEN** the composition MUST load the runtime from that installed package
- **AND** no generated runtime copy under `public/` or `$DSH_HOME/chorus` MUST be required

## REMOVED Requirements

### Requirement: Installer-managed plugin delivery

**Reason**: The lifecycle runtime is now delivered and versioned inside the native dsh npm bundle; the hosted installer and `$DSH_HOME` artifact are removed.

**Migration**: Install `@chorus-aidlc/chorus-dsh` into the desired interactive profile or let Chorus prepare the daemon-managed package/config.

