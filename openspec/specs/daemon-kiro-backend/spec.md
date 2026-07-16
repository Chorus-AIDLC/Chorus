# daemon-kiro-backend Specification

## Purpose
TBD - created by archiving change add-daemon-kiro-backend. Update Purpose after archive.
## Requirements
### Requirement: Headless Kiro wake over `kiro-cli chat --no-interactive`

When the resolved backend is `kiro`, the daemon SHALL wake the local Kiro CLI by spawning `kiro-cli chat --no-interactive` as a headless subprocess, feeding the wake prompt over **stdin** (never as a command-line argument), and running under the `chorus` agent profile (`--agent chorus`) so the woken session loads the Kiro plugin's Chorus MCP server, AI-DLC skills, and steering. The spawned child SHALL carry `CHORUS_DAEMON_HEADLESS=1` in its environment, matching the other backends' headless signal, and SHALL target the default v2 engine (it SHALL NOT pass `--v3`). The spawner SHALL resolve the `kiro-cli` executable without a shell (PATH walk for the platform's candidate names, a `.cmd`/`.bat` shim run via `cmd.exe` on Windows), honoring a `CHORUS_KIRO_PATH` override when set, and SHALL refuse to spawn with a visible log if it cannot locate the executable.

#### Scenario: New wake spawns kiro-cli chat with the prompt on stdin

- **WHEN** the daemon wakes the kiro backend for an anchor that has no recorded Kiro session id
- **THEN** it spawns `kiro-cli chat --no-interactive --agent chorus` (plus the resolved trust flags) with the prompt written to stdin, and no part of the prompt appears in the process arguments

#### Scenario: Missing kiro-cli executable fails visibly without crashing

- **WHEN** no `kiro-cli` executable can be resolved on PATH and `CHORUS_KIRO_PATH` is unset or invalid
- **THEN** the wake resolves without spawning, emits a visible error log, and the daemon keeps running

### Requirement: Kiro session anchoring via a persisted idea→session-id map

Because Kiro generates its own conversation `sessionId` per cwd rather than accepting a client-supplied session id, the daemon SHALL capture the generated `sessionId` for a run and SHALL persist a mapping from the Chorus session anchor (the direct idea uuid, or the entity uuid for an ad-hoc session) to that `sessionId` in a daemon-local store. On a subsequent wake for the same anchor, the daemon SHALL resume the existing Kiro conversation via `kiro-cli chat --no-interactive --resume-id <sessionId>`; when no mapping exists for the anchor, it SHALL start a fresh run. The new-vs-resume decision for the Kiro backend SHALL be made from this map, not from Kiro's most-recent-per-cwd `--resume` (which would cross-contaminate ideas sharing the daemon's single repo cwd) and not from the Claude on-disk transcript probe. The persistence SHALL be best-effort: a read/write failure SHALL degrade to starting a fresh session with a visible log, never throwing into the wake path.

#### Scenario: Same anchor resumes the same Kiro session

- **WHEN** a wake fires for an anchor whose `sessionId` was recorded by a prior successful Kiro run
- **THEN** the daemon runs `kiro-cli chat --no-interactive --resume-id <sessionId>` so the conversation continues, rather than starting a new session

#### Scenario: First wake for an anchor starts fresh and records the session id

- **WHEN** a wake fires for an anchor with no recorded `sessionId`
- **THEN** the daemon starts a fresh Kiro run, captures the generated `sessionId` after the run, and persists the anchor→session-id mapping for future resumes

### Requirement: Permission mode maps to a Kiro tool-trust posture, defaulting to YOLO

The daemon's backend-agnostic permission mode SHALL map to a Kiro tool-trust posture so a headless turn never blocks on an approval prompt: `yolo` SHALL run with `--trust-all-tools` (full autonomy for code-writing work), and the restricted `chorus` posture SHALL run with a scoped `--trust-tools=` set granting read-only filesystem access plus the Chorus MCP tools (no shell execution or file writes). Consistent with the daemon's existing default, an unconfigured daemon SHALL wake Kiro in `yolo`.

#### Scenario: Default kiro wake trusts all tools

- **WHEN** the daemon wakes the kiro backend with no permission flags overriding the default
- **THEN** the `kiro-cli chat` invocation includes `--trust-all-tools`

#### Scenario: Restricted posture trusts only a read-ish scoped set

