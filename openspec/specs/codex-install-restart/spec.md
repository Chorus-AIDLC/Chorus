# codex-install-restart Specification

## Purpose
TBD - created by archiving change codex-install-safe-app-server-restart. Update Purpose after archive.

## Requirements

### Requirement: Gate restart on completed Codex configuration
The installer SHALL offer restart only after successful Codex credential persistence and explicit successful MCP configuration persistence from a nonfailed plugin outcome, and SHALL leave other agents and plugin-only refreshes unaffected. A warning-only configuration write failure SHALL NOT satisfy this gate.

#### Scenario: Configuration incomplete or identity repoint declined
- **WHEN** credentials were not persisted or plugin configuration failed
- **THEN** the installer does not restart and reports deferred configuration handling without claiming readiness.

### Requirement: Detect supported running daemon conservatively
The installer SHALL use bounded read-only capability and running-state checks and SHALL NOT start an absent daemon, upgrade Codex, or restart on unknown state.

#### Scenario: Unsupported version or ambiguous status
- **WHEN** help/status probes fail, time out, or return unsupported output
- **THEN** no restart occurs and safe manual guidance describes the limitation.

#### Scenario: No running daemon
- **WHEN** the daemon is explicitly reported as not running
- **THEN** no restart or start is performed.

### Requirement: Require explicit interactive consent
Restart SHALL require a dedicated default-no confirmation warning that other sessions can be interrupted. General yes flags SHALL NOT authorize it.

#### Scenario: Interactive acceptance
- **WHEN** a running supported daemon is detected and the interactive user explicitly accepts
- **THEN** one bounded restart command executes.

#### Scenario: Unattended or deferred installation
- **WHEN** the run is non-TTY, headless, uses --yes, lacks a prompt callback, or the user declines
- **THEN** no unauthorized restart occurs and pending manual handling is reported; unattended runs do not prompt.

### Requirement: Use persisted credentials without disclosure
The restart child SHALL inherit the resolved Codex directory and freshly persisted managed Chorus environment, overriding stale managed values without exposing secrets in argv or diagnostics.

#### Scenario: Existing parent environment contains stale credentials
- **WHEN** the persisted credentials differ from inherited CHORUS values
- **THEN** the restart receives persisted values, unrelated environment remains intact, and no credential value is logged.

### Requirement: Report command outcomes without adding verification
The installer SHALL distinguish restart command success, failure and deferral. It SHALL NOT add authentication, MCP discovery, or model-turn verification and SHALL NOT claim live MCP readiness.

#### Scenario: Restart fails or times out
- **WHEN** the restart command fails
- **THEN** a sanitized failure is reported with recovery guidance, saved configuration remains, and other installer work is not aborted.

#### Scenario: Restart command succeeds
- **WHEN** restart exits successfully
- **THEN** only command success is reported, with no implication of verified credentials or native MCP availability.
