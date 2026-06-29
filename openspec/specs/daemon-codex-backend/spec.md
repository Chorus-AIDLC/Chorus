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

Because Codex generates its own `thread_id` rather than accepting a client-supplied session id, the daemon SHALL capture the generated `thread_id` from the Codex event stream and SHALL persist a mapping from the Chorus session anchor (the direct idea uuid, or the entity uuid for an ad-hoc session) to that `thread_id` in a daemon-local store. On a subsequent wake for the same anchor, the daemon SHALL resume the existing Codex session via `codex exec resume <thread_id>`; when no mapping exists for the anchor, it SHALL start a fresh `codex exec` run. The new-vs-resume decision for the Codex backend SHALL be made from this map (not from the Claude on-disk transcript probe). The persistence SHALL be best-effort: a read/write failure SHALL degrade to starting a fresh session with a visible log, never throwing into the wake path.

#### Scenario: Same anchor resumes the same Codex thread

- **WHEN** a wake fires for an anchor whose `thread_id` was recorded by a prior successful Codex run
- **THEN** the daemon runs `codex exec resume <thread_id>` so the conversation continues, rather than starting a new session

#### Scenario: First wake for an anchor starts fresh and records the thread id

- **WHEN** a wake fires for an anchor with no recorded `thread_id`
- **THEN** the daemon starts a new `codex exec` run, captures the generated `thread_id` from the stream, and persists the anchor→thread-id mapping for future resumes

### Requirement: Permission mode maps to a Codex sandbox posture, defaulting to YOLO

The daemon's backend-agnostic permission mode SHALL map to a Codex sandbox posture: `yolo` SHALL run `codex exec` with `--dangerously-bypass-approvals-and-sandbox` (full autonomy for code-writing work), and the restricted `chorus` posture SHALL run with `--sandbox read-only` (MCP tool calls permitted; no shell execution or file writes). Consistent with the daemon's existing default, an unconfigured daemon SHALL wake Codex in `yolo`.

#### Scenario: Default codex wake runs with full-autonomy sandbox bypass

- **WHEN** the daemon wakes the codex backend with no permission flags overriding the default
- **THEN** the `codex exec` invocation includes `--dangerously-bypass-approvals-and-sandbox`

#### Scenario: Restricted posture runs codex read-only

- **WHEN** the daemon is run in the restricted `chorus` posture and wakes the codex backend
- **THEN** the `codex exec` invocation includes `--sandbox read-only` so the woken Codex can call MCP tools but cannot run shell commands or write files

### Requirement: Codex MCP comes from the user config with the daemon key via env

The daemon SHALL NOT synthesize a Codex MCP configuration. It SHALL rely on the user's existing `~/.codex/config.toml` to declare the Chorus MCP server (`[mcp_servers.chorus]`). To make the woken Codex authenticate as the daemon's own agent, the spawner SHALL export the daemon's resolved API key into the child process environment under the variable the user's config references via `bearer_token_env_var` (default `CHORUS_API_KEY`); the key SHALL be passed through the environment and SHALL NOT appear in the process arguments. When the user's config declares no Chorus MCP server, the woken Codex SHALL still run (without Chorus tools), and the daemon SHALL log this rather than fail.

#### Scenario: Daemon key reaches the user-configured Chorus MCP server via env

- **WHEN** the user's `~/.codex/config.toml` declares `[mcp_servers.chorus]` with `bearer_token_env_var = "CHORUS_API_KEY"` and the daemon wakes the codex backend
- **THEN** the spawned Codex receives the daemon's resolved API key in its `CHORUS_API_KEY` environment variable (never in argv), so its Chorus MCP calls authenticate as the daemon's agent

#### Scenario: No Chorus MCP configured still runs

- **WHEN** the user's Codex config declares no Chorus MCP server
- **THEN** the wake still spawns and completes, the woken Codex simply lacks Chorus tools, and the daemon logs the absence instead of crashing

### Requirement: Codex interrupt via detached process-group kill

The Codex backend SHALL spawn its subprocess in a detached POSIX process group (so it leads its own group and a group-directed signal reaches the child shells `codex exec` forks for tool calls), and the daemon's existing two-stage process-tree killer (graceful SIGINT, then forceful SIGKILL of the group after a timeout; `taskkill /T /F` on Windows) SHALL be reused unchanged to interrupt a running Codex wake. After an interrupt, a subsequent wake for the same anchor SHALL resume the recorded Codex `thread_id` when one was captured before the interrupt.

#### Scenario: Interrupting a running Codex wake stops its process tree

- **WHEN** an authorized interrupt is verified for a running Codex wake
- **THEN** the daemon group-signals the detached Codex process so the Codex process and the child shells it spawned are stopped, escalating to a forceful kill if it does not exit within the timeout

#### Scenario: Re-wake after interrupt resumes when a thread id was captured

- **WHEN** a Codex wake was interrupted after its `thread_id` had been captured and persisted, and a new wake fires for the same anchor
- **THEN** the daemon resumes that `thread_id` via `codex exec resume` rather than starting a fresh session

