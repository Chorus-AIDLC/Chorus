# Connect Pi to Chorus

This guide connects the [Pi coding agent](https://pi.dev) to a running Chorus instance via the published `@chorus-aidlc/chorus-pi` package (source in this repo at `packages/chorus-pi/`). The package ships Chorus skills, read-only reviewer sub-agents, the official pi `subagent` tool, and session-aware extension hooks into Pi through Pi's native extension + skill + agent mechanisms — installed with one `pi install npm:@chorus-aidlc/chorus-pi`, no bash hook scripts.

Pi can also run as a **wakeable `--agent pi` daemon backend** — Chorus wakes a headless pi session on remote dispatch. See [Run pi as a wakeable daemon backend](#run-pi-as-a-wakeable-daemon-backend) below.

> For Claude Code, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md). For Codex, see [CONNECT_CODEX.md](CONNECT_CODEX.md).

## Fastest path: `chorus agents add`

`chorus init` (a.k.a. `chorus agents add`) wires everything below in one command — select **Pi** in the agent checklist and it:

- installs **`pi-mcp-adapter`** (the MCP tool surface) and then **`@chorus-aidlc/chorus-pi`** (`pi install npm:pi-mcp-adapter && pi install npm:@chorus-aidlc/chorus-pi`), degrading to the manual commands if the `pi` CLI is absent;
- writes pi's global **`~/.pi/agent/mcp.json`** with an `mcpServers.chorus` entry whose `Authorization` header references the key by **environment variable** (`Bearer ${CHORUS_API_KEY}`) — the resolved endpoint URL is a literal, and **no `cho_` key is ever written to disk** (the same keyless model Claude Code and Codex use);
- seeds pi as a **wakeable** agent in `~/.chorus/daemon.json`.

You still need `CHORUS_API_KEY` (and, to act as a specific agent, `CHORUS_AGENT_PROFILE`) exported in the shell that launches interactive pi — pi has no settings env-file to persist them into (the daemon spawner injects them for the wake path). The manual steps below are the equivalent by hand.

## Prerequisites

- Chorus instance running and reachable (e.g., `http://localhost:8637` or a deployed URL)
- The `pi` CLI installed (see [pi.dev](https://pi.dev))
- The `pi-mcp-adapter` package installed (the one runtime dependency that exposes the Chorus `chorus_*` MCP tools to pi):
  ```bash
  pi install npm:pi-mcp-adapter
  ```
  > `chorus agents add` installs this for you. There is **no** separate subagents package to install — `chorus-pi` bundles pi's official `subagent` tool itself.
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` so Pi can read them on startup. The extension reads `CHORUS_URL` (the Chorus root, or the full `/api/mcp` endpoint) and `CHORUS_API_KEY` to perform its own `chorus_checkin` and session lifecycle calls over MCP-over-HTTP. The `mcp.json` below references `CHORUS_API_KEY` too, so the same export feeds both the extension and the MCP tool surface.
>
> **Note on URL format:** `CHORUS_URL` may be either the root URL (`https://chorus.example.com`) or the full MCP endpoint (`https://chorus.example.com/api/mcp`). The extension appends `/api/mcp` only when the URL has no path beyond the host.

## Step 2: Configure the MCP server

Pi's `pi-mcp-adapter` auto-discovers standard MCP config files. `chorus agents add` writes the **global** config at `~/.pi/agent/mcp.json` (the Pi agent-dir override the adapter discovers by default; override the dir with `$PI_CODING_AGENT_DIR`) with the key **referenced from the environment** — no literal key on disk. To do it by hand, place this at that global path (or as a project-root `.mcp.json`):

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:8637/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CHORUS_API_KEY}"
      }
    }
  }
}
```

> `pi-mcp-adapter` interpolates `${CHORUS_API_KEY}` (and `$env:CHORUS_API_KEY`) in `url`/`headers` at connect time, so the `cho_` key stays in the environment — never in the file. The endpoint URL is written as a literal (it is not a secret). A literal `Bearer cho_...` also still works, but the env-referenced form is what `chorus agents add` writes so a shared/committed config never leaks a key. If you already have `.claude.json` / `~/.codex/config.toml` configured, `pi-mcp-adapter` will discover and offer to adopt those too via `/mcp setup`.

## Step 3: Install the chorus-pi package

```bash
pi install npm:@chorus-aidlc/chorus-pi
```

That is the whole install. The `subagent` tool (pi's official subagent reference pattern) ships inside the package, and the three reviewer agents (`chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`) are discovered directly from the package's own `agents/` directory — there is **no** separate subagents dependency and **no** manual copy of agent files into `~/.pi/agent/agents/`.

Restart Pi after installation (`/reload` or a fresh session) so the extension, skills, and reviewer agents load.

> **Developing chorus-pi locally?** Install from the repo checkout instead — `pi install ./packages/chorus-pi` from the Chorus repo root. The published npm package (`npm:@chorus-aidlc/chorus-pi`) is the route for everyone else; the old sparse-git-checkout workaround is no longer needed.

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

- **12 skills** — `/skill:chorus`, `/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`, `/skill:quick-dev`, `/skill:yolo`, `/skill:brainstorm`, `/skill:orchestrate`, `/skill:docs`, `/skill:chorus-cli`, plus `openspec-aware` (a shared sub-procedure invoked by proposal/develop/yolo in OpenSpec mode) — driving every stage of the AI-DLC lifecycle. These are Agent Skills standard `SKILL.md` files, ported from the Claude Code plugin with Claude-specific references replaced (e.g. `Task` tool → the `subagent` tool, `/chorus:develop` → `/skill:develop`, `disallowedTools` → `tools` whitelist).
- **3 read-only reviewer sub-agents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer` — bundled as `agents/*.md` in the package (frontmatter: `name`/`description`/`tools`/`model`; body = the system prompt) and discovered **package-relative** by the bundled subagent extension — no manual copy into `~/.pi/agent/agents/`. Spawned by the main agent via the blocking `subagent` tool (so it waits for the VERDICT) after proposal/task submission; they post a `VERDICT` comment and stop.
- **The official pi `subagent` tool** — bundled at `extensions/subagent/` (pi's official reference pattern), replacing the former third-party `@narumitw/pi-subagents` dependency.
- **Session-aware extension** (`packages/chorus-pi/extensions/chorus.ts`) — a single TypeScript extension that subscribes to Pi's native events:
  - `session_start` → `chorus_checkin` + OpenSpec detection + context injection (replaces Claude's `SessionStart` hook)
  - `before_agent_start` → inject the checkin result once (replaces Claude's `UserPromptSubmit` noise)
  - `tool_call` on the `subagent` tool (pre-execution, **mutable input**) → create a Chorus session and **inject its UUID + the session workflow into the spawned worker's task**. The subprocess receives the UUID directly. This is the Pi-native equivalent of Claude's `SubagentStart` context injection — a capability the Codex port lacks (Codex has no pre-spawn mutation channel, so its workers manage sessions manually).
  - `tool_execution_end` → reviewer nudges after `chorus_pm_submit_proposal` / `chorus_submit_for_verify` / `chorus_admin_verify_task` (the 3 Claude `PostToolUse` hooks); also closes the Chorus session created for a `subagent` call when the (ephemeral) child finishes and the tool call returns
  - `session_shutdown` → close any stray sessions (replaces Claude's `SessionEnd` hook)

### How it differs from the Claude Code / Codex versions

| Aspect | Claude Code | Codex | Pi |
|---|---|---|---|
| Extension form | `.claude-plugin/plugin.json` + `userConfig` | `.codex-plugin/plugin.json` + `interface` | TypeScript extension + `package.json` `pi.extensions` |
| Hooks | `hooks.json` → bash scripts (~10 events) | `hooks.json` → bash scripts (4 events, stateless) | `pi.on(event)` in TS (20+ native events) |
| MCP delivery | `.mcp.json` with `${VAR}` expansion | installer writes `config.toml` (keyless `bearer_token_env_var`) | `chorus agents add` writes `~/.pi/agent/mcp.json`; `pi-mcp-adapter` reads it + interpolates `${CHORUS_API_KEY}` |
| Sub-agent sessions | auto (SubagentStart/Stop events) | **manual** (no sub-agent events) | **auto** (`tool_call` mutation injects session UUID into the spawned task) |
| Reviewer agents | `agents/*.md` (model/tools/disallowedTools) | `agents/openai.yaml` (UI metadata) | bundled `agents/*.md`, discovered package-relative (no copy) |
| Distribution | marketplace + `/plugins` | installer + TUI `/plugins` | npm (`pi install npm:@chorus-aidlc/chorus-pi`) |
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

The bundled `subagent` tool (pi's official pattern) spawns **ephemeral** children — each runs and exits within one tool call, so there is no slot to release manually. The extension auto-creates a Chorus session when a `subagent` call starts and closes it when the tool call returns. Long chains (`/skill:yolo`) spawn multiple reviewers/workers in sequence; because each child is short-lived, no `subagent_manage close` bookkeeping is required.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chorus` not in `/mcp` panel | Did you place `.mcp.json` at the project root (or `~/.pi/agent/mcp.json`)? Run `/mcp setup` to adopt host configs, or create the file manually. |
| `chorus` listed but tools don't work | URL or token wrong. Re-check `CHORUS_URL` / `CHORUS_API_KEY` and that the URL is reachable. |
| Injected context says "connection failed" | `CHORUS_URL` / `CHORUS_API_KEY` not exported in the shell that launches Pi, or Chorus not running. |
| Skills don't show in `/skill:` autocomplete | Restart the session (`/reload` or fresh). Skills load at session start. |
| Reviewer agents not in `/subagents` | chorus-pi not installed or not restarted after install. Run `pi install npm:@chorus-aidlc/chorus-pi` and restart — the reviewer agents ship inside the package (no separate subagents install). |
| `subagent` of a reviewer fails with "Unknown subagent" | The package's bundled `agents/*.md` weren't discovered. Confirm chorus-pi is installed (its extension loads the package-relative `agents/` dir) and restart. |
| Hooks don't fire | Extensions only load for trusted projects (or as a global package). Install the package path without `-l` so Pi records it in user settings, then restart Pi. |

## Tool-name prefix (important porting note)

The Chorus backend registers tools with their native names, e.g. `chorus_checkin`. The skill docs in this package call tools by those native names (e.g. `chorus_get_task`, `chorus_pm_submit_proposal`) — the same names that work in the Claude Code and Codex plugins.

Pi's `pi-mcp-adapter` exposes MCP tools to the LLM and **prefixes them with the server name** by default (`toolPrefix: "server"`). Since your MCP server is named `chorus`, the LLM-facing tool name becomes `chorus_chorus_checkin` (the `chorus_` server prefix + the backend's `chorus_checkin` name). So:

- **Gateway mode** (default — you see a single `mcp` tool in the system prompt): call tools as `mcp({ tool: "chorus_chorus_checkin" })` — the double prefix.
- **Direct mode** (`includeTools` configured, or `toolPrefix: "none"`): call tools as `chorus_checkin` — the native name, matching the skill docs.

The extension itself always uses the native names (`chorus_checkin`, `chorus_create_session`, …) because it calls Chorus directly over MCP-over-HTTP, bypassing the gateway prefixing. Only the **main agent's** tool calls are affected.

If you want the skill docs' `chorus_*` names to work verbatim for the main agent, configure the chorus server with `"toolPrefix": "none"` in your mcp config, or add the specific tools via `includeTools`. Otherwise, translate `chorus_X` → `chorus_chorus_X` when calling from the main agent in gateway mode. The in-session verification (`packages/chorus-pi/test/verify-pi-session.md`) auto-detects which mode is active.

## Run pi as a wakeable daemon backend

pi is a first-class **wakeable daemon backend**: the Chorus daemon can wake a headless pi session on remote dispatch (an idea/task assigned to your agent, an `@mention`, a proposal decision), so pi participates in the reversed-conversation loop like Claude Code / Codex / Kiro.

The simplest path is `chorus init` (a.k.a. `chorus agents add`): select **Pi** in the agent checklist and it installs the adapter + extension (`pi install npm:pi-mcp-adapter && pi install npm:@chorus-aidlc/chorus-pi`), writes the env-referenced `~/.pi/agent/mcp.json` (no literal key — see [Step 2](#step-2-configure-the-mcp-server)), seeds pi as a **wakeable** agent in `~/.chorus/daemon.json`, and — if you opt in — installs the boot daemon that wakes it. To wire it by hand instead, run the daemon with the pi backend:

```bash
chorus daemon --agent pi
```

Notes:
- The daemon resolves the `pi` executable from PATH (override with `CHORUS_PI_PATH`) and runs it headless (`pi --mode json -p`), exporting `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into the woken session.
- pi has **no permission system**, so no sandbox/skip-permissions flag is involved — `chorus` and `yolo` daemon modes run pi identically.
- A woken pi reaches Chorus MCP tools only through this package's extension / `pi-mcp-adapter`, so keep chorus-pi installed in the environment the daemon wakes (the npm install above makes that reliable).

## Next

- Read the `packages/chorus-pi/skills/chorus/SKILL.md` for the platform overview and tool reference.
- Use `/skill:yolo` for the full-auto AI-DLC pipeline, or the individual stage skills (`/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`).
- For the full design rationale and the Claude→Codex→Pi migration notes, see `docs/codex-plugin-plan.md` (the Codex plan; the Pi port follows the same methodology).
