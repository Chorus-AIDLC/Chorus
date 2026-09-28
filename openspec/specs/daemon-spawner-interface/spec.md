# daemon-spawner-interface Specification

## Purpose
TBD - created by archiving change add-daemon-codex-backend. Update Purpose after archive.
## Requirements
### Requirement: Backend-agnostic spawner interface and selection

The daemon SHALL define a backend-agnostic spawner contract `wake({ prompt, sessionId, isNew, mcpConfigPath, cwd, onMessage, onChild }) → { sessionId, exitCode, isNew }` that both the Claude Code and Codex backends implement, and SHALL select which spawner instance to inject based on the agent type resolved from `--agent` / `CHORUS_AGENT`. The wake pipeline above the spawner (wake-queue, waker, directed delivery, headless guard, turn/transcript lifecycle reporters) SHALL remain backend-agnostic and SHALL NOT branch on the agent type. A spawner SHALL NOT throw into the wake path: any failure to resolve the executable, spawn, or write the prompt SHALL resolve with `exitCode: null` and a visible log line, so one failed wake never crashes the daemon. The spawner SHALL invoke `onChild` exactly once, synchronously, only on a successful spawn, before the wake promise resolves.

#### Scenario: Default selection injects the Claude backend unchanged

- **WHEN** the resolved agent type is `claude-code`
- **THEN** the daemon injects the Claude spawner and its spawn argv and behavior are byte-for-byte the same as before this change

#### Scenario: codex selection injects the Codex backend

- **WHEN** the resolved agent type is `codex`
- **THEN** the daemon injects the Codex spawner, and the waker drives it through the same `wake(...)` contract without any agent-type-specific branching in the waker

#### Scenario: A spawn failure does not crash the daemon

- **WHEN** a spawner cannot locate its backend executable or the spawn fails
- **THEN** the wake resolves with `exitCode: null` and a visible error log, and the daemon continues serving subsequent notifications

### Requirement: Claude transcript discovery matches backend cwd encoding

The Claude daemon backend MUST derive its project transcript directory using the cwd encoding observed from the supported Claude Code installation. For Claude Code 2.1.251, the encoding MUST replace every non-ASCII-alphanumeric UTF-16 code unit with `-`. If the escaped key exceeds 200 characters, the encoding MUST return its first 200 characters followed by `-` and the base36 absolute value of the Java-style signed 32-bit rolling hash of the original cwd (`hash = hash * 31 + charCode`). The encoding MUST correctly locate transcripts for working directories containing spaces and non-ASCII characters and MUST preserve the established output for existing ASCII path, separator, dot, and platform fixtures. The transcript probe and spawned Claude process MUST use the same resolved cwd.

#### Scenario: CJK cwd resumes an existing transcript

- **WHEN** a Claude session transcript exists under Claude Code's encoded project directory for a cwd containing CJK characters
- **THEN** the daemon MUST find that transcript and launch the next wake with `--resume` rather than `--session-id`

#### Scenario: Space-containing cwd resumes an existing transcript

- **WHEN** a Claude session transcript exists under Claude Code's encoded project directory for a cwd containing spaces
- **THEN** the daemon MUST find that transcript and launch the next wake with `--resume` rather than `--session-id`

#### Scenario: Existing ASCII encoding remains compatible

- **WHEN** the daemon encodes an existing ASCII path fixture containing separators, dots, and hyphens
- **THEN** the resulting project directory key MUST remain byte-identical to the verified Claude Code result

#### Scenario: Long cwd uses Claude's bounded project key

- **WHEN** the escaped cwd key exceeds 200 characters
- **THEN** the daemon MUST use the first 200 escaped characters plus the base36 hash suffix computed from the original cwd

#### Scenario: Project key at the boundary is not hashed

- **WHEN** the escaped cwd key is exactly 200 characters
- **THEN** the daemon MUST preserve the complete escaped key without a hash suffix

### Requirement: Claude session conflicts are reported structurally

The Claude spawner MUST classify a non-zero subprocess result whose stderr states that the supplied session ID is already in use as a deterministic session conflict. The classification MUST be returned through the spawner result without parsing daemon log output and MUST NOT classify unrelated stderr or non-zero exits as session conflicts.

#### Scenario: New-session launch conflicts with a registered ID

- **WHEN** Claude exits non-zero and stderr reports that the supplied session ID is already in use
- **THEN** the spawner result MUST identify a deterministic session conflict while preserving the exit code and session identity fields

#### Scenario: Unrelated Claude failure is not classified

- **WHEN** Claude exits non-zero for an error that does not match the session-ID-in-use signature
- **THEN** the spawner result MUST NOT identify a deterministic session conflict

### Requirement: Non-Claude backends retain authoritative session identity

Codex and Kiro MUST continue to decide new-versus-resume state from their backend-owned persisted session mappings rather than Claude's cwd-derived transcript probe. DSH MUST create an isolated runtime session for every wake while passing the resolved cwd verbatim, and OpenClaw MUST derive its stable session key from the Chorus business key and reuse the matching session entry. Working directories containing spaces or non-ASCII characters MUST NOT participate in any of these backend session identities.

#### Scenario: Codex and Kiro ignore the Claude transcript probe

- **WHEN** the shared Waker dispatches a Codex or Kiro wake for a known anchor under a cwd containing spaces or non-ASCII characters, even when the Claude transcript probe reports a new session
- **THEN** the selected spawner MUST derive resume state from its persisted backend session mapping and MUST NOT treat the Claude transcript probe as authoritative

#### Scenario: DSH isolates runtime sessions from cwd

- **WHEN** the shared Waker dispatches a DSH wake under a cwd containing spaces or non-ASCII characters
- **THEN** DSH MUST pass that cwd verbatim and MUST use a fresh isolated runtime session identifier rather than deriving session identity from the cwd or Chorus anchor

#### Scenario: OpenClaw reuses the business-key session

- **WHEN** OpenClaw dispatches a wake under a cwd containing spaces or non-ASCII characters for a Chorus business key with an existing session entry
- **THEN** OpenClaw MUST derive the same stable session key from the business key and MUST reuse the existing session entry independently of the cwd

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

