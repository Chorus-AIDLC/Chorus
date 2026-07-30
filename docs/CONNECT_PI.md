# Connect Pi to Chorus

This guide connects the [Pi coding agent](https://pi.dev) to a running Chorus instance via the `chorus-pi` package (in this repo at `packages/chorus-pi/`). The package ships Chorus skills, read-only reviewer sub-agents, and session-aware extension hooks into Pi through Pi's native extension + skill + agent mechanisms — no marketplace, no installer, no bash hook scripts.

> For Claude Code, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md). For Codex, see [CONNECT_CODEX.md](CONNECT_CODEX.md).

## Prerequisites

- Chorus instance running and reachable (e.g., `http://localhost:8637` or a deployed URL)
- The `pi` CLI installed (see [pi.dev](https://pi.dev))
- The `pi-mcp-adapter` and `pi-subagents` packages installed (the two runtime dependencies of `chorus-pi`):
  ```bash
  pi install npm:pi-mcp-adapter
  pi install npm:@narumitw/pi-subagents
  ```
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` so Pi can read them on startup. The extension reads `CHORUS_URL` (the Chorus root, or the full `/api/mcp` endpoint) and `CHORUS_API_KEY` to perform its own `chorus_checkin` and session lifecycle calls over MCP-over-HTTP.
>
> **Note on URL format:** `CHORUS_URL` may be either the root URL (`https://chorus.example.com`) or the full MCP endpoint (`https://chorus.example.com/api/mcp`). The extension appends `/api/mcp` only when the URL has no path beyond the host.

## Step 2: Configure the MCP server

Pi's `pi-mcp-adapter` auto-discovers standard MCP config files. Place a `.mcp.json` at the project root (or `~/.pi/agent/mcp.json` globally) so the main agent gets the `chorus_*` tools:

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:8637/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_your_api_key"
      }
    }
  }
}
```

> Unlike the Codex port, **no installer is required**. Pi reads this file directly — literal URL + literal Bearer work out of the box (Pi does not require `${VAR}` expansion in `.mcp.json`). If you already have `.claude.json` / `~/.codex/config.toml` configured, `pi-mcp-adapter` will discover and offer to adopt those too via `/mcp setup`.

## Step 3: Install the chorus-pi package

### From this repo (development)

```bash
pi install ./packages/chorus-pi
```

### From GitHub

```bash
git clone --filter=blob:none --sparse https://github.com/Chorus-AIDLC/Chorus.git
cd Chorus
git sparse-checkout set packages/chorus-pi
pi install "$PWD/packages/chorus-pi"
```

Pi accepts Git package sources such as `pi install git:github.com/user/repo@ref`, but currently has no syntax for selecting a package subdirectory. Because Chorus is a monorepo, installing its repository root directly does not load `packages/chorus-pi`.

Restart Pi after installation (`/reload` or a fresh session) so the extension and skills are loaded.

### Step 3b: Install the reviewer agents

Pi's `pi-subagents` loads custom agents from `~/.pi/agent/agents/*.md` (user-level) or `.pi/agents/*.md` (project-level) — **not** from the package manifest. Copy the bundled reviewer agent definitions so `subagent_spawn` can find them:

```bash
mkdir -p ~/.pi/agent/agents
cp packages/chorus-pi/agents/*.md ~/.pi/agent/agents/
```

> The package ships all three reviewer agent definitions (`chorus-proposal-reviewer.md`, `chorus-task-reviewer.md`, `chorus-code-reviewer.md`). Copy all of them. Project-level agents (`.pi/agents/`) prompt for trust on first use; user-level agents are always available.

## Step 4: Verify the connection

| Check | How | Expected |
|---|---|---|
| MCP registered | Pi `/mcp` panel | `chorus` shows connected (green plug icon) |
| MCP tools | `pi.getActiveTools()` or the `/mcp` panel | `chorus_*` tools listed (40+ tools) |
| **Tool-name prefix** | `mcp({ search: "checkin" })` | Tools are exposed as `chorus_chorus_<tool>` in gateway mode (see note below) |
| Extension loaded | Start a session and look for the injected context | A `# Chorus Plugin — Active` message appears at the first turn with your checkin info |
| Skills available | Type `/skill:chorus` | The skill loads |
| Reviewer agent | Inspect `/subagents` or spawn one | `chorus-proposal-reviewer` is listed |
| OpenSpec detection | Look at the injected context | `CHORUS_OPENSPEC_ACTIVE=…` reflects your repo state |

If the checkin fails, the injected context will read `# Chorus: connection failed (<url>)` — check that `CHORUS_URL` / `CHORUS_API_KEY` are exported in the shell that launches Pi, and that the URL is reachable.

## What the package provides

- **8 skills** — `/skill:chorus`, `/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`, `/skill:quick-dev`, `/skill:yolo`, plus `openspec-aware` (a shared sub-procedure invoked by proposal/develop/yolo in OpenSpec mode) — driving every stage of the AI-DLC lifecycle. These are Agent Skills standard `SKILL.md` files, ported from the Claude Code plugin with Claude-specific references replaced (e.g. `Task` tool → `subagent`/`subagent_spawn`, `/chorus:develop` → `/skill:develop`, `disallowedTools` → `tools` whitelist).
- **3 read-only reviewer sub-agents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer` — defined as `.pi/agents/*.md` (frontmatter: `name`/`description`/`tools`/`model`; body = the system prompt). Spawned by the main agent via the blocking `subagent` tool (so it waits for the VERDICT) after proposal/task submission; they post a `VERDICT` comment and stop.
- **Session-aware extension** (`packages/chorus-pi/extensions/chorus.ts`) — a single TypeScript extension that subscribes to Pi's native events:
  - `session_start` → `chorus_checkin` + OpenSpec detection + context injection (replaces Claude's `SessionStart` hook)
  - `before_agent_start` → inject the checkin result once (replaces Claude's `UserPromptSubmit` noise)
  - `tool_call` on `subagent_spawn` (pre-execution, **mutable input**) → create a Chorus session and **inject its UUID + the session workflow into the spawned worker's task**. The subprocess receives the UUID directly. This is the Pi-native equivalent of Claude's `SubagentStart` context injection — a capability the Codex port lacks (Codex has no pre-spawn mutation channel, so its workers manage sessions manually).
  - `tool_execution_end` → reviewer nudges after `chorus_pm_submit_proposal` / `chorus_submit_for_verify` / `chorus_admin_verify_task` (the 3 Claude `PostToolUse` hooks); also maps `agentId`→`sessionUuid` on spawn result (or closes an orphan session on spawn error), and closes the mapped session on `subagent_manage close`
  - `session_shutdown` → close any stray sessions (replaces Claude's `SessionEnd` hook)

### How it differs from the Claude Code / Codex versions

| Aspect | Claude Code | Codex | Pi |
|---|---|---|---|
| Extension form | `.claude-plugin/plugin.json` + `userConfig` | `.codex-plugin/plugin.json` + `interface` | TypeScript extension + `package.json` `pi.extensions` |
| Hooks | `hooks.json` → bash scripts (~10 events) | `hooks.json` → bash scripts (4 events, stateless) | `pi.on(event)` in TS (20+ native events) |
| MCP delivery | `.mcp.json` with `${VAR}` expansion | installer writes `config.toml` (no `${VAR}`) | `pi-mcp-adapter` auto-discovers `.mcp.json` (literal values) |
| Sub-agent sessions | auto (SubagentStart/Stop events) | **manual** (no sub-agent events) | **auto** (`tool_call` mutation injects session UUID into the spawned task) |
| Reviewer agents | `agents/*.md` (model/tools/disallowedTools) | `agents/openai.yaml` (UI metadata) | `.pi/agents/*.md` (name/description/tools/model) |
| Distribution | marketplace + `/plugins` | installer + TUI `/plugins` | GitHub checkout + local-path `pi install` |
| Shell compat | n/a | must be Bash 3.2 compatible | n/a (TypeScript) |

## Configuration options (env vars)

The extension has no plugin-settings UI (Pi extensions are config-by-env). All toggles are env vars, all default to enabled:

| Env var | Controls | Default |
|---|---|---|
| `CHORUS_URL` | Chorus root or `/api/mcp` endpoint | (required) |
| `CHORUS_API_KEY` | Agent API key (`cho_…`) | (required) |
| `CHORUS_OPENSPEC_MODE` | Set to `off` to opt out of OpenSpec detection | (unset = auto-detect) |
| `CHORUS_ENABLE_PROPOSAL_REVIEWER` | Nudge `chorus-proposal-reviewer` after `chorus_pm_submit_proposal` | `true` |
| `CHORUS_ENABLE_TASK_REVIEWER` | Nudge `chorus-task-reviewer` after `chorus_submit_for_verify` | `true` |
| `CHORUS_ENABLE_CODE_REVIEWER` | Nudge `chorus-code-reviewer` after the last task of an idea-rooted proposal is verified | `true` |

## Sub-agent concurrency discipline

Pi limits concurrent sub-agents (the `pi-subagents` package enforces a recursion-depth guard and process-group bound). After a reviewer or worker finishes, **call `subagent_manage close`** to release its slot — a `completed` state does not free it. The extension auto-closes the corresponding Chorus session when you do. Long chains (`/skill:yolo`) spawn multiple reviewers/workers; close each one after it returns to avoid hitting the limit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chorus` not in `/mcp` panel | Did you place `.mcp.json` at the project root (or `~/.pi/agent/mcp.json`)? Run `/mcp setup` to adopt host configs, or create the file manually. |
| `chorus` listed but tools don't work | URL or token wrong. Re-check `CHORUS_URL` / `CHORUS_API_KEY` and that the URL is reachable. |
| Injected context says "connection failed" | `CHORUS_URL` / `CHORUS_API_KEY` not exported in the shell that launches Pi, or Chorus not running. |
| Skills don't show in `/skill:` autocomplete | Restart the session (`/reload` or fresh). Skills load at session start. |
| Reviewer agents not in `/subagents` | `pi-subagents` not installed, or not restarted after install. Run `pi install npm:@narumitw/pi-subagents` and restart. |
| `subagent_spawn` of a reviewer fails with "Unknown subagent" | The `packages/chorus-pi/agents/*.md` files aren't on the agent discovery path. Confirm the package is installed and restart. |
| Hooks don't fire | Extensions only load for trusted projects (or as a global package). Install the package path without `-l` so Pi records it in user settings, then restart Pi. |

## Tool-name prefix (important porting note)

The Chorus backend registers tools with their native names, e.g. `chorus_checkin`. The skill docs in this package call tools by those native names (e.g. `chorus_get_task`, `chorus_pm_submit_proposal`) — the same names that work in the Claude Code and Codex plugins.

Pi's `pi-mcp-adapter` exposes MCP tools to the LLM and **prefixes them with the server name** by default (`toolPrefix: "server"`). Since your MCP server is named `chorus`, the LLM-facing tool name becomes `chorus_chorus_checkin` (the `chorus_` server prefix + the backend's `chorus_checkin` name). So:

- **Gateway mode** (default — you see a single `mcp` tool in the system prompt): call tools as `mcp({ tool: "chorus_chorus_checkin" })` — the double prefix.
- **Direct mode** (`includeTools` configured, or `toolPrefix: "none"`): call tools as `chorus_checkin` — the native name, matching the skill docs.

The extension itself always uses the native names (`chorus_checkin`, `chorus_create_session`, …) because it calls Chorus directly over MCP-over-HTTP, bypassing the gateway prefixing. Only the **main agent's** tool calls are affected.

If you want the skill docs' `chorus_*` names to work verbatim for the main agent, configure the chorus server with `"toolPrefix": "none"` in your mcp config, or add the specific tools via `includeTools`. Otherwise, translate `chorus_X` → `chorus_chorus_X` when calling from the main agent in gateway mode. The in-session verification (`packages/chorus-pi/test/verify-pi-session.md`) auto-detects which mode is active.

## Next

- Read the `packages/chorus-pi/skills/chorus/SKILL.md` for the platform overview and tool reference.
- Use `/skill:yolo` for the full-auto AI-DLC pipeline, or the individual stage skills (`/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`).
- For the full design rationale and the Claude→Codex→Pi migration notes, see `docs/codex-plugin-plan.md` (the Codex plan; the Pi port follows the same methodology).
