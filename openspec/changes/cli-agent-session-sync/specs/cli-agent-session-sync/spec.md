## ADDED Requirements

### Requirement: Foreground launch registers a Chorus session by default
`chorus agents run` SHALL register the launched conversation as a `DaemonSession` owned by the selected agent before spawning the agent binary, unless `--no-sync` is passed. The session SHALL be ad-hoc (`directIdeaUuid = null`) by default, or anchored to the Idea given by `--idea <uuid>`. The session SHALL record the launching host and absolute cwd. With `--no-sync`, the command SHALL make no Chorus session calls and behave exactly as before this change. Registration failure SHALL NOT prevent the agent from launching.

#### Scenario: Default launch registers an ad-hoc session
- **WHEN** a user runs `chorus agents run <agent>` without sync flags and the server is reachable
- **THEN** a new ad-hoc DaemonSession for that agent with the current host and cwd exists before the agent process starts, and the agent launches normally

#### Scenario: Launch anchored to an Idea
- **WHEN** a user runs `chorus agents run <agent> --idea <ideaUuid>` for an Idea the agent can see
- **THEN** the registered session is grouped under that Idea in the Chorus chat UI

#### Scenario: Opt-out keeps legacy behavior
- **WHEN** a user runs `chorus agents run <agent> --no-sync`
- **THEN** no session is registered, no transcript is uploaded, and argument passthrough, TTY inheritance and exit-code forwarding are unchanged

#### Scenario: Server unreachable
- **WHEN** session registration fails (network error, 5xx, auth error)
- **THEN** the CLI prints one warning naming the failure (never the API key) and launches the agent unsynced

### Requirement: The backend resume identity is captured for every resumable backend
For each backend the daemon can resume (Claude Code, Codex, Kiro, Pi, Trae), the CLI SHALL establish the backend session id of the foreground conversation and report it as the session's `backendSessionId`. The established identity SHALL be exactly the identity the daemon uses on its next wake for that session. For backends that accept a caller-supplied id (Claude Code, Pi) the CLI SHALL pass the daemon-derived key for the registered session unless the user already passed a session/resume flag after `--`, in which case the session SHALL be registered as not continuable. For backends that generate their own id (Codex, Trae, Kiro) the CLI SHALL discover it from the backend's on-disk session store, restricted to sessions created in the launch cwd after launch time, and record it where and how the daemon's resume path looks it up, including the ownership metadata that path verifies. If the id cannot be established, the session SHALL be marked not continuable and the UI SHALL say so.

#### Scenario: Claude session id matches the daemon's derived key
- **WHEN** a Claude Code agent is launched with sync enabled and no user session/resume argument
- **THEN** the child is started with `--session-id` equal to the key the daemon derives for that session, and a later daemon wake for the session resumes the same conversation

#### Scenario: User supplies their own resume flag
- **WHEN** the user passes a session or resume flag after `--`
- **THEN** the CLI does not inject a session id, the session is registered as not continuable, and the transcript still syncs

#### Scenario: Self-generated id is discovered
- **WHEN** a Codex/Trae/Kiro agent is launched with sync and its session store gains a new session for the launch cwd
- **THEN** that session's id is reported as backendSessionId and recorded in the daemon's backend session map with ownership the daemon accepts, so a later daemon wake resumes it rather than starting a new conversation

#### Scenario: Id cannot be established
- **WHEN** no matching backend session is found by CLI exit
- **THEN** the session is marked not continuable and the Chorus composer explains why instead of offering Send

### Requirement: Transcript sync is live where possible and degrades to upload-on-exit
The CLI SHALL upload user/assistant transcript text of the foreground conversation through the existing transcript ingest contract (tool calls, tool results, thinking and harness-injected synthetic content excluded). Backends with a tail-able on-disk transcript SHALL be synced live while the CLI runs. Backends without one SHALL upload once at CLI exit, reconstructed from the backend session store. Sync SHALL be best-effort and SHALL NEVER write to the agent's TTY except a single summary line on exit-time failure.

#### Scenario: Live sync
- **WHEN** a live-capable backend exchanges messages in the terminal
- **THEN** a viewer of the session in Chorus sees the new messages within a few seconds without reloading

#### Scenario: Degraded backend
- **WHEN** a backend not capable of live sync exits normally
- **THEN** its conversation transcript is uploaded once and appears in Chorus

#### Scenario: Upload failure does not affect the agent
- **WHEN** transcript uploads fail repeatedly during a run
- **THEN** the agent session continues uninterrupted and the CLI's exit code is still the child's exit code

### Requirement: A CLI lease holds the session and queues Chorus instructions
While a synced CLI run is alive, the session SHALL carry a server-side CLI lease renewed by heartbeat. A human instruction sent to a leased session SHALL be accepted and stored as a pending turn but SHALL NOT be delivered to any daemon connection. A lease not renewed within its TTL SHALL be treated as released, and the expiry SHALL be acted on without requiring the CLI or the daemon connection to change state. The CLI's own running turn SHALL NOT be interrupted, finalized or merged by daemon reconnect, stream-drop or orphan-reconciliation handling.

#### Scenario: Send while CLI is running
- **WHEN** a user sends an instruction from Chorus to a session whose CLI lease is live
- **THEN** the send succeeds, the turn stays pending, no wake is emitted, and the UI shows it as queued behind the terminal session

#### Scenario: Crash releases the lease
- **WHEN** the CLI process is killed without releasing the lease while the origin daemon stays connected
- **THEN** within the TTL plus one daemon heartbeat interval the lease is treated as released and queued instructions are delivered

#### Scenario: Daemon restart during a CLI run
- **WHEN** the origin daemon reconnects while a synced CLI run is still live
- **THEN** the CLI turn stays running, the lease is unaffected, and queued instructions remain pending

### Requirement: Releasing the lease immediately resumes queued instructions
When the CLI lease is released (clean exit) or expires, the server SHALL immediately deliver the session's pending turns to its origin daemon connection, which SHALL resume the same backend conversation, using the resume identity established at launch, in the recorded cwd.

#### Scenario: Auto-resume after exit
- **WHEN** a user exits the terminal agent while one queued instruction exists and the matching daemon connection is online
- **THEN** the daemon resumes the same backend conversation, runs the instruction, and the reply appears in the Chorus transcript

#### Scenario: No queued work
- **WHEN** the lease is released with no pending turns
- **THEN** nothing is woken and the session remains active and continuable from Chorus

### Requirement: Sessions launched without a running daemon bind later
A daemon connection serves the launch cwd if its own cwd equals it or the cwd is one of its discovered working directories. If no daemon connection for the agent + host serves the launch cwd at launch, the CLI SHALL print a warning that the session can be continued once a daemon is running there, and SHALL still launch and register the session. The server SHALL bind the session's origin connection when a matching daemon connection comes online, and only then allow continuation; pending turns SHALL be delivered at that point if the lease is released.

#### Scenario: Daemon starts later
- **WHEN** a session was registered with no daemon, the CLI has exited, and later a daemon for the same agent, host and cwd connects
- **THEN** the session binds to that connection and Send becomes available in Chorus

#### Scenario: Daemon serves the cwd as a discovered directory
- **WHEN** the launch cwd is a discovered working directory of a running daemon whose own cwd differs
- **THEN** the session binds to that daemon with the launch cwd as its runtime cwd

#### Scenario: Send before binding
- **WHEN** a user views an unbound session
- **THEN** the composer explains that no daemon is running on the origin machine and directory, and Send is disabled
