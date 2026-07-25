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

The daemon SHALL key each local Claude session on the **direct idea** of the
dispatched entity — the idea the entity attaches to directly, NOT the topmost
ancestor of its lineage. For each inbound notification it SHALL resolve the entity by
making a single call to the server-side REST endpoint
`GET /api/entities/{type}/{uuid}/root-idea` (authenticated with its agent API key) and
SHALL use the response's `directIdeaUuid` as the session anchor. The daemon SHALL NOT
perform any client-side lineage walk of its own; the server's `directIdeaUuid`
(including `null`) is authoritative. The daemon SHALL continue to read the response's
`rootIdeaUuid` for execution-state reporting, but SHALL NOT use it for session
anchoring. The daemon SHALL report the server-resolved `rootIdeaUuid` in its execution
snapshot and SHALL NOT derive that reported root from the session-anchor key — because
the anchor key now carries the direct idea, the reported `rootIdeaUuid` and the
direct-idea anchor key SHALL be threaded as separate values, never re-derived from one
another.

The daemon SHALL use a single, explicit spawn working directory for both the on-disk
transcript probe and the subprocess spawn, so the build-vs-resume decision is made
against the same directory in which the session is created.

The Claude session id SHALL be the `directIdeaUuid` itself — a deterministic id, not a
randomly generated one. The daemon SHALL NOT maintain any persisted map from idea to
session id; the prior `~/.chorus/sessions.json` session map SHALL be removed. To decide
whether a wake starts a new session or resumes an existing one, the daemon SHALL probe
the on-disk Claude transcript for the deterministic id at
`<config-dir>/projects/<cwd-escaped>/<directIdeaUuid>.jsonl`, where `<config-dir>`
honors `CLAUDE_CONFIG_DIR` (falling back to `~/.claude`) and `<cwd-escaped>` is the
daemon's spawn working directory with the platform's Claude Code escaping applied. When
the transcript file is absent the daemon SHALL spawn with `--session-id <directIdeaUuid>`
(new session); when it is present the daemon SHALL spawn with `--resume <directIdeaUuid>`
(continue). This disk-probe path is specific to the Claude Code transcript layout and
SHALL NOT be assumed for other agent CLIs.

Before spawning, the daemon SHALL validate that the session id is a well-formed,
lowercase UUID; if it is not, the daemon SHALL log the failure visibly and SHALL NOT
spawn (no silent error). When the endpoint returns no direct idea (a `null`
`directIdeaUuid`) — e.g. a quick task with no proposal, a standalone document, or a
non-idea proposal — or the call fails for any reason, the daemon SHALL still wake by
anchoring the session on the dispatched **entity's own uuid** (and serializing under a
per-entity key). The entity uuid is itself a deterministic Chorus uuid, so such a
session remains human-resumable and same-entity wakes continue it; a wake SHALL NOT be
dropped merely because the entity has no idea ancestor. Resolution results MAY be cached
per run so the same entity is not resolved twice within one daemon run.

#### Scenario: Session id equals the direct idea uuid

- **WHEN** a notification resolves to a `directIdeaUuid`
- **THEN** the daemon spawns Claude with that uuid as the session id, so a human can
  later run `claude --resume <directIdeaUuid>` from the daemon's working directory to
  take over the session

#### Scenario: Parent and child ideas get separate sessions

- **WHEN** one notification resolves to a child idea and another to its parent idea
- **THEN** the daemon anchors each on its own `directIdeaUuid`, spawning two distinct
  Claude sessions — cross-idea context is intentionally not shared

#### Scenario: Same direct idea resumes the same session

- **WHEN** two notifications (e.g. a task execution then a later proposal rejection)
  both resolve to the same `directIdeaUuid`
- **THEN** the second wake finds the transcript on disk and resumes the same session via
  `--resume <directIdeaUuid>`

#### Scenario: First wake for a direct idea creates the deterministic session

- **WHEN** a notification resolves to a `directIdeaUuid` whose transcript file does not
  exist on disk
- **THEN** the daemon spawns with `--session-id <directIdeaUuid>`, creating the session
  under the deterministic id, with no persisted map write

#### Scenario: Build-vs-resume is decided by probing the transcript on disk

- **WHEN** the daemon must decide whether to start or resume a session for a direct idea
- **THEN** it checks for `<config-dir>/projects/<cwd-escaped>/<directIdeaUuid>.jsonl`,
  honoring `CLAUDE_CONFIG_DIR`, rather than consulting any persisted session map or
  relying on parsing a Claude error string

