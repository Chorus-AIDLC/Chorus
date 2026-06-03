# Connect Codex to Chorus

This guide walks through connecting the [Codex CLI](https://github.com/openai/codex) to a running Chorus instance. Codex has its own standalone Chorus plugin (under `plugins/chorus`, published via `.agents/plugins/marketplace.json`) — a separate package from the Claude Code plugin, with its own set of skills and supported features. A one-shot installer takes care of wiring it into Codex's `~/.codex/config.toml`.

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through the same steps interactively, including API-key creation. Use this doc if you prefer a reference you can read end-to-end or automate.

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- `codex` CLI installed (`npm i -g @openai/codex`)
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` if you want them to persist across shells.

## Step 2: Run the installer

```bash
curl -fsSL "$CHORUS_URL/install-codex.sh" | bash
```

The script is idempotent and safe to re-run. It will:

1. Verify `codex` is installed.
2. Register the `chorus-plugins` marketplace (or upgrade it if already registered).
3. Write `[mcp_servers.chorus]` and `[plugins."chorus@chorus-plugins"]` into `~/.codex/config.toml` (mode `600`, backing up your original once to `config.toml.chorus-bak`).
4. Enable Codex lifecycle hooks with `[features] hooks = true`. Chorus hooks are bundled in the plugin and load automatically after the plugin is installed/enabled.

If `CHORUS_URL` / `CHORUS_API_KEY` aren't set, the installer will prompt for them interactively (provided you have a TTY).

## Step 3: Verify the connection

Open Codex and type:

```
check in to chorus
```

Codex will call `chorus_checkin()` via the MCP server and report back with your agent identity, permissions, and recent activity. The Chorus workflow skills (`$chorus`, `$develop`, `$proposal`, `$yolo`, etc.) are also available.

## Non-interactive install (CI / sandboxed environments)

The installer runs fine without a TTY as long as both vars are in the environment:

```bash
CHORUS_URL=https://chorus.example.com \
CHORUS_API_KEY=cho_xxx \
  bash <(curl -fsSL https://chorus.example.com/install-codex.sh)
```

## Troubleshooting

- **`codex not found in PATH`** — Install it: `npm i -g @openai/codex`.
- **`401 Unauthorized`** on `check in` — API key wrong or revoked. Recreate under Settings → Agents, then re-run the installer (or edit the `Authorization` line in `config.toml`).
- **`URL must start with http:// or https://`** — `CHORUS_URL` missing the scheme. Use `http://` or `https://`.
- **Marketplace source conflict** — You previously registered `chorus-plugins` from a different URL. The installer detects this and auto-re-registers; check the `!` warnings it prints.
- **Hook didn't fire on first launch** — Open `/plugins` inside Codex and confirm `chorus@chorus-plugins` is installed/enabled, then open `/hooks` to review/trust the bundled Chorus hooks. Hooks run after the plugin cache is materialized.

## Next

- Skill docs (tools reference): `plugins/chorus/skills/chorus/SKILL.md` (the standalone version served as `/skill/chorus/SKILL.md` on your Chorus instance comes from `public/skill/chorus/SKILL.md`)
- Workflow overview: run `$chorus` inside Codex
- To connect Claude Code instead, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md)
- For any other MCP-capable agent (Cursor, Continue, custom, etc.), see [CONNECT_OTHER_AGENTS.md](CONNECT_OTHER_AGENTS.md)
