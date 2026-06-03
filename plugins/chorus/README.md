# Chorus Plugin for Codex CLI

Chorus AI-DLC collaboration platform plugin for OpenAI Codex CLI, ported from the Claude Code plugin (`public/chorus-plugin/`). See `docs/codex-plugin-plan.md` at the repo root for the full research and design notes.

- **Version**: 0.7.5
- **License**: AGPL-3.0
- **Upstream**: https://github.com/Chorus-AIDLC/Chorus

## What this plugin provides

- **7 skills** — `$chorus`, `$idea`, `$proposal`, `$develop`, `$review`, `$quick-dev`, `$yolo` — driving every stage of the AI-DLC lifecycle
- **2 read-only reviewer subagents** — `chorus-proposal-reviewer`, `chorus-task-reviewer`
- **4 session-aware hooks** — session start checkin, per-turn reminders, and PostToolUse reviewer nudges after proposal/task submission

> The Chorus **MCP server** is configured separately — see *Installation* below. Codex's plugin runtime doesn't expand `${VAR}` in `.mcp.json` and doesn't pass the user's shell env through to MCP subprocesses, so we don't ship an `.mcp.json` in this plugin. Instead, the install script writes a proper `[mcp_servers.chorus]` section to `~/.codex/config.toml` with a literal URL + `Authorization: Bearer <key>` header.

## Installation

### One-shot installer (recommended)

```bash
curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh | bash
```

The installer:

1. Verifies `codex` is in `PATH`
2. Registers the **chorus-plugins** marketplace (`codex plugin marketplace add …`)
3. Prompts for your **Chorus URL** and **API key** (or reads them from `CHORUS_URL` / `CHORUS_API_KEY` env)
4. Writes `[mcp_servers.chorus]` + `[mcp_servers.chorus.http_headers]` to `~/.codex/config.toml` (`chmod 600`, backed up once to `config.toml.chorus-bak`)
5. Enables lifecycle hooks with `[features] hooks = true`

Chorus lifecycle hooks are bundled in the Codex plugin manifest and loaded automatically after the plugin is installed and enabled. Use `/hooks` in Codex to review and trust newly installed or changed hook definitions.

Then finish with `/plugins` inside the Codex TUI.

Re-run at any time to rotate the API key — existing `[mcp_servers.chorus*]` sections are wiped and re-written idempotently.

### Finish inside Codex

```
codex
> /plugins
→ chorus (INSTALLED_BY_DEFAULT; one-click Install if auto-install does not fire)
```

That copies the plugin (skills + agents + hooks) into `~/.codex/plugins/cache/chorus-plugins/chorus/<version>/` and flips `[plugins."chorus@chorus-plugins"] enabled = true` in your config.

### Verify

```bash
codex mcp list    # look for 'chorus' row with Auth = 'Bearer token'
```

Inside Codex, type `$chorus` (or any of `$idea` / `$proposal` / `$develop` / `$review` / `$quick-dev` / `$yolo`) to activate a skill. Skills are namespaced; the fully qualified names are `chorus:<skill>` (e.g. `chorus:develop`).

### Non-interactive install (CI / scripted)

```bash
CHORUS_URL="https://chorus.example.com/api/mcp" \
CHORUS_API_KEY="cho_..." \
  bash <(curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh)
```

`CHORUS_MARKETPLACE_SOURCE` can also be overridden (e.g. to a fork URL or local clone path).

### Manual (if you'd rather not run the installer)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.chorus]
url = "https://chorus.example.com/api/mcp"

[mcp_servers.chorus.http_headers]
Authorization = "Bearer cho_your_key_here"
```

Then register the marketplace and install:

```bash
codex plugin marketplace add https://github.com/Chorus-AIDLC/Chorus
codex   # plugin auto-installs on first launch; use /plugins to confirm
```

## What's different from the Claude Code version

The Codex port is currently **stateless** — no `.chorus/` directory is used anywhere. Codex now supports `SubagentStart` and `SubagentStop` plugin hooks, but the Chorus Codex plugin has not yet wired them into automatic session lifecycle management. Codex still does not provide direct equivalents for Claude Code's `TeammateIdle`, `SessionEnd`, and `TaskCompleted` events.

Consequences:

- ❌ Sub-agent sessions are **not yet** auto-created by the plugin. The main agent creates/closes Chorus sessions manually when per-worker observability is desired.
- ❌ No auto-checkout on sub-agent exit yet — workers must explicitly call `chorus_session_checkout_task` in their skill-driven workflow, and the main agent calls `chorus_close_session` after `spawn_agent` returns.
- ❌ No idle-heartbeat hook — rely on Chorus backend session TTL, or have the main agent call `chorus_session_heartbeat` periodically.
- ✅ Everything else works: all 40+ MCP tools over the HTTP transport, all skills, both reviewer subagents, and 4 of the most valuable hooks.

For single-agent use the UX is identical to the Claude version. For heavy parallel-worker use, the main agent carries more session-management responsibility (documented in `$develop` skill).

Full design rationale and binary-level schema research: `docs/codex-plugin-plan.md` at the repo root.

## Skills cheat sheet

| Skill | Purpose |
|---|---|
| `$chorus` | Platform overview, setup, common tools, routing to other skills |
| `$idea` | Claim ideas, run elaboration rounds |
| `$proposal` | Draft PRD + task DAG, submit for approval |
| `$develop` | Claim tasks, implement, report work, submit for verification (includes multi-worker patterns) |
| `$review` | Admin: approve/reject proposals, verify tasks (includes reviewer-agent spawning) |
| `$quick-dev` | Skip Idea→Proposal flow for small tasks |
| `$yolo` | Full-auto AI-DLC pipeline from natural-language prompt to done |

## Subagents

- `chorus-proposal-reviewer` — read-only review of submitted proposals
- `chorus-task-reviewer` — read-only review of completed tasks (can run tests/builds in read-only shell)

Both are invoked by the main agent via `spawn_agent(agent_type=..., message=...)` and waited on via `wait_agent([id])`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chorus` not in `codex mcp list` | Did you run `install-codex.sh`? It writes `[mcp_servers.chorus]` into `~/.codex/config.toml`. |
| `chorus` is listed but tools don't work | URL or token wrong. Re-run `install-codex.sh` to update; the installer overwrites idempotently. |
| Plugin (`/plugins` menu) is empty | The `marketplace add` step didn't run. Re-run `install-codex.sh`, or manually `codex plugin marketplace add https://github.com/Chorus-AIDLC/Chorus`. |
| Skills don't show in `$<name>` autocomplete | Restart the Codex session. Skills are loaded at session start from `~/.codex/plugins/cache/chorus-plugins/chorus/*/skills/`. |
| Hooks don't fire | Check `grep '^hooks = true' ~/.codex/config.toml`, confirm the plugin is installed/enabled in `/plugins`, then open `/hooks` to review/trust Chorus plugin hooks. Re-run `install-codex.sh` to refresh MCP/plugin config. |
| Need to rotate API key | Just re-run `install-codex.sh` and enter the new key when prompted. |