#### Scenario: Root idea is still reported but not used for anchoring

- **WHEN** a notification resolves with both a `directIdeaUuid` and a different
  `rootIdeaUuid`
- **THEN** the daemon anchors the session on `directIdeaUuid` and reports `rootIdeaUuid`
  in its execution snapshot, never the reverse

#### Scenario: Snapshot root is the resolved root, not the anchor key

- **WHEN** a notification resolves with `directIdeaUuid !== rootIdeaUuid` and the daemon
  builds an execution snapshot for it
- **THEN** the snapshot's `rootIdeaUuid` is the server-resolved root idea — not the
  direct idea that the serialization/anchor key carries — and is not obtained by parsing
  the anchor key

#### Scenario: The probe and the spawn use the same working directory

- **WHEN** the daemon probes for the transcript and then spawns the subprocess
- **THEN** both use the same explicit spawn working directory, so the new-vs-resume
  decision is made against the directory in which the session is (or will be) created

#### Scenario: Invalid session id is refused visibly, not spawned

- **WHEN** the resolved session id is not a well-formed UUID
- **THEN** the daemon logs the failure visibly and does not spawn a subprocess

#### Scenario: No direct idea still wakes, anchored on the entity's own uuid

- **WHEN** the resolution endpoint returns a `null` `directIdeaUuid` (e.g. a quick task
  with no proposal), is unreachable, returns a non-2xx status, or returns a malformed body
- **THEN** the daemon still spawns Claude, anchoring the session on the dispatched
  entity's own uuid and serializing under a per-entity key, without crashing and without
  dropping the wake

### Requirement: Cross-platform headless spawn

The daemon's subprocess spawning SHALL work on Linux, macOS, and Windows without relying on a shell. It SHALL resolve the real `claude` executable path (including the Windows `claude.cmd` shim) and spawn it directly without `shell:true`. It SHALL write the MCP configuration file to the OS temporary directory (`os.tmpdir()`), not a hardcoded path. It SHALL parse the subprocess's newline-delimited JSON output line by line, tolerating Windows `\r\n` line endings.

#### Scenario: Windows spawn resolves the .cmd shim without a shell

- **WHEN** the daemon runs on Windows where `claude` is installed as `claude.cmd`
- **THEN** it resolves and spawns the real `claude.cmd` path directly without `shell:true`, and the prompt is delivered over stdin

#### Scenario: Stream-json output parses across platforms

- **WHEN** the subprocess emits newline-delimited JSON with `\r\n` line endings on Windows
- **THEN** the daemon strips the trailing carriage return and parses each line as JSON without error

### Requirement: Reconnect with backfill

When the notification subscription drops, ends, errors, or delivers no bytes for 75 seconds, the daemon SHALL abort that stream, reconnect with its existing bounded backoff, fetch notifications that arrived while it was disconnected, and re-fire any wakes that were missed. Any non-empty byte chunk, including an SSE comment heartbeat or partial frame, SHALL refresh the 75-second deadline. Reconnect and explicit disconnect SHALL clear the prior connection's watchdog so an obsolete timer cannot affect a replacement stream.

#### Scenario: Missed dispatch is recovered on reconnect

- **WHEN** the subscription drops, a `task_assigned` notification is created during the gap, and the subscription then reconnects
- **THEN** the daemon backfills the unhandled notification and wakes Claude Code for it

#### Scenario: Silent stream triggers deterministic reconnect

- **GIVEN** an established notification stream that remains open at the API level
- **WHEN** no bytes arrive for 75 seconds
- **THEN** the daemon MUST abort that stream and enter the normal reconnect flow
- **AND** a successful reconnect MUST invoke notification backfill

#### Scenario: Heartbeat bytes refresh the watchdog

- **GIVEN** an established notification stream
- **WHEN** an SSE comment heartbeat arrives before the 75-second deadline
- **THEN** the daemon MUST refresh the deadline even though the comment is not forwarded as a notification

#### Scenario: Obsolete watchdog cannot abort a replacement stream

- **WHEN** a stream is replaced by reconnect or closed by explicit daemon shutdown
- **THEN** its watchdog MUST be cleared
- **AND** a later callback from that obsolete generation MUST NOT abort the current stream or schedule another reconnect

