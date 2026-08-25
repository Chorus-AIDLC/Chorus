# Connect Claude Code to Chorus

This guide walks through connecting [Claude Code](https://claude.com/claude-code) to a running Chorus instance so Claude can call Chorus MCP tools (ideas, proposals, tasks, verify workflow, etc.).

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through the same steps interactively, including API-key creation. Use this doc if you prefer a reference you can read end-to-end or automate.

> **One command (recommended):** `chorus agents add` detects the coding agents installed on your machine, lets you pick which to configure, installs each one's Chorus plugin via that agent's own plugin CLI, and seeds your Chorus credentials once into `~/.chorus/daemon.json`. Non-interactive: `chorus agents add --agents claude,codex --url <url> --api-key <cho_...> --yes`. Step 2 below is exactly this; a manual in-TUI alternative is folded in after it.

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

> **Optional — pin this shell to a specific agent (`CHORUS_AGENT_PROFILE`).** Once
> `chorus agents add` has saved your agents into `~/.chorus/daemon.json`, you can name which
> agent this shell's Chorus hooks/skills act as, and the bundled `chorus mcp` client
> resolves that agent's key from `daemon.json` — no need to export its API key for the
> hook / doc-mirror path. `chorus agents add` prints the exact line at the end of a run; add it
> to your shell profile:
>
> ```bash
> export CHORUS_AGENT_PROFILE="<agent-uuid>"   # the UUID chorus agents add printed (agentName also works)
> ```
>
> This is most useful when several agents are configured on one machine (it disambiguates
> which identity a session acts as). It's additive — Claude Code's built-in MCP client
> still uses the `CHORUS_URL` / `CHORUS_API_KEY` from Step 1. Daemon-woken sessions set
> `CHORUS_AGENT_PROFILE` automatically.

## Step 2: Install the Chorus plugin

Install the Chorus CLI, then let `chorus agents add` install the plugin for Claude Code — it runs Claude Code's own `claude plugin` commands for you (registers the marketplace, installs `chorus@chorus-plugins`) and seeds your credentials:

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
chorus agents add --agents claude
```

`chorus agents add` reads `CHORUS_URL` / `CHORUS_API_KEY` from Step 1 (or prompts on a TTY); it is idempotent and safe to re-run.

<details><summary>Manual alternatives</summary>

`chorus agents add --agents claude` runs these for you; do it by hand only if you prefer to stay in the TUI:

```bash
claude
/plugin marketplace add Chorus-AIDLC/chorus
/plugin install chorus@chorus-plugins
```

Or load from a local clone (for development):

```bash
claude --plugin-dir public/chorus-plugin
```

</details>

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
