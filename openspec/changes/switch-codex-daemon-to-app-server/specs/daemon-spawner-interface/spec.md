## MODIFIED Requirements

### Requirement: A wake SHALL settle on process exit, not only on stdio close

Every spawner SHALL observe process termination through the shared settlement module. When close arrives first, that module SHALL return the raw process exit code immediately. When exit arrives before close because descendants retain stdio, the module SHALL drain trailing output for a short bounded grace period and then return the raw exit code without waiting indefinitely for close. It SHALL settle once, log one diagnostic naming the backend and raw exit code if the drain period expires, and use a timer that does not keep the daemon event loop alive.

The raw process result and the spawner's classified wake result SHALL remain distinct. Backends without an authoritative protocol outcome SHALL preserve their existing exit-code and post-exit behavior. A protocol-backed Codex spawner SHALL combine the raw result, matching terminal turn state and bounded cleanup outcome: an exit code of zero without a matching successful turn MUST NOT become a successful wake, and a failed/interrupted turn MUST NOT be converted into success by a clean process exit. The final wake SHALL still settle exactly once after bounded cleanup, retaining required session identity and reporting.

The shared drain grace period SHALL bound only already-exited process IO; it SHALL NOT impose a total wake-duration limit. Backend protocol startup/inactivity limits remain separately specified.

#### Scenario: Close arrives first
- **WHEN** a spawned agent emits close with an exit code
- **THEN** the shared module SHALL return that raw code immediately without a grace warning
- **AND** backends without protocol outcome classification SHALL retain their existing wake result

#### Scenario: Exit arrives but a descendant holds the pipes open
- **WHEN** exit occurs and close never arrives because a descendant retains stdio
- **THEN** the shared module SHALL return the raw code after the bounded grace period and log once that stdio stayed open
- **AND** protocol-backed cleanup MUST NOT wait indefinitely for those pipes

#### Scenario: Both events arrive
- **WHEN** exit is followed by close within the grace period
- **THEN** the shared module SHALL settle once with the raw exit code and the spawner SHALL publish one final wake result

#### Scenario: Every spawner shares the settlement path
- **WHEN** pi, claude, codex, kiro or dsh observes process termination
- **THEN** it SHALL use the shared settlement module
- **AND** non-Codex session-conflict classification, snapshot diffing, session identity resolution and failure behavior SHALL remain unchanged
- **AND** Codex SHALL additionally apply its authoritative turn-outcome and cleanup classification

#### Scenario: Codex exits cleanly without successful protocol completion
- **WHEN** Codex exits zero but its active turn has no matching completed-success event
- **THEN** shared process settlement SHALL return the raw zero code and the Codex spawner MUST classify the wake as failed

## ADDED Requirements

### Requirement: Process-associated graceful stop capabilities preserve backend neutrality
A spawner MAY register an optional asynchronous graceful-stop hook associated with its real ChildProcess before onChild exposes it. The shared process-tree killer SHALL invoke a registered hook within the existing graceful timeout and SHALL retain signal behavior for children without hooks. Hooks MUST NOT be serialized in execution snapshots, require agent-type branches in Waker/control-handler, or prevent forced cleanup on rejection or timeout. Registration and cleanup SHALL be idempotent and confined to that process.

#### Scenario: Child supports protocol stop
- **WHEN** an authorized stop targets a child with a registered hook
- **THEN** the shared killer MUST attempt that hook within its deadline before forced tree cleanup if necessary

#### Scenario: Legacy backend has no hook
- **WHEN** the child has no registered hook
- **THEN** its SIGINT and escalation behavior MUST remain unchanged

#### Scenario: Hook fails or never resolves
- **WHEN** a stop hook rejects or exceeds its deadline
- **THEN** it MUST NOT block forced cleanup or another wake, and no hook data MUST leak into uploaded snapshots
