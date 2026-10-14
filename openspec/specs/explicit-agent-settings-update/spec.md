# explicit-agent-settings-update Specification

## Purpose
Preserve existing agent configuration unless the operator explicitly requests a settings update, including safe normalization of legacy flat configurations.

## Requirements

### Requirement: Existing agent cwd updates require explicit intent
The installer cwd resolver SHALL report flag, interactive, existing, or default provenance. Credential seeding SHALL forward cwds to an existing agent's settings updater only for a nonempty value from flag or interactive provenance. New agents SHALL continue receiving the resolved cwd defaults.

#### Scenario: Non-interactive rerun from a different directory
- **WHEN** a configured agent serves /repo and a non-TTY or --yes rerun resolves the default cwd /somewhere/else without --cwd
- **THEN** the existing agent retains /repo and the credential outcome is SKIPPED when no explicit wake setting was requested

#### Scenario: Inherited top-level directories
- **WHEN** cwd resolution uses existing top-level cwds rather than explicit input
- **THEN** the existing agent's own cwds remain unchanged

#### Scenario: Explicit cwd or interactive selection
- **WHEN** a user supplies --cwd or answers the cwd prompt
- **THEN** the selected normalized directories update the existing agent and unrelated settings remain unchanged

#### Scenario: Explicit wake only
- **WHEN** the user requests --daemon-wake but cwd resolution is implicit
- **THEN** daemonWake is updated without changing existing agent directories

### Requirement: Legacy flat config updates are compatible and non-destructive
The settings updater SHALL support explicit allowlisted settings for a matching flat-config agent by normalizing into agents[]. It SHALL preserve identity, backend and unrelated settings. It SHALL NOT migrate a config for a no-settings request or an absent identity. appendAgentConfig SHALL remain append-only.

#### Scenario: Flat config no-flags rerun
- **WHEN** an existing flat-config agent is re-added non-interactively without explicit cwd or wake settings
- **THEN** credential seeding reports SKIPPED without config writes or migration

#### Scenario: Explicit flat wake or cwd update
- **WHEN** a matching flat agent receives an explicit daemonWake or cwd request
- **THEN** it is normalized into agents[] and only requested settings change, retaining all unrelated configuration

#### Scenario: Different identity
- **WHEN** a settings update targets an API key not present in the flat config
- **THEN** it reports absent and does not write the file

### Requirement: Regression tests cannot write real user settings
Regression tests SHALL use real cwd resolution while isolating daemon storage and every external credential writer, including Claude settings.

#### Scenario: Real-resolver regression execution
- **WHEN** the cwd regression suite runs
- **THEN** it proves the default-overwrite case without modifying any real home-directory config
