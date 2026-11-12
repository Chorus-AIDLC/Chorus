---
name: chorus-cli
description: How to install, configure, and use the `chorus` CLI — install it, manage agents with `chorus agents` (add/remove/list), the connection environment variables, and MCP operations via `chorus mcp`. A concise shared reference for any flow that drives Chorus from the shell.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.24.0"
  category: project-management
  mcp_server: chorus
---

# chorus-cli — using the `chorus` CLI

`chorus` (published as `@chorus-aidlc/chorus`) is the one command that configures this
machine's coding agents for Chorus and talks to the Chorus MCP endpoint from the shell.
This is a concise reference — run `chorus --help` and `chorus <command> --help` for the
full flag surface.

## 1. Install

```bash
npm install -g @chorus-aidlc/chorus       # unpinned — always installs the latest
chorus --version                          # must be >= 0.17.0 (provides `chorus agents` + `chorus mcp`)
```

## 2. Configure agents — `chorus agents`

Agent configuration lives in `~/.chorus/daemon.json`; `chorus agents` is the CRUD group:

- `chorus agents` (or `chorus agents list`) — list configured agents (name, UUID, backend).
  The API key is never printed; the agent named by `CHORUS_AGENT_PROFILE` is marked.
- `chorus agents add [--agents <ids>] [--all] [--url <u>] [--api-key <cho_…>] [--yes] [--dsh-profile <name>]`
  — detect installed coding agents, install each one's Chorus plugin, and seed credentials
  (this is the former `chorus init`). Idempotent; safe to re-run. `--help` lists every flag.
- `chorus agents remove <name|uuid>` — remove a configured agent from `~/.chorus/daemon.json`
  (matched by UUID or name; an ambiguous name → use the UUID).

- `chorus agents run --name <name|uuid> [--type <type>] [--idea <uuid>] [--no-sync] [--] [agent args…]` — launch a
  configured agent's binary in the FOREGROUND with its Chorus connection injected into the
  child only (`CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`; nothing is exported to
  the parent shell, and the key is never printed). Agent selection: single agent by default; else `--name`, else `CHORUS_AGENT_PROFILE`; ambiguous/none →
  error. Backend defaults to the agent's stored `agentType`, overridable with `--type`.
  Everything after `--` is passed to the agent **verbatim** (never inspected). Type → binary:
  `claude-code`/`claude`→`claude`, `codex`→`codex`, `trae`→`traecli`, `kiro`→`kiro-cli`, `pi`→`pi`,
  `opencode`→`opencode`, `openclaw`→`openclaw`, `dsh`→`dsh-jsonrpc-agent`. Agents added as
  opencode/openclaw/dsh are stored as `offline` → pass `--type` explicitly to launch them.

  **Session sync (default on).** Each run is registered as a Chorus daemon conversation for
  that agent: the user/assistant text (no tool calls or thinking) appears live in Chorus
  (Kiro uploads on exit). While the terminal run is active the conversation shows
  "Running in terminal", and messages sent from Chorus are **queued**, never injected into
  the TUI. When the run exits (or dies — the server lease expires within ~60 s), the local
  `chorus daemon` serving the **same machine + directory** resumes the SAME backend
  conversation and answers the queued messages. No daemon running there → one warning line
  at launch; the session becomes continuable once a daemon starts in that directory.
  - `--idea <uuid>` anchors the conversation to an Idea (default: ad-hoc).
  - `--no-sync` registers nothing (zero Chorus session calls) — the plain foreground launch.
  - Claude Code / Pi get a derived session id injected; passing your own session flag
    after `--` (e.g. `--session-id`, `--resume`, `--continue`) keeps the run visible but not
    continuable. Codex / TRAE / Kiro ids are discovered after launch. opencode / openclaw /
    dsh are visible only (not continuable).
  - Sync never blocks the agent: problems print at most one warning line; details go to
    `~/.chorus/logs/cli-session-sync.log` (the API key is never logged).

## 3. Connection environment variables

- `CHORUS_URL` — the Chorus instance URL.
- `CHORUS_API_KEY` — an agent API key (`cho_…`).
- `CHORUS_AGENT_PROFILE` — optional name or UUID of the agent to act as. When set, `chorus mcp`
  resolves that agent's key from `~/.chorus/daemon.json`, so you need not export
  `CHORUS_API_KEY` for the CLI path. Daemon-woken sessions receive it automatically.

## 4. MCP operations — `chorus mcp`

Call any Chorus MCP tool from the shell — a byte-exact, token-free path for large content:

- `chorus mcp call <tool> ['<json>'] [--arg-file key=<file>] [--agent <name|uuid>]` — call a tool.
  `--arg-file content=<file>` streams a file's raw bytes into the JSON `content` string (no
  re-typing through the model). Identity resolves from `--agent` → `CHORUS_AGENT_PROFILE` →
  `CHORUS_URL`+`CHORUS_API_KEY` → a single configured agent.
- `chorus mcp whoami` — print this agent's own UUID.
- `chorus mcp list` — list the tools this agent may call.

Requires `chorus >= 0.17.0` (the `chorus mcp` subcommand). See `chorus mcp --help`.
