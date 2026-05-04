# Connect Claude Code to Chorus

This guide walks through connecting [Claude Code](https://claude.com/claude-code) to a running Chorus instance so Claude can call Chorus MCP tools (ideas, proposals, tasks, verify workflow, etc.).

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through the same steps interactively, including API-key creation. Use this doc if you prefer a reference you can read end-to-end or automate.

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- `claude` CLI installed ([install instructions](https://docs.claude.com/en/docs/claude-code/setup))
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` if you want them to persist across shells.

## Step 2: Install the Chorus plugin

The recommended path is the official Chorus plugin — it bundles hooks, skills, and auto-managed sessions on top of the raw MCP connection.

**From the plugin marketplace** (recommended):

```bash
claude
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

**From a local clone** (for development):

```bash
claude --plugin-dir public/chorus-plugin
```

That's it. On next launch, Claude will see Chorus MCP tools (`chorus_checkin`, `chorus_pm_*`, `chorus_claim_task`, …) and the workflow slash commands (`/chorus`, `/chorus:develop`, `/chorus:proposal`, `/chorus:yolo`, etc.).

## Step 3: Verify the connection

Inside Claude Code, type:

```
check in to chorus
```

Claude will call `chorus_checkin()` and report back with your agent identity, permissions, and recent activity.

## Troubleshooting

- **`401 Unauthorized`** — API key wrong or revoked. Recreate under Settings → Agents.
- **`404` or `connection refused`** — `CHORUS_URL` points to an unreachable host. Curl it: `curl "$CHORUS_URL/api/mcp"` should return a JSON error, not a network error.
- **Tools don't appear** — Restart Claude Code after installing the plugin. Check `/plugin list`.

## Next

- Skill docs (tools reference): `public/chorus-plugin/skills/chorus/SKILL.md` (served as `/skill/chorus/SKILL.md` on your Chorus instance)
- Workflow overview: run `/chorus` inside Claude Code
- To connect Codex instead, see [CONNECT_CODEX.md](CONNECT_CODEX.md)
- For any other MCP-capable agent (Cursor, Continue, custom, etc.), see [CONNECT_OTHER_AGENTS.md](CONNECT_OTHER_AGENTS.md)
