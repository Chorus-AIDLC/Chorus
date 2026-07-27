# daemon-codex-backend Specification

## Purpose
TBD - created by archiving change add-daemon-codex-backend. Update Purpose after archive.
## Requirements
### Requirement: Headless Codex wake over `codex exec --json`

When the resolved backend is `codex`, the daemon SHALL wake the local Codex by spawning `codex exec --json` as a headless subprocess, feeding the wake prompt over **stdin** (never as a command-line argument), and parsing the JSONL event stream from stdout. The spawned child SHALL carry `CHORUS_DAEMON_HEADLESS=1` in its environment, matching the Claude backend's headless signal. The spawner SHALL resolve the `codex` executable without a shell (PATH walk for the platform's candidate names, a `.cmd`/`.bat` shim run via `cmd.exe` on Windows), honoring a `CHORUS_CODEX_PATH` override when set, and SHALL refuse to spawn with a visible log if it cannot locate the executable.

#### Scenario: New wake spawns codex exec with the prompt on stdin

- **WHEN** the daemon wakes the codex backend for an anchor that has no recorded Codex thread id
- **THEN** it spawns `codex exec --json` (plus the resolved sandbox flag) with the prompt written to stdin, and no part of the prompt appears in the process arguments

#### Scenario: Missing codex executable fails visibly without crashing

- **WHEN** no `codex` executable can be resolved on PATH and `CHORUS_CODEX_PATH` is unset or invalid
- **THEN** the wake resolves without spawning, emits a visible error log, and the daemon keeps running

### Requirement: Codex session anchoring via a persisted idea→thread-id map

Because Codex generates its own `thread_id` rather than accepting a client-supplied session id, the daemon SHALL capture the generated `thread_id` from the Codex event stream and SHALL persist a mapping from the Chorus session anchor (the direct idea uuid, or the entity uuid for an ad-hoc session) to that `thread_id` in a daemon-local store. For a fresh run, the daemon SHALL persist the mapping immediately after the first valid generated thread identifier is observed, without waiting for the turn or process to exit successfully. Repeated identifier events within the same wake SHALL result in exactly one persistence call. On a subsequent wake for the same anchor, the daemon SHALL resume the existing Codex session via `codex exec resume <thread_id>`; when no mapping exists for the anchor, it SHALL start a fresh `codex exec` run. The new-vs-resume decision for the Codex backend SHALL be made from this map (not from the Claude on-disk transcript probe), and lifecycle logs SHALL NOT report a contradictory Claude-probe decision as the Codex command state. The persistence SHALL be best-effort: a read/write failure SHALL degrade to starting a fresh session with a visible log, never throwing into the wake path.

#### Scenario: Same anchor resumes the same Codex thread

- **WHEN** a wake fires for an anchor whose `thread_id` was recorded by a prior Codex run
- **THEN** the daemon runs `codex exec resume <thread_id>` so the conversation continues, rather than starting a new session

#### Scenario: First wake for an anchor starts fresh and records the thread id

- **WHEN** a wake fires for an anchor with no recorded `thread_id`
- **THEN** the daemon starts a new `codex exec` run, captures the first valid generated `thread_id` from the stream, and immediately persists the anchor-to-thread-id mapping for future resumes

#### Scenario: Interrupted first turn remains resumable

- **WHEN** a fresh Codex wake emits a valid `thread_id` and is then interrupted before a successful process exit
- **THEN** the mapping MUST already contain that `thread_id`
- **AND** the next wake for the same anchor MUST invoke `codex exec resume <thread_id>` instead of starting a fresh thread

#### Scenario: Failure before thread establishment does not create a mapping

- **WHEN** a fresh Codex process fails or exits before emitting a valid generated thread identifier
- **THEN** the daemon MUST NOT persist an inferred, blank, or anchor-derived thread identifier

#### Scenario: Duplicate identifier events are idempotent

- **WHEN** a fresh Codex wake emits the same valid generated thread identifier more than once
- **THEN** the daemon MUST invoke mapping persistence exactly once for that wake
- **AND** the persisted mapping MUST equal the emitted identifier

#### Scenario: Codex lifecycle state reflects the map-based decision

- **WHEN** the Claude transcript probe and the Codex thread map would produce different new-vs-resume answers
- **THEN** the Codex command MUST follow the thread map
- **AND** daemon lifecycle logs MUST NOT claim that the contradictory Claude-probe answer was used

### Requirement: Permission mode maps to a Codex sandbox posture, defaulting to YOLO

The daemon's backend-agnostic permission mode SHALL map to a Codex sandbox posture: `yolo` SHALL run `codex exec` with `--dangerously-bypass-approvals-and-sandbox` (full autonomy for code-writing work), and the restricted `chorus` posture SHALL run with `--sandbox read-only` (MCP tool calls permitted; no shell execution or file writes). Consistent with the daemon's existing default, an unconfigured daemon SHALL wake Codex in `yolo`.

