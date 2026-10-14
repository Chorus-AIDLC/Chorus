# daemon-trae-backend Specification

## Purpose
TBD - created by archiving change add-trae-cli-backend. Update Purpose after archive.

## Requirements

### Requirement: TRAE wakes reuse the Codex App Server backend through a Codex-family profile

The daemon SHALL implement the `trae` backend with the same App Server spawner as the `codex` backend, parameterized by a Codex-family profile rather than a copied implementation. The profile SHALL supply at least: the executable name(s) and path-override environment variable (`traecli`, `CHORUS_TRAE_PATH`), the home directory and its override variable (`~/.trae`, `TRAE_HOME`), the config file name (`traecli.toml`), a display name used in logs and errors (`TRAE CLI`), the wake-error source, and the session-map namespace. The `codex` profile SHALL resolve to exactly the current Codex values, so Codex behavior is unchanged. The `trae` backend SHALL inherit every behavior of the `daemon-codex-backend` capability — session anchoring, permission-mode posture, MCP from user config with env-passed credentials, bounded stdio lifecycle, non-blocking native human requests, transcript delivery, token usage, and protocol-then-process-tree cancellation — with Codex-specific paths, names and messages replaced by the TRAE profile values.

#### Scenario: trae wake spawns the TRAE App Server over stdio

- **WHEN** the daemon wakes an agent whose resolved type is `trae`
- **THEN** it spawns the resolved `traecli` executable with `app-server --listen stdio://` and no shell
- **AND** it performs the same `initialize` / `initialized` / `thread/start` or `thread/resume` / `turn/start` sequence as the Codex backend

#### Scenario: Codex behavior is unchanged by parameterization

- **WHEN** the daemon wakes an agent whose resolved type is `codex`
- **THEN** the spawned binary, config path, env overrides, session map, logs and error text are identical to the behavior before this change

#### Scenario: Executable override and missing binary

- **WHEN** `CHORUS_TRAE_PATH` points to an existing file
- **THEN** the daemon spawns that file instead of searching `PATH`
- **AND** when no `traecli` executable can be found, the wake fails with a TRAE-branded, actionable error and the daemon keeps running

### Requirement: TRAE sessions are anchored separately from Codex sessions

The daemon SHALL persist the idea/task → TRAE thread-id mapping in a store that is separate from the Codex map, so a Codex thread id is never resumed by `traecli` and vice versa. A later wake for the same anchor SHALL resume the stored TRAE thread with `thread/resume`. When TRAE reports that the stored history is unavailable, the daemon SHALL start a new thread and show the same continue-in-new-thread notice as Codex, with TRAE wording.

#### Scenario: Same anchor resumes its TRAE thread

- **WHEN** an idea is woken twice on the `trae` backend
- **THEN** the second wake sends `thread/resume` with the thread id recorded by the first wake

#### Scenario: Codex and TRAE maps do not collide

- **WHEN** the same anchor has a stored Codex thread id and is then woken on the `trae` backend
- **THEN** the TRAE wake does not try to resume the Codex thread id

### Requirement: TRAE permission posture follows the daemon permission mode

The `trae` backend SHALL map the daemon's resolved permission mode to App Server sandbox and approval fields exactly as the Codex backend does: yolo → full-access sandbox with a noninteractive approval policy; chorus → read-only sandbox with a noninteractive approval policy. Field names SHALL be verified against the schema produced by `traecli app-server generate-json-schema` for the supported traecli version. Stored thread policy or custom args SHALL NOT override the resolved posture. The Chorus MCP pre-approval of the `daemon-codex-backend` posture requirement SHALL apply unchanged: in chorus posture, and only when the user's `traecli.toml` (under `TRAE_HOME` or `~/.trae`, never the Codex config) declares `[mcp_servers.chorus]`, `thread/start` and `thread/resume` SHALL carry the per-thread `config` override `{"mcp_servers.chorus.default_tools_approval_mode": "approve"}`. No other MCP server, shell, file-change or other native approval SHALL be pre-approved, the override SHALL NOT be written to `traecli.toml`, and yolo posture SHALL NOT carry it.

#### Scenario: Restricted posture on trae

- **WHEN** the daemon wakes `trae` in chorus posture
- **THEN** `thread/start`/`thread/resume` and `turn/start` carry the read-only sandbox and noninteractive approval policy, and the adapter grants no write or full-access permissions

#### Scenario: Chorus-only TRAE wake can call Chorus MCP tools

- **WHEN** the daemon wakes `trae` in chorus posture and `traecli.toml` declares `[mcp_servers.chorus]`
- **THEN** `thread/start`/`thread/resume` carry `config: {"mcp_servers.chorus.default_tools_approval_mode": "approve"}` (and `thread/resume` still omits `excludeTurns`)
- **AND** Chorus MCP tool calls succeed, while tools of any other MCP server are still refused and file writes stay blocked by the read-only sandbox

#### Scenario: Chorus MCP declared only in the Codex config

- **WHEN** the daemon wakes `trae` in chorus posture and only the Codex `config.toml` declares `[mcp_servers.chorus]`
- **THEN** the TRAE setup requests carry no `config` override

### Requirement: TRAE MCP comes from the user config with the daemon key via env

The daemon SHALL NOT synthesize a TRAE MCP configuration. It SHALL rely on `[mcp_servers.chorus]` in the user's `traecli.toml` (under `TRAE_HOME` or `~/.trae`) and SHALL export the resolved `CHORUS_URL` and `CHORUS_API_KEY` into the child environment. The key SHALL NOT appear in process arguments or logs. When the config declares no Chorus MCP server, the wake SHALL still run and the daemon SHALL log the absence.

#### Scenario: Missing TRAE Chorus MCP still runs

- **WHEN** `traecli.toml` has no `[mcp_servers.chorus]` table
- **THEN** the TRAE wake spawns and completes without Chorus tools and the daemon logs that the TRAE config lacks the Chorus MCP server
