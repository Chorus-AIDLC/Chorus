## ADDED Requirements

### Requirement: Failed backend wakes expose bounded structured diagnostics

Every supported daemon backend SHALL expose an optional `wakeError` containing a nonblank bounded summary, diagnostic kind and backend source, optional bounded plain-text details, and any available exit code or signal. Claude, Codex, Pi, Kiro, DSH and the OpenClaw daemon client SHALL cover startup and execution failures according to their available authoritative information. Successful wakes and warning-only stderr SHALL NOT produce a wake error. A backend-declared terminal execution failure MUST NOT be converted into success by process exit zero.

#### Scenario: A backend executable cannot be started
- **WHEN** a supported process backend cannot locate or spawn its executable
- **THEN** its failed wake result SHALL contain a startup summary even if no child callback or assistant reply occurs
- **AND** the daemon SHALL remain able to handle another wake

#### Scenario: A backend reports terminal failure with a clean host exit
- **WHEN** an authoritative matching terminal backend event reports an execution failure and the host process exits zero
- **THEN** the classified wake SHALL fail and provide the available structured reason

#### Scenario: A successful wake writes a warning
- **WHEN** a wake succeeds and stderr contains only warnings
- **THEN** its result SHALL omit the failure diagnostic

#### Scenario: Error output is long or contains terminal escape codes
- **WHEN** a failed wake writes long stderr containing ANSI/control output or known Chorus credentials
- **THEN** collected output SHALL be bounded while streaming and the reported text SHALL be bounded and sanitized
- **AND** the existing bounded process-settlement behavior SHALL remain intact

#### Scenario: A failed wake has no textual reason
- **WHEN** a failed wake provides no usable structured error or stderr
- **THEN** its summary SHALL describe the known exit code, signal or launch failure without inventing an upstream reason