### Requirement: Reserved upload hooks for observability

The daemon SHALL define connection-register, session-register, and transcript-report hook points as no-op stubs in this change, so a future observability layer can report daemon connections, sessions, and live transcript messages to the server without modifying the wake path. This change SHALL NOT itself send connection, session, or transcript data to the server.

#### Scenario: Hooks exist as no-ops

- **WHEN** the daemon connects, starts a session, and receives subprocess transcript messages
- **THEN** the corresponding hook points are invoked but perform no server upload in this change

### Requirement: The daemon SHALL self-report client metadata when opening the notification stream

The chorus CLI daemon SHALL append self-report query parameters when it opens its
SSE subscription to `/api/events/notifications`. The appended parameters SHALL be
`clientType=claude_code`, `clientVersion` set to the chorus CLI package version,
`host` set to the machine hostname, and `startedAt` set to the daemon process
start time in ISO-8601. The `clientType` SHALL be `claude_code`
(not a generic `daemon`) because the CLI drives a local Claude Code subprocess.
This SHALL NOT change the authentication mechanism (the Bearer `cho_` API key
header is unchanged) and SHALL NOT alter the daemon's reconnect or backfill
behavior.

#### Scenario: The daemon appends self-report params on connect

- **WHEN** the chorus CLI daemon opens its notification SSE subscription
- **THEN** the request URL MUST include `clientType=claude_code` together with the
  CLI's `clientVersion`, the machine `host`, and the process `startedAt`
- **AND** the `Authorization: Bearer <cho_ key>` header MUST be sent exactly as before

#### Scenario: Reconnect re-sends the self-report params

- **GIVEN** the daemon's SSE subscription drops and the backoff reconnect fires
- **WHEN** the daemon re-opens the notification stream
- **THEN** the reconnect request URL MUST again include the same self-report query parameters

### Requirement: Per-direct-idea wake serialization

The daemon SHALL ensure that at most one wake runs at a time for any given
direct-idea session key (because each direct idea maps to a single deterministic
Claude session), while allowing wakes for different direct ideas to run concurrently. The serialization
key SHALL be the same value used for session anchoring (the `directIdeaUuid`, or the
per-entity fallback key when there is no direct idea). Wakes targeting the same direct
idea SHALL be queued and executed in arrival order, so the daemon never runs two
concurrent subprocesses that resume the same session. Enqueuing a wake SHALL NOT block
the notification subscription loop, and a failing wake SHALL NOT permanently block
subsequent wakes for the same direct idea.

#### Scenario: Two notifications for the same direct idea run sequentially

- **WHEN** two notifications that resolve to the same `directIdeaUuid` arrive in close
  succession
- **THEN** the daemon runs the first wake to completion before spawning the second, so
  no two concurrent subprocesses resume the same session id

#### Scenario: Notifications for different direct ideas run concurrently

- **WHEN** two notifications that resolve to different direct ideas arrive in close
  succession — including a parent idea and its child idea
- **THEN** the daemon may run both wakes concurrently, each on its own session

#### Scenario: A failed wake does not wedge the queue

- **WHEN** a queued wake for a direct idea fails or its subprocess errors
- **THEN** the failure is logged and the next queued wake for that same direct idea
  still proceeds

### Requirement: Server signal handlers confined to the server launch path

The CLI entry SHALL install the server's process-signal handlers — the `SIGINT` and
`SIGTERM` graceful-shutdown handler and the `exit` handler that force-kills an embedded
PGlite process — ONLY when invoked with no client subcommand (i.e. when launching the
Chorus server). When invoked as a client subcommand (`chorus daemon` or `chorus login`),
the entry SHALL NOT install any of these server signal handlers. Consequently a
`chorus daemon` process SHALL terminate on `SIGINT`/`SIGTERM` exclusively through the
daemon's own graceful shutdown path (which disconnects the SSE subscription and the MCP
client and logs `[Chorus] shutting down daemon...`), and SHALL NOT emit the server's bare
`Shutting down...` line. The registration of these handlers SHALL be encapsulated such that
the guard is verifiable in isolation, without spawning a process or delivering a real
fatal signal.

#### Scenario: Daemon subcommand does not install server signal handlers

- **WHEN** the CLI entry is evaluated for a client subcommand (`chorus daemon` or
  `chorus login`)
