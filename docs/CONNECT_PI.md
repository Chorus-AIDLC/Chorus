# Connect Pi to Chorus

This guide connects the [Pi coding agent](https://pi.dev) to a running Chorus instance via the published `@chorus-aidlc/chorus-pi` package (source in this repo at `packages/chorus-pi/`). The package ships Chorus skills, read-only reviewer sub-agents, the official pi `subagent` tool, and session-aware extension hooks into Pi through Pi's native extension + skill + agent mechanisms — installed with one `pi install npm:@chorus-aidlc/chorus-pi`, no bash hook scripts.

Pi can also run as a **wakeable `--agent pi` daemon backend** — Chorus wakes a headless pi session on remote dispatch. See [Run pi as a wakeable daemon backend](#run-pi-as-a-wakeable-daemon-backend) below.

> For Claude Code, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md). For Codex, see [CONNECT_CODEX.md](CONNECT_CODEX.md).

## Fastest path: `chorus agents add`

`chorus init` (a.k.a. `chorus agents add`) wires everything below in one command — select **Pi** in the agent checklist and it:

- detects the stable Pi version: **>=0.99.0 <2.0.0** installs only **`@chorus-aidlc/chorus-pi`** and uses native MCP; **0.84.4–0.98.x** installs the verified **`pi-mcp-adapter@5.0.0`** before Chorus;
- writes **`~/.pi/agent/mcp.json`** for native MCP or **`~/.pi/agent/mcp-adapter.json`** for the legacy adapter, with an `mcpServers.chorus` entry whose `Authorization` references **`Bearer ${CHORUS_API_KEY}`** — no literal Chorus key is written;
- seeds pi as a **wakeable** agent in `~/.chorus/daemon.json`.

You still need `CHORUS_API_KEY` (and, to act as a specific agent, `CHORUS_AGENT_PROFILE`) exported in the shell that launches interactive pi — pi has no settings env-file to persist them into (the daemon spawner injects them for the wake path). The manual steps below are the equivalent by hand.

The maintained host range is **stable Pi >=0.84.4 <2.0.0**. Older versions and Pi 2.x are unsupported and trigger no package operations. Missing Pi gets conditional manual guidance. An unknown, ambiguous or prerelease version never triggers adapter changes or an MCP-complete claim; inspect `pi --version` and use a supported stable version.

`chorus upgrade --plugins` and `chorus init --update-installed` target eligible Chorus components only, never all extensions. The verified legacy adapter5 pin is retained, not refreshed to latest. Other adapter constraints and Chorus pins/ranges are preserved and can leave setup/latest refresh incomplete. Existing global or current-project adapters and `-builtin:mcp` filters produce **warnings only** on native hosts: Chorus does not uninstall packages or edit these settings. See [migration](#existing-adapter-migration-warning-only).

## Prerequisites

- Chorus instance running and reachable (e.g., `http://localhost:8637` or a deployed URL)
- The `pi` CLI installed within the maintained range (see [pi.dev](https://pi.dev)); check `pi --version`.
- **Only for Pi below 0.99.0**, install the verified legacy adapter:
  ```bash
  pi install npm:pi-mcp-adapter@5.0.0
  ```
  > Native hosts need no adapter. `chorus agents add` selects the backend for you. There is **no** separate subagents package to install — `chorus-pi` bundles pi's official `subagent` tool itself.
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

### Native MCP (Pi >=0.99.0 <2.0.0)

Prefer the built-in CLI:

```bash
pi mcp add chorus --url "http://localhost:8637/api/mcp" --bearer-token-env-var CHORUS_API_KEY
pi mcp list
```

This writes the user-level `~/.pi/agent/mcp.json`; `$PI_CODING_AGENT_DIR` overrides the agent directory. Native project config is **`.pi/mcp.json`** (`pi mcp add --local`) and requires project trust; root `.mcp.json` is not the native project path. Chorus's own session/checkin fallback reads the version-appropriate global file (native `mcp.json`, legacy `mcp-adapter.json`), including the agent-dir override. It does not discover native project `.pi/mcp.json`, so keep exporting both variables for that project-only setup. Explicit environment values take precedence.

The equivalent native JSON is:

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

Native MCP defaults to **codemode**; do not force direct exposure just for Chorus. Both direct calls and native codemode child calls emit real `mcp__chorus__chorus_*` tool events. `pi mcp list` checks the built-in implementation, not which extension currently owns `/mcp` in an interactive session.

### Legacy adapter (Pi 0.84.4–0.98.x)

Adapter **5.0.0** reads **`~/.pi/agent/mcp-adapter.json`** as its primary global configuration (or `$PI_CODING_AGENT_DIR/mcp-adapter.json`). Use the JSON above there and add **`"directTools": true`** to the `mcpServers.chorus` object. Adapter exposure and naming are separate: `toolPrefix: "none"` changes names but does not enable direct exposure.

`chorus agents add` enables direct Chorus tools for fresh legacy setup. It preserves existing server/global `directTools` choices. If the primary adapter file is absent, it copies old `mcp.json` data into the new primary file, preserving other servers/settings and leaving the old source intact. An existing primary wins; unreadable or malformed files are not overwritten. Writes are atomic, mode 0600, with an environment-referenced Chorus header; old literal Chorus bearer tokens are removed from the new output.

Adapter5 also supports legacy config discovery/import, including root `.mcp.json`, but **old global `mcp.json` is not its primary file**. Do not assume identical native and adapter discovery paths. Both backends resolve `${CHORUS_API_KEY}`; keep real keys in the environment.

The Chorus extension also discovers the generated legacy primary for its own HTTP bookkeeping. Exporting `CHORUS_API_KEY` is sufficient to resolve that config's URL; a retained old global `mcp.json` cannot shadow the primary. Explicit `CHORUS_URL` still overrides discovery. Missing environment credentials are not sent as literal `${…}` templates.

### Existing adapter migration (warning-only)

On native hosts, inspect both global and current-project `.pi/settings.json`. If you choose native MCP, manually remove the adapter from the scope that installed it and remove `"-builtin:mcp"` from that scope's `extensions` filter, preserving all unrelated entries and package filters. For a global npm adapter, `pi remove npm:pi-mcp-adapter` is the usual removal command; do not apply a global removal to solve a project-local entry. Restart Pi and verify its active MCP surface. Chorus only warns; it neither performs this cleanup nor promises that writing a config restores connectivity.

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
| MCP tools | Native `tool_search`/`/mcp`, or legacy direct tool list | Discover `chorus_checkin` using the active backend's names |
| **Tool-name prefix** | Inspect the discovered schema, then call checkin | Native `mcp__chorus__chorus_checkin`; legacy direct commonly `chorus_chorus_checkin` (see below) |
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

The bundled `subagent` tool (pi's official pattern) spawns **ephemeral** children — each runs and exits within one tool call, so there is no slot to release manually. The extension auto-creates a Chorus session when a `subagent` call starts and closes it when the tool call returns (or when the run settles, under nicobailon `pi-subagents`). Long chains (`/skill:yolo`) spawn multiple reviewers/workers in sequence; because each child is short-lived, there is no handle to close and no bookkeeping — `subagent_manage close` does not exist in this package.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chorus` not in `/mcp` panel | Check the backend-specific path above. Native uses global `mcp.json` or trusted project `.pi/mcp.json`; adapter5 uses `mcp-adapter.json`. Inspect adapter/filter conflicts and restart. |
| No reviewer reminder with a working adapter gateway | Enable legacy direct Chorus tools; gateway-only calls do not expose workflow operations as outer tool names. Native codemode is supported without forcing direct mode. |
| `chorus` listed but tools don't work | URL or token wrong. Re-check `CHORUS_URL` / `CHORUS_API_KEY` and that the URL is reachable. |
| Injected context says "connection failed" | `CHORUS_URL` / `CHORUS_API_KEY` not exported in the shell that launches Pi, or Chorus not running. |
| Skills don't show in `/skill:` autocomplete | Restart the session (`/reload` or fresh). Skills load at session start. |
| Reviewer agents not in `/subagents` | chorus-pi not installed or not restarted after install. Run `pi install npm:@chorus-aidlc/chorus-pi` and restart — the reviewer agents ship inside the package (no separate subagents install). |
| `subagent` of a reviewer fails with "Unknown subagent" | The package's bundled `agents/*.md` weren't discovered. Confirm chorus-pi is installed (its extension loads the package-relative `agents/` dir) and restart. |
| Hooks don't fire | Extensions only load for trusted projects (or as a global package). Install the package path without `-l` so Pi records it in user settings, then restart Pi. |

## Tool-name prefix (important porting note)

The Chorus backend registers tools with their native names, e.g. `chorus_checkin`. The skill docs in this package call tools by those native names (e.g. `chorus_get_task`, `chorus_pm_submit_proposal`) — the same names that work in the Claude Code and Codex plugins.

Discover the active tools rather than guessing an alias:

- **Native MCP:** `mcp__chorus__chorus_checkin`, either direct or discovered through native `tool_search` and called through `codemode` using its schema.
- **Legacy direct adapter:** usually `chorus_chorus_checkin` with the default server prefix, or `chorus_checkin` with `toolPrefix: "none"`; enable exposure separately with `directTools: true`.
- **Legacy gateway-only:** `mcp`/`mcpScript` calls do not trigger workflow reminders. The workflow matcher inspects only the event's outer `toolName`, never `input.tool` or script text. Native codemode is different: it emits real child events, so reminders work without duplicates.

The extension itself always uses the native names (`chorus_checkin`, `chorus_create_session`, …) because it calls Chorus directly over MCP-over-HTTP, bypassing the gateway prefixing. Only the **main agent's** tool calls are affected.

Bundled reviewers receive only discovered safe Chorus query/checkin/comment operations. Legacy gateways are removed from their allowlist; empty permissions fail closed. Worker/custom tool inheritance is unchanged. See `packages/chorus-pi/test/verify-pi-session.md` for an optional in-session check.

## Run pi as a wakeable daemon backend

pi is a first-class **wakeable daemon backend**: the Chorus daemon can wake a headless pi session on remote dispatch (an idea/task assigned to your agent, an `@mention`, a proposal decision), so pi participates in the reversed-conversation loop like Claude Code / Codex / Kiro.

The simplest path is `chorus init` (a.k.a. `chorus agents add`): select **Pi** to install the version-appropriate backend and Chorus extension, write the env-referenced config (see [Step 2](#step-2-configure-the-mcp-server)), seed pi as a **wakeable** agent in `~/.chorus/daemon.json`, and optionally install the boot daemon. To wire it by hand instead, run the daemon with the pi backend:

```bash
chorus daemon --agent pi
```

Notes:
- The daemon resolves the `pi` executable from PATH (override with `CHORUS_PI_PATH`) and runs one headless `pi --mode rpc` process per wake, exporting `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into the woken session.
- Daemon wakes need **pi 0.85.0 or newer** (verified with 0.85.1). With an older pi the daemon skips the wake and logs the upgrade command: `npm install -g @earendil-works/pi-coding-agent@latest`.
- Each idea keeps one pi session (`--session-id <idea-uuid>`), including sessions started before the RPC switch. If pi cannot restore a session's history, the wake continues in a fresh session and the conversation shows a notice saying so.
- Interrupting a wake from the Chorus UI aborts pi's current run cleanly, including a running tool.
- Nobody is at the terminal during a daemon wake, so any extension dialog (select / confirm / input / editor) is cancelled right away and the daemon logs `cancelled pi extension <method> dialog`. Ask the human through a Chorus comment or elaboration instead.
- pi has **no permission system**, so no sandbox/skip-permissions flag is involved — `chorus` and `yolo` daemon modes run pi identically.
- Keep chorus-pi and the version-appropriate MCP backend configured in the environment the daemon wakes: native on newer hosts, adapter5 direct tools on legacy hosts. The extension's own bookkeeping uses its environment variables separately.

## Next

- Read the `packages/chorus-pi/skills/chorus/SKILL.md` for the platform overview and tool reference.
- Use `/skill:yolo` for the full-auto AI-DLC pipeline, or the individual stage skills (`/skill:idea`, `/skill:proposal`, `/skill:develop`, `/skill:review`).
- For the full design rationale and the Claude→Codex→Pi migration notes, see `docs/codex-plugin-plan.md` (the Codex plan; the Pi port follows the same methodology).