#### Scenario: Default codex wake runs with full-autonomy sandbox bypass

- **WHEN** the daemon wakes the codex backend with no permission flags overriding the default
- **THEN** the `codex exec` invocation includes `--dangerously-bypass-approvals-and-sandbox`

#### Scenario: Restricted posture runs codex read-only

- **WHEN** the daemon is run in the restricted `chorus` posture and wakes the codex backend
- **THEN** the `codex exec` invocation includes `--sandbox read-only` so the woken Codex can call MCP tools but cannot run shell commands or write files

### Requirement: Codex MCP comes from the user config with the daemon key via env

The daemon SHALL NOT synthesize a Codex MCP configuration. It SHALL rely on the user's existing `~/.codex/config.toml` to declare the Chorus MCP server (`[mcp_servers.chorus]`). To make the woken Codex authenticate as the daemon's own agent and allow startup hooks to inspect the same resolved connection context, the spawner SHALL export both the daemon's resolved Chorus URL as `CHORUS_URL` and its resolved API key as `CHORUS_API_KEY` into the child process environment. The API key SHALL be passed through the environment and SHALL NOT appear in process arguments or logs. When the complete context is present and Chorus is reachable, the SessionStart hook SHALL complete check-in without emitting a not-configured warning. When configuration is genuinely incomplete or check-in fails, the existing generic warning SHALL remain visible. Equivalent Chorus configuration warnings SHALL appear at most once during one headless startup, while an independent later startup SHALL be able to emit its own warning. When the user's config declares no Chorus MCP server, the woken Codex SHALL still run (without Chorus tools), and the daemon SHALL log this rather than fail.

#### Scenario: Complete daemon connection context reaches the Codex child

- **WHEN** the daemon has resolved a Chorus URL and API key and wakes the Codex backend
- **THEN** the spawned Codex receives the resolved values as `CHORUS_URL` and `CHORUS_API_KEY`
- **AND** the API key does not appear in process arguments or logs

#### Scenario: Configured and reachable Chorus does not produce a false warning

- **WHEN** a Codex headless child receives the complete daemon connection context and Chorus check-in succeeds
- **THEN** the SessionStart hook MUST NOT report that the Chorus environment is unconfigured
- **AND** Chorus MCP remains available through the user's Codex configuration

#### Scenario: Genuine missing configuration retains the generic warning

- **WHEN** the SessionStart hook runs without a complete Chorus URL and API key pair
- **THEN** it emits the existing generic not-configured warning
- **AND** it exits without attempting an authenticated check-in

#### Scenario: Genuine connection failure retains the generic warning

- **WHEN** the SessionStart hook receives complete configuration but Chorus check-in fails
- **THEN** it emits the existing generic connection-failure warning

#### Scenario: Equivalent startup warning is emitted once

- **WHEN** the same Chorus configuration warning is triggered more than once during one Codex headless startup
- **THEN** the user-visible warning appears at most once
- **AND** an independent later startup can emit the warning again if the failure still exists

#### Scenario: No Chorus MCP configured still runs

- **WHEN** the user's Codex config declares no Chorus MCP server
- **THEN** the wake still spawns and completes, the woken Codex simply lacks Chorus tools, and the daemon logs the absence instead of crashing

### Requirement: Codex interrupt via detached process-group kill

The Codex backend SHALL spawn its subprocess in a detached POSIX process group (so it leads its own group and a group-directed signal reaches the child shells `codex exec` forks for tool calls), and the daemon's existing two-stage process-tree killer (graceful SIGINT, then forceful SIGKILL of the group after a timeout; `taskkill /T /F` on Windows) SHALL be reused unchanged to interrupt a running Codex wake. After an interrupt, a subsequent wake for the same anchor SHALL resume the recorded Codex `thread_id` whenever a valid identifier was emitted before the interrupt, including when the interrupted turn was the first turn for that anchor.

#### Scenario: Interrupting a running Codex wake stops its process tree

- **WHEN** an authorized interrupt is verified for a running Codex wake
- **THEN** the daemon group-signals the detached Codex process so the Codex process and the child shells it spawned are stopped, escalating to a forceful kill if it does not exit within the timeout

#### Scenario: Re-wake after interrupt resumes when a thread id was captured

- **WHEN** a Codex wake, including a first wake for its anchor, was interrupted after a valid `thread_id` had been emitted and a new wake fires for the same anchor
- **THEN** the daemon resumes that `thread_id` via `codex exec resume` rather than starting a fresh session

#### Scenario: Repeated interrupt of an existing thread preserves continuity

- **WHEN** a wake resumes an already-mapped Codex thread, that resumed wake is interrupted, and another wake fires for the same anchor
- **THEN** the daemon MUST retain the existing mapping
- **AND** the later wake MUST again invoke `codex exec resume` with the same `thread_id`