- **THEN** no server `SIGINT`, `SIGTERM`, or `exit` handler is registered, so only the
  daemon's own graceful shutdown handler is active

#### Scenario: Bare CLI still installs the server signal handlers

- **WHEN** the CLI entry is evaluated with no subcommand (launching the server)
- **THEN** the server's `SIGINT`, `SIGTERM`, and `exit` handlers are registered exactly as
  before, and the server shuts down via its existing path

#### Scenario: Daemon shuts down gracefully on SIGTERM

- **WHEN** a running `chorus daemon` process receives `SIGTERM`
- **THEN** the process shuts down through the daemon's graceful path — disconnecting the
  SSE subscription and the MCP client and logging `[Chorus] shutting down daemon...` — and
  does NOT print the server's bare `Shutting down...` line

### Requirement: The daemon SHALL warn and permanently skip a path-connection the server reports as conflicting

When the server reports a `connection_conflict` event for one of the daemon's path-connections (a live daemon already holds the same `(agent, host, cwd)`), the daemon SHALL print a prominent WARNING that names the `host` and `cwd` and states that a live daemon already serves that path, SHALL tear down that path-connection's SSE listener (clearing any pending reconnect), and SHALL NOT reconnect or re-probe that path for the remaining lifetime of the process. The `connection_conflict` event SHALL be consumed before the wake-routing path so it can never be mistaken for a notification and can never spawn a subprocess. Takeover of a conflicting path SHALL occur only on a subsequent daemon start or restart, never via in-process background re-probe.

#### Scenario: A conflicting path is warned and dropped without retry

- **GIVEN** a daemon path-connection for cwd C receives a `connection_conflict` event from the server
- **WHEN** the daemon handles the event
- **THEN** it MUST emit a WARNING naming the host and cwd C and the reason (a live daemon already serves it)
- **AND** it MUST stop that path's SSE listener and MUST NOT schedule a reconnect or re-probe for cwd C for the life of the process

#### Scenario: A conflict event never reaches the wake path

- **WHEN** a `connection_conflict` event arrives on a path-connection's stream
- **THEN** it MUST be handled by the conflict path and MUST NOT be dispatched to the event router / wake queue
- **AND** no Claude/Codex subprocess MUST be spawned as a result of the conflict event

### Requirement: A daemon serving multiple paths SHALL skip only the conflicting paths and keep serving the rest

When a daemon serves multiple cwds and only some of them conflict with a live daemon, the daemon process SHALL continue running and SHALL keep serving its non-conflicting path-connections normally; only the conflicting paths SHALL be skipped. Each path-connection is independent, so a skip of one cwd SHALL NOT disrupt task dispatch or the reverse-control channel of another cwd's connection.

#### Scenario: Partial conflict leaves non-conflicting paths serving

- **GIVEN** a daemon declared to serve cwds C1 and C2, where C1 conflicts with a live daemon and C2 does not
- **WHEN** the daemon starts and the server reports a conflict for C1
- **THEN** the daemon MUST warn and skip C1
- **AND** the daemon process MUST stay running and MUST continue serving C2 (its dispatch and control channel intact)

### Requirement: A daemon SHALL exit non-zero when every declared path conflicts

When every declared path-connection of the daemon ends in a conflict (none registers successfully), the daemon SHALL print a clear message that all declared paths are already served by a live daemon and there is nothing to do, and SHALL exit with a non-zero status rather than lingering as a process that serves no connection. The exit SHALL fire only after every declared path-connection has reached a terminal outcome (registered or conflicted), so a path still completing its handshake does not trigger a premature exit.

#### Scenario: All paths conflict — daemon exits non-zero

- **GIVEN** a daemon declared to serve only cwds that are each already served by a live daemon
- **WHEN** the server reports a conflict for every one of the daemon's path-connections
- **THEN** the daemon MUST print a clear "all N paths already served — nothing to do" message
- **AND** the process MUST exit with a non-zero status

#### Scenario: Exit waits for all paths to resolve

- **GIVEN** a daemon serving cwds C1 and C2 where C1 is reported conflicting before C2 has completed its handshake
- **WHEN** C1's conflict is handled
- **THEN** the daemon MUST NOT exit yet
- **AND** the all-conflict exit MUST be evaluated only once C2 has also reached a terminal outcome

### Requirement: Daemon graceful shutdown SHALL interrupt in-flight wakes and report their turn terminal state before exiting

