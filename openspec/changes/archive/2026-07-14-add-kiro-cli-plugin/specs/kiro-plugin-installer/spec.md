## ADDED Requirements

### Requirement: `install-kiro.sh` merges the template into the user's `.kiro/`
Chorus SHALL provide `public/install-kiro.sh`, a one-shot installer runnable via `curl … | bash`, that copies the `public/kiro-plugin/.kiro/` template into the user's Kiro config directory: global `~/.kiro/` by default, or `<cwd>/.kiro/` when `--workspace` is passed. The installer SHALL merge (not blindly overwrite) — it adds/updates only the `chorus` MCP server key and the `chorus`-prefixed skills/agents/steering, backing up any file it modifies before writing, and SHALL be idempotent (safe to re-run).

#### Scenario: Global install by default
- **WHEN** `install-kiro.sh` is run with no scope flag and `CHORUS_URL` + `CHORUS_API_KEY` in env
- **THEN** it writes the Chorus skills, agents, steering, and `settings/mcp.json` under `~/.kiro/`, leaving any pre-existing non-Chorus files in place

#### Scenario: Workspace scope on request
- **WHEN** `install-kiro.sh --workspace` is run from a project directory
- **THEN** it writes the same artifacts under `<cwd>/.kiro/` instead of `~/.kiro/`

#### Scenario: mcp.json merge preserves other servers
- **WHEN** the target `~/.kiro/settings/mcp.json` already contains the user's own MCP servers
- **THEN** the installer adds or updates only the `chorus` server entry, leaves the other servers untouched, and creates a backup of the original before writing

#### Scenario: Idempotent re-run
- **WHEN** `install-kiro.sh` is run a second time with the same inputs
- **THEN** the resulting `~/.kiro/` tree is unchanged from the first run (no duplicate entries, no accumulated backups beyond the single `.chorus-bak`) and the command exits successfully

### Requirement: Installer collects and normalizes Chorus connection settings
The installer SHALL obtain `CHORUS_URL` and `CHORUS_API_KEY` from environment variables when both are set (non-interactive), and otherwise prompt on a TTY. It SHALL normalize `CHORUS_URL` so the MCP endpoint ends in `/api/mcp`, SHALL require the URL to be `http://` or `https://`, and SHALL fail loudly (non-zero exit, explanatory message) when a required value is missing with no TTY available.

#### Scenario: Non-interactive install from env
- **WHEN** both `CHORUS_URL` and `CHORUS_API_KEY` are exported and the installer runs with no TTY
- **THEN** it completes without prompting and writes the normalized `/api/mcp` URL into `settings/mcp.json`

#### Scenario: Missing key with no TTY fails loudly
- **WHEN** `CHORUS_API_KEY` is unset and no interactive TTY is available
- **THEN** the installer prints an explanatory error and exits non-zero, rather than writing an incomplete config

#### Scenario: URL normalized to the MCP endpoint
- **WHEN** the user supplies a bare host (with or without a trailing slash) as `CHORUS_URL`
- **THEN** the value written to `settings/mcp.json` ends in exactly one `/api/mcp` path segment

### Requirement: Installer installs hook scripts and resolves hook command paths
The installer SHALL copy the hook scripts and the reused `chorus-api.sh` from `public/kiro-plugin/bin/` into `<KIRO_DIR>/chorus-bin/` (where `<KIRO_DIR>` is `~/.kiro` for a global install or `<cwd>/.kiro` for `--workspace`), mark them executable, and SHALL substitute the `__CHORUS_BIN__` placeholder in the installed `agents/chorus.json` hook `command` strings with the resolved absolute path to that `chorus-bin/` directory — so every hook resolves at runtime regardless of the directory Kiro is launched from and regardless of install scope. Without this, the shipped session-automation hooks would have no scripts to run.

#### Scenario: Hook scripts land executable in the Kiro dir
- **WHEN** the installer runs (either scope)
- **THEN** every `public/kiro-plugin/bin/*.sh` script plus `chorus-api.sh` exists under `<KIRO_DIR>/chorus-bin/` with the executable bit set

#### Scenario: Hook command placeholders are concretized to absolute paths
- **WHEN** the installed `<KIRO_DIR>/agents/chorus.json` is read after install
- **THEN** no hook `command` contains the literal `__CHORUS_BIN__`, and each points at an existing executable script under the absolute `<KIRO_DIR>/chorus-bin/` path

#### Scenario: Paths resolve under both global and workspace scope
- **WHEN** the installer is run once globally and once with `--workspace`
- **THEN** in each case the `agents/chorus.json` hook `command`s reference that scope's own `chorus-bin/` absolute path, so hooks are runnable under both

### Requirement: Kiro registered as the fourth plugin surface in docs
The change SHALL register Kiro as the fourth plugin surface: a `docs/CONNECT_KIRO.md` connect guide paralleling `docs/CONNECT_CODEX.md`, and updates to surface-count statements in `docs/MCP_TOOLS.md` and the `plugin-maintenance` skill (surface list + bump recipe). The connect guide SHALL document that live in-Kiro activation (e.g. `/chorus-idea`, `kiro --agent chorus`) is the user's manual verification step.

#### Scenario: Connect guide exists and names the install command
- **WHEN** `docs/CONNECT_KIRO.md` is read
- **THEN** it shows the `install-kiro.sh` one-shot command, the default-global vs `--workspace` behavior, and how to activate `/chorus-*` skills and the `chorus` main agent in Kiro

#### Scenario: Surface count updated where stated
- **WHEN** a doc or skill that enumerates the plugin surfaces is read after this change
- **THEN** it lists Kiro alongside Claude Code, Codex, and OpenClaw
