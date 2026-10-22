# ci-failure-recovery Specification

## Purpose
TBD - created by archiving change stabilize-recurring-ci. Update Purpose after archive.

## Requirements

### Requirement: Preserve dependency security gates
The root dependency graph SHALL use a Vite release that clears the reported high-severity advisory without adding exemptions or disabling the root high/critical audit.

#### Scenario: Reproducible audited installation
- **WHEN** dependencies are installed from the committed frozen pnpm lockfile
- **THEN** the root audit and its regression tests pass with the existing policy

### Requirement: Deterministic installer interruption checks
Installer interruption tests MUST retain terminal echo restoration, signal-specific nonzero exit status, no persisted configuration and no Docker side effects. Linux signal injection SHALL wait for the intended stdin read with a bounded deadline instead of racing password prompt output.

#### Scenario: Signal arrives during password input
- **WHEN** SIGHUP, SIGINT or SIGTERM is sent after the installer enters password input
- **THEN** the corresponding signal exit status is observed, echo is restored and no configuration or Docker action occurs

#### Scenario: Repeated Linux regression
- **WHEN** signal tests run for at least 30 rounds on the supported Linux runner
- **THEN** every round completes without timeout and retains the same assertions

### Requirement: Remote delivery evidence
CI recovery MUST be backed by successful applicable checks on the submitted fix commit, not an old task status or local-only run. Delivery SHALL target develop without automatic merge or deployment.

#### Scenario: Ready for human merge review
- **WHEN** the repair PR is handed off
- **THEN** its commit SHA, successful CI run links and remaining platform limitations are recorded
