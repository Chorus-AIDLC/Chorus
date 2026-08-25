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

### One-command setup (recommended)

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
chorus agents add --agents codex
```

`chorus agents add`:

1. Verifies `codex` is installed
2. Registers the **chorus-plugins** marketplace (or upgrades it if already registered)
3. Installs the Chorus plugin through Codex's own plugin CLI, which writes `[mcp_servers.chorus]` + `[plugins."chorus@chorus-plugins"]` into `~/.codex/config.toml` (backed up once) and enables lifecycle hooks
4. Seeds your Chorus credentials once into `~/.chorus/daemon.json`

See [CONNECT_CODEX.md](../../docs/CONNECT_CODEX.md) for the full walkthrough. (The legacy `install-codex.sh` one-shot installer is retired to a stub that redirects here.)

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
npm install -g @chorus-aidlc/chorus@0.17.0
chorus agents add --agents codex \
  --url "https://chorus.example.com" \
  --api-key "cho_..." \
  --yes
```

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

The Codex port uses its native plugin hooks and built-in sub-agent roles rather
than mirroring Claude Code's Agent Teams implementation.

Consequences:

- Workers track progress through task status, work reports, acceptance-criteria
  self-checks, and verification.
- Reviewer skills are mounted into Codex's built-in `default` sub-agent role.
- There are no direct Codex equivalents for Claude Code's `TeammateIdle` and
  `TaskCompleted` events.

For single-agent use the UX is identical to the Claude version. Parallel work
is coordinated through `spawn_agent` and the task dependency DAG documented in
the `$develop` skill.

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
| `chorus` not in `codex mcp list` | Did you run `chorus agents add --agents codex`? It writes `[mcp_servers.chorus]` into `~/.codex/config.toml`. |
| `chorus` is listed but tools don't work | URL or token wrong. Re-run `chorus agents add --agents codex` to update; it overwrites idempotently. |
| Plugin (`/plugins` menu) is empty | The `marketplace add` step didn't run. Re-run `chorus agents add --agents codex`, or manually `codex plugin marketplace add https://github.com/Chorus-AIDLC/Chorus`. |
| Skills don't show in `$<name>` autocomplete | Restart the Codex session. Skills are loaded at session start from `~/.codex/plugins/cache/chorus-plugins/chorus/*/skills/`. |
| Hooks don't fire | Check `grep '^hooks = true' ~/.codex/config.toml`, confirm the plugin is installed/enabled in `/plugins`, then open `/hooks` to review/trust Chorus plugin hooks. Re-run `chorus agents add --agents codex` to refresh MCP/plugin config. |
| Need to rotate API key | Just re-run `chorus agents add --agents codex` and enter the new key when prompted. |
