# cli-daemon Specification

## Purpose
TBD - created by archiving change add-chorus-cli-daemon. Update Purpose after archive.
## Requirements
### Requirement: Daemon subcommand and notification subscription

The CLI SHALL provide a `chorus daemon` subcommand that runs a long-lived client process. On start it SHALL resolve credentials (see cli-auth), open a Server-Sent Events subscription to the remote Chorus notification stream (`/api/events/notifications`) authenticated with the `cho_` API key, and remain running until terminated. Adding the `daemon` and `login` subcommands SHALL NOT change the behavior of invoking the CLI with no subcommand (which continues to launch the Chorus server).

#### Scenario: Daemon connects and subscribes

- **WHEN** the user runs `chorus daemon` with resolvable credentials
- **THEN** the process authenticates, opens the notification SSE subscription, logs the connected agent identity, and stays running

#### Scenario: Bare CLI still launches the server

- **WHEN** the user runs `chorus` with no subcommand (or the existing server flags)
- **THEN** the Chorus server launches exactly as before, with no daemon behavior triggered

### Requirement: Task-dispatch wake of local headless Claude Code

On receiving a relevant notification (at minimum `task_assigned`), the daemon SHALL spawn a local headless Claude Code subprocess (`claude -p` with `--output-format stream-json` and the Chorus MCP server configured via `--mcp-config`) to act on the dispatched work. The daemon SHALL feed the prompt to the subprocess over stdin rather than as a command-line argument. Each wake SHALL be non-blocking with respect to the notification subscription, and a failure of one wake SHALL be logged visibly without terminating the daemon.

#### Scenario: Task assignment wakes Claude Code

- **WHEN** the subscribed agent receives a `task_assigned` notification
- **THEN** the daemon spawns a headless `claude -p` subprocess wired to the Chorus MCP server, passing the task context prompt over stdin, and the subprocess can act via `chorus_*` MCP tools

#### Scenario: One failed wake does not kill the daemon

- **WHEN** a spawned subprocess fails to start or exits with an error
- **THEN** the daemon logs the failure visibly and continues processing subsequent notifications

### Requirement: Lineage-anchored session continuity

The daemon SHALL key each local Claude session on the **root idea** of the dispatched entity. It SHALL resolve any inbound event up the Chorus lineage (`task → proposal → idea`, then following `idea.parentUuid`) to its topmost idea, and SHALL maintain a persisted map from root idea to Claude session id. When a notification resolves to a root idea that already has a session, the daemon SHALL resume that session (`--resume`); when it resolves to a new root idea, the daemon SHALL start a fresh session and persist the newly created session id. When no idea ancestor exists, the daemon SHALL fall back to a per-entity session key.

#### Scenario: Same root idea resumes the same session

- **WHEN** two notifications (e.g. a task execution then a later proposal rejection) both resolve up the lineage to the same root idea
- **THEN** the second wake resumes the same Claude session id used by the first via `--resume`

#### Scenario: Different root idea starts a fresh session

- **WHEN** a notification resolves to a root idea that has no recorded session
- **THEN** the daemon starts a fresh Claude session, captures the new session id from the subprocess output, and persists it under that root idea

### Requirement: Per-root-idea wake serialization

Because each root idea maps to a single Claude session, the daemon SHALL ensure that at most one wake runs at a time for any given root-idea session key, while allowing wakes for different root ideas to run concurrently. Wakes targeting the same root idea SHALL be queued and executed in arrival order, so the daemon never runs two concurrent subprocesses that resume the same session. Enqueuing a wake SHALL NOT block the notification subscription loop, and a failing wake SHALL NOT permanently block subsequent wakes for the same root idea.

#### Scenario: Two notifications for the same root idea run sequentially

- **WHEN** two notifications that resolve to the same root idea arrive in close succession
- **THEN** the daemon runs the first wake to completion before spawning the second, so no two concurrent subprocesses resume the same session id

#### Scenario: Notifications for different root ideas run concurrently

- **WHEN** two notifications that resolve to different root ideas arrive in close succession
- **THEN** the daemon may run both wakes concurrently (each on its own session)

#### Scenario: A failed wake does not wedge the queue

- **WHEN** a queued wake for a root idea fails or its subprocess errors
- **THEN** the failure is logged and the next queued wake for that same root idea still proceeds

### Requirement: Cross-platform headless spawn

The daemon's subprocess spawning SHALL work on Linux, macOS, and Windows without relying on a shell. It SHALL resolve the real `claude` executable path (including the Windows `claude.cmd` shim) and spawn it directly without `shell:true`. It SHALL write the MCP configuration file to the OS temporary directory (`os.tmpdir()`), not a hardcoded path. It SHALL parse the subprocess's newline-delimited JSON output line by line, tolerating Windows `\r\n` line endings.

#### Scenario: Windows spawn resolves the .cmd shim without a shell

- **WHEN** the daemon runs on Windows where `claude` is installed as `claude.cmd`
- **THEN** it resolves and spawns the real `claude.cmd` path directly without `shell:true`, and the prompt is delivered over stdin

#### Scenario: Stream-json output parses across platforms

- **WHEN** the subprocess emits newline-delimited JSON with `\r\n` line endings on Windows
- **THEN** the daemon strips the trailing carriage return and parses each line as JSON without error

### Requirement: Reconnect with backfill

When the notification subscription drops and reconnects, the daemon SHALL fetch notifications that arrived while it was disconnected and re-fire any wakes that were missed, so a dispatch that occurred during a brief disconnection is not silently lost.

#### Scenario: Missed dispatch is recovered on reconnect

- **WHEN** the subscription drops, a `task_assigned` notification is created during the gap, and the subscription then reconnects
- **THEN** the daemon backfills the unhandled notification and wakes Claude Code for it

### Requirement: Reserved upload hooks for observability

The daemon SHALL define connection-register, session-register, and transcript-report hook points as no-op stubs in this change, so a future observability layer can report daemon connections, sessions, and live transcript messages to the server without modifying the wake path. This change SHALL NOT itself send connection, session, or transcript data to the server.

#### Scenario: Hooks exist as no-ops

- **WHEN** the daemon connects, starts a session, and receives subprocess transcript messages
- **THEN** the corresponding hook points are invoked but perform no server upload in this change

