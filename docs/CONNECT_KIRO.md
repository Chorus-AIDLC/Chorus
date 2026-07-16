# Connect Kiro CLI to Chorus

This guide walks through connecting [Amazon Kiro CLI](https://kiro.dev/docs/cli) to a running Chorus instance. Kiro is the fourth Chorus plugin surface (alongside Claude Code, Codex, and OpenClaw). Unlike a packaged plugin, Kiro reads loose `.kiro/{agents,skills,steering,settings}` files, so the deliverable is a template tree merged into your Kiro config directory by a one-shot installer.

Once installed, Kiro gains:

- the Chorus remote MCP server (`chorus`),
- eight `chorus-*` workflow skills (`/chorus-idea`, `/chorus-proposal`, `/chorus-develop`, `/chorus-yolo`, `/chorus-review`, `/chorus-quick-dev`, `/chorus-brainstorm`, `/chorus-openspec-aware`),
- a `chorus` main agent that pre-loads those skills + the Chorus steering context, spawns read-only reviewer subagents, and automates session lifecycle (checkin on spawn, heartbeat/checkout on stop, reviewer nudges after workflow MCP calls),
- three read-only reviewer subagents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`).

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through API-key creation and the same connection steps interactively. Use this doc if you prefer a reference you can read end-to-end or automate.

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- Kiro CLI installed — the installer looks for `kiro-cli` (and falls back to `kiro`) in your `PATH`. See <https://kiro.dev/docs/cli>.
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` so they persist across shells. Kiro CLI interpolates `${env:CHORUS_API_KEY}` at runtime, so the key is **never written to disk** — it must stay exported in the shell you launch Kiro from. (The URL is written into `mcp.json` as a plain literal, since it is not a secret.)

## Step 2: Run the installer

```bash
curl -fsSL "$CHORUS_URL/install-kiro.sh" | bash
```

The script is idempotent and safe to re-run. It will:

1. Verify a Kiro CLI (`kiro-cli` or `kiro`) is installed.
2. Collect `CHORUS_URL` + `CHORUS_API_KEY` (from env, or prompt on a TTY) and normalize the URL to end in `/api/mcp`.
3. Install the Chorus skills, the `chorus` main agent + three reviewer subagents, and the Chorus steering doc into `~/.kiro/`.
4. Copy the session-automation hook scripts (+ `chorus-api.sh`) into `~/.kiro/chorus-bin/`, mark them executable, and resolve the hook command paths to absolute paths so they run regardless of the directory you launch Kiro from.
5. Merge the `chorus` MCP server into `~/.kiro/settings/mcp.json`, **preserving any MCP servers you already had** and backing up the original once to `mcp.json.chorus-bak`.

If `CHORUS_URL` / `CHORUS_API_KEY` aren't set, the installer prompts for them interactively (provided you have a TTY). With both exported it runs fully non-interactively.

### Global (default) vs `--workspace`

- **Global (default):** writes to `~/.kiro/`. Kiro's default agent auto-loads global skills, steering, and MCP config, so **one install works in every directory** — you only need `CHORUS_URL` / `CHORUS_API_KEY` in your shell.
- **Workspace-local:** pass `--workspace` to write to `<cwd>/.kiro/` instead. Kiro's workspace scope wins over global, so this is the isolated, project-local option (e.g. to pin a different API key per project via [direnv](https://direnv.net/)).

```bash
# project-local install
curl -fsSL "$CHORUS_URL/install-kiro.sh" | bash -s -- --workspace
```

## Step 3: Activate Chorus in Kiro (your manual verification step)

The installer only places files and merges JSON — it does not launch Kiro. Confirming the connection **live inside Kiro is your manual verification step** (no running Kiro is required to run the installer itself). Open Kiro and:

**Activate a workflow skill** — type a slash command:

```
/chorus-idea
```

(or `/chorus-proposal`, `/chorus-develop`, `/chorus-yolo`, `/chorus-review`, `/chorus-quick-dev`, …). Each `chorus-*` skill is also activated automatically when your prompt matches its description.

**Run the full-automation main agent** — launch with session hooks + reviewer subagents wired in:

```bash
kiro-cli --agent chorus
```

Then, to confirm the MCP server responds, ask it to:

```
check in to chorus
```

The `chorus` agent calls `chorus_checkin()` over MCP and reports back your agent identity, permissions, and recent activity. Its `agentSpawn` hook also runs this checkin automatically on launch.

## Non-interactive install (CI / sandboxed environments)

The installer runs fine without a TTY as long as both vars are in the environment:

```bash
CHORUS_URL=https://chorus.example.com \
CHORUS_API_KEY=cho_xxx \
  bash <(curl -fsSL https://chorus.example.com/install-kiro.sh)
```

## Troubleshooting

- **`No Kiro CLI found in PATH`** — Install Kiro CLI (<https://kiro.dev/docs/cli>). The installer accepts either `kiro-cli` or `kiro`.
- **`No TTY and CHORUS_API_KEY unset`** — Export `CHORUS_API_KEY` (create one under Settings → Agents) before running non-interactively.
- **`URL must start with http:// or https://`** — `CHORUS_URL` is missing the scheme. Use `http://` or `https://`.
- **`401 Unauthorized`** on check-in — API key wrong, revoked, or not exported in the shell that launched Kiro. Recreate under Settings → Agents, re-export `CHORUS_API_KEY`, and relaunch Kiro (re-running the installer is only needed if the URL changed).
- **Skills don't appear** — Kiro custom agents only load the skills listed in their `resources`; the `chorus` main agent lists all eight. For the default agent, global skills under `~/.kiro/skills/` load automatically. Confirm the files landed with `ls ~/.kiro/skills/`.
- **Merged the wrong server / want to revert `mcp.json`** — restore `~/.kiro/settings/mcp.json.chorus-bak`.

## Next

- Skill docs (tools reference): the standalone version is served as `/skill/chorus/SKILL.md` on your Chorus instance (from `public/skill/chorus/SKILL.md`); the platform overview also ships as `~/.kiro/steering/chorus.md`.
- Workflow overview: run `/chorus-idea` (or launch `kiro-cli --agent chorus`) inside Kiro.
- To connect Codex instead, see [CONNECT_CODEX.md](CONNECT_CODEX.md); Claude Code, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md).
- For any other MCP-capable agent (Cursor, Continue, custom, etc.), see [CONNECT_OTHER_AGENTS.md](CONNECT_OTHER_AGENTS.md)