- **WHEN** the daemon is run in the restricted `chorus` posture and wakes the kiro backend
- **THEN** the `kiro-cli chat` invocation includes a scoped `--trust-tools=` set (read-only filesystem plus the Chorus MCP tools) so the woken Kiro can call Chorus tools but cannot run shell commands or write files

### Requirement: Kiro MCP comes from the plugin config with the daemon key via env

The daemon SHALL NOT synthesize a Kiro MCP configuration. It SHALL rely on the Kiro plugin's `.kiro/settings/mcp.json` (loaded via `--agent chorus`) to declare the Chorus MCP server. To make the woken Kiro authenticate as the daemon's own agent, the spawner SHALL export the daemon's resolved API key into the child process environment as `CHORUS_API_KEY` (the variable the plugin's MCP config references via `${env:CHORUS_API_KEY}`); the key SHALL be passed through the environment and SHALL NOT appear in the process arguments. When no Chorus MCP server is configured, the woken Kiro SHALL still run (without Chorus tools), and the daemon SHALL log this rather than fail. Because headless MCP loading requires a Node.js runtime present in the workspace, the daemon SHALL document node ≥ 22 as a prerequisite for the kiro backend.

#### Scenario: Daemon key reaches the plugin-configured Chorus MCP server via env

- **WHEN** the Kiro plugin's `.kiro/settings/mcp.json` declares the `chorus` server with an `Authorization: Bearer ${env:CHORUS_API_KEY}` header and the daemon wakes the kiro backend
- **THEN** the spawned Kiro receives the daemon's resolved API key in its `CHORUS_API_KEY` environment variable (never in argv), so its Chorus MCP calls authenticate as the daemon's agent

#### Scenario: No Chorus MCP configured still runs

- **WHEN** no Chorus MCP server is configured for the woken Kiro
- **THEN** the wake still spawns and completes, the woken Kiro simply lacks Chorus tools, and the daemon logs the absence instead of crashing

### Requirement: Kiro transcript reconstructed from the session store with a plain-text fallback

Because `kiro-cli chat --no-interactive` emits no structured per-message stream (its `--format json` applies only to list commands), the daemon SHALL capture the transcript by reading Kiro's on-disk session store for the run's `sessionId` after the turn completes: it SHALL convert each stored message entry (per-message JSONL keyed by a message kind such as prompt / assistant message, with the body under a content field) into a structured transcript entry and feed it to the existing transcript-upload path. When a woken Kiro session spawns child sessions (e.g. reviewer subagents, identified by a parent-session reference in the store), the reconstruction SHALL include those child sessions' messages. If the session store cannot be parsed reliably, the daemon SHALL fall back to capturing the run's raw stdout as a single plain-text transcript entry per turn. Transcript capture SHALL be best-effort and SHALL NOT block or fail the wake.

#### Scenario: Structured entries reconstructed from the session store

- **WHEN** a Kiro wake completes and its session store file for the run's `sessionId` is present and parseable
- **THEN** the daemon converts the stored per-message entries into structured transcript entries (including any child subagent sessions) and uploads them

#### Scenario: Unparseable store degrades to a plain-text blob

- **WHEN** the session store for the run cannot be located or parsed
- **THEN** the daemon uploads the run's raw stdout as a single plain-text transcript entry and logs the degrade, without failing the wake

### Requirement: Kiro interrupt via detached process-group kill

The Kiro backend SHALL spawn its subprocess in a detached POSIX process group (so it leads its own group and a group-directed signal reaches any child shells Kiro forks for tool calls), and the daemon's existing two-stage process-tree killer (graceful SIGINT, then forceful SIGKILL of the group after a timeout; `taskkill /T /F` on Windows) SHALL be reused unchanged to interrupt a running Kiro wake. After an interrupt, a subsequent wake for the same anchor SHALL resume the recorded Kiro `sessionId` when one was captured before the interrupt.

#### Scenario: Interrupting a running Kiro wake stops its process tree

- **WHEN** an authorized interrupt is verified for a running Kiro wake
- **THEN** the daemon group-signals the detached Kiro process so the Kiro process and the child shells it spawned are stopped, escalating to a forceful kill if it does not exit within the timeout

#### Scenario: Re-wake after interrupt resumes when a session id was captured

- **WHEN** a Kiro wake was interrupted after its `sessionId` had been captured and persisted, and a new wake fires for the same anchor
- **THEN** the daemon resumes that `sessionId` via `kiro-cli chat --no-interactive --resume-id` rather than starting a fresh session