On SIGINT/SIGTERM, the daemon SHALL stop accepting new wakes, interrupt every in-flight wake subprocess via the existing graceful kill escalation (SIGINT first, SIGKILL after the configured escalation window), and flush each interrupted wake's turn terminal report (`running → interrupted`, reason `shutdown`) to the server before the process exits. Shutdown SHALL be bounded — a wake that cannot be killed or reported within the escalation window plus a hard cap SHALL NOT hang the shutdown indefinitely; server-side offline reconcile remains the backstop for anything left behind. The waker's turn exit report SHALL be outcome-aware generally: a clean subprocess exit reports `ended`; a user-interrupted subprocess reports `interrupted(user)`; a shutdown-killed subprocess reports `interrupted(shutdown)`; a dirty exit with no interrupt requested reports `interrupted(crash)`.

During shutdown, the waker SHALL NOT report a `DaemonExecution` interrupt for the subprocesses it killed: a shutdown-kill is a dirty exit with no user-interrupt flag, which the unchanged crash path would record as the STICKY execution state `interrupted(crash)` — a state the execution offline-reconcile deliberately skips, so every graceful shutdown would strand crash-interrupted execution rows. Instead the execution row is left as-is and the existing execution offline-reconcile flips it `ended` when the connection drops. Outside shutdown, `DaemonExecution` reporting semantics (sticky user-interrupt resumability, crash reporting, offline reconcile) SHALL be unchanged.

#### Scenario: Ctrl-C mid-turn leaves no orphan running turn

- **GIVEN** a daemon with one wake subprocess running (its turn is `running`)
- **WHEN** the daemon receives SIGINT and completes shutdown
- **THEN** the subprocess MUST have been killed via the graceful escalation
- **AND** the turn MUST have been reported `interrupted` with reason `shutdown` before the daemon process exits

#### Scenario: Clean exits still report ended

- **GIVEN** a wake subprocess that exits with code 0 during normal operation
- **WHEN** the waker reports the turn's exit
- **THEN** the report MUST be `running → ended` (unchanged behavior)

#### Scenario: A crashed subprocess reports an interrupted turn

- **GIVEN** a wake subprocess that exits non-zero with no interrupt requested and no shutdown in progress
- **WHEN** the waker reports the turn's exit
- **THEN** the report MUST be `running → interrupted` with reason `crash`

#### Scenario: Shutdown does not strand a sticky crash-interrupted execution row

- **GIVEN** a wake subprocess killed by the shutdown escalation (dirty exit, no user interrupt)
- **WHEN** the waker handles the exit during shutdown
- **THEN** it MUST NOT report the execution as `interrupted(crash)`
- **AND** the execution row MUST be left for the existing offline reconcile to flip `ended` when the connection drops

#### Scenario: Shutdown does not hang on an unkillable wake

- **GIVEN** a wake subprocess that survives the kill escalation
- **WHEN** the shutdown's hard cap elapses
- **THEN** the daemon MUST exit anyway
- **AND** the orphaned turn is left to server-side offline reconcile

### Requirement: Daemon acknowledges notification heartbeat receipt

The daemon SHALL advertise `livenessAck=v1` when opening its SSE subscription. After the handshake identifies the registered connection generation, the daemon SHALL send a best-effort authenticated liveness acknowledgment after receiving each `: heartbeat` comment. The acknowledgment SHALL identify both the connection UUID and registration generation, SHALL NOT be forwarded into the notification or wake pipeline, and SHALL NOT be retried by the generic daemon REST client.

#### Scenario: Upgraded daemon opts into acknowledgment liveness

- **WHEN** an upgraded daemon opens or reopens its notification subscription
- **THEN** the request URL MUST include `livenessAck=v1`
- **AND** all existing self-report and authentication fields MUST remain unchanged

#### Scenario: Received heartbeat is acknowledged but not routed

- **GIVEN** a daemon has received a valid connection registration handshake
- **WHEN** it receives an SSE heartbeat comment
- **THEN** it MUST send one liveness acknowledgment for that connection generation
- **AND** it MUST NOT pass the heartbeat to `onEvent` or create a wake

#### Scenario: Failed acknowledgment does not crash the listener

- **WHEN** a liveness acknowledgment fails because the network or server is unavailable
- **THEN** the listener MUST remain non-throwing and log the failure
- **AND** the failed acknowledgment MUST NOT advance server-side liveness

