# Connect Claude Code to Chorus

This guide walks through connecting [Claude Code](https://claude.com/claude-code) to a running Chorus instance so Claude can call Chorus MCP tools (ideas, proposals, tasks, verify workflow, etc.).

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through the same steps interactively, including API-key creation. Use this doc if you prefer a reference you can read end-to-end or automate.

> **One command (recommended):** `chorus agents add` detects the coding agents installed on your machine, lets you pick which to configure, installs each one's Chorus plugin via that agent's own plugin CLI, and seeds your Chorus credentials once into `~/.chorus/daemon.json`. Non-interactive: `chorus agents add --agents claude,codex --url <url> --api-key <cho_...> --yes`. Step 2 below is exactly this; a manual in-TUI alternative is folded in after it.

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- `claude` CLI installed ([install instructions](https://docs.claude.com/en/docs/claude-code/setup))
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Provide your Chorus credentials

`chorus agents add` (Step 2) needs your Chorus **URL** and **API key**. Give them to it any one way — pass `--url` / `--api-key`, answer its interactive prompt, or export them for the current shell before running it:

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> **You do NOT need to persist these in `~/.bashrc` / `~/.zshrc`.** For a Claude Code agent, `chorus agents add` writes `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into the **user-global** `~/.claude/settings.json` `env` block. Claude Code injects that env at session start — before the MCP client connects — so **interactive Claude Code authenticates with no manual export** (the same env also reaches the plugin hooks and the `chorus` CLI). It is written only to the user-global file (never a project `.claude/settings.json`), stored `0600`, and the key is never printed.
>
> **Precedence:** `settings.json` `env` **overrides** your shell environment (Claude Code replaces the shell-inherited value at launch). So if you `export` a *different* `CHORUS_*` identity, interactive Claude Code still uses the configured one — `chorus agents add` prints a heads-up when it notices a different value already exported.
>
> **Multiple Claude Code identities:** the global `env` holds one identity. If you later add a *second* Claude Code agent, `chorus agents add` asks before repointing your interactive identity (and warns on a non-interactive run). If the write ever fails it prints exactly which keys to set so you can add them by hand.

> **Optional — `CHORUS_AGENT_PROFILE` for the CLI/hook path.** `chorus agents add` already sets this in `settings.json` for the identity it wrote, so you rarely need it. Set it manually only to make a shell's `chorus mcp` / hooks act as a *different* configured agent — it resolves that agent's key from `~/.chorus/daemon.json`, so you need not export the key:
>
> ```bash
> export CHORUS_AGENT_PROFILE="<agent-uuid>"   # a UUID or agentName that `chorus agents` lists
> ```
>
> Daemon-woken sessions set `CHORUS_AGENT_PROFILE` automatically.

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
