## ADDED Requirements

### Requirement: A wake SHALL settle on process exit, not only on stdio close

Every spawner SHALL settle its wake as soon as the child process is known to have
terminated. When the child's `close` event arrives first, the wake SHALL settle immediately
with that exit code, preserving today's behaviour exactly. When the child's `exit` event
arrives first — which happens when a detached descendant still holds the inherited stdio
pipes — the spawner SHALL wait a short, bounded grace period for `close` so a trailing
output chunk is still parsed, and SHALL then settle with the exit code regardless. The wake
SHALL settle exactly once, and the settlement logic SHALL live in one shared module used by
all spawners so they cannot drift. When the grace period expires with `close` still pending,
the spawner SHALL log that fact once, naming the backend and the exit code, so an inherited
pipe held by a descendant is diagnosable. The grace timer MUST NOT keep the daemon's event
loop alive.

This grace period bounds only how long an **already-exited** process's pipes are drained. It
is not a limit on how long an agent may run; no wake-duration limit is introduced.

#### Scenario: Close arrives first

- **WHEN** a spawned agent process emits `close` with an exit code
- **THEN** the wake SHALL settle immediately with that exit code and no grace warning SHALL
  be logged

#### Scenario: Exit arrives but a descendant holds the pipes open

- **WHEN** a spawned agent process emits `exit` and `close` never arrives because a detached
  descendant inherited its stdio
- **THEN** the wake SHALL settle with the exit code after the bounded grace period and SHALL
  log once that stdio stayed open

#### Scenario: Both events arrive

- **WHEN** a spawned agent process emits `exit` and then `close` within the grace period
- **THEN** the wake SHALL settle exactly once with that exit code

#### Scenario: Every spawner shares the settlement path

- **WHEN** any of the pi, claude, codex, kiro or dsh spawners settles a wake
- **THEN** it SHALL do so through the one shared settlement module, and its own post-exit
  logic (session-conflict classification, session snapshot diffing, backend session id
  resolution, failure paths) SHALL be unchanged
