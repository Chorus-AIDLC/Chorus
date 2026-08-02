## ADDED Requirements

### Requirement: A wake SHALL have one immutable runtime working directory
Every daemon wake SHALL resolve exactly one runtime working directory before transcript probing or process spawn. For a startup-connection wake, that directory SHALL remain the connection-bound cwd. For a directed discovered-cwd wake, it SHALL be the validated `runtimeCwd` persisted on the daemon session. Transcript probing, spawn, resume, and subsequent turns MUST all consume that same value. A directed runtime cwd MUST NOT mutate the daemon's process cwd, startup `cwds`, or another concurrent wake's directory.

#### Scenario: Startup connection wake
- **WHEN** a wake is delivered through an existing cwd-bound connection without a directed runtime cwd
- **THEN** probing and spawn MUST use that connection's cwd exactly as before

#### Scenario: Directed discovered-cwd wake
- **WHEN** an authorized wake targets an allowed runtime cwd on the connection's host
- **THEN** the daemon MUST create or reuse an isolated runtime context bound to that cwd
- **AND** probing and spawn MUST use the runtime cwd

#### Scenario: Concurrent runtime directories
- **WHEN** one daemon runs wakes for two different runtime cwd values concurrently
- **THEN** each wake MUST retain its own cwd, transcript namespace, execution state, and session continuation without cross-talk
