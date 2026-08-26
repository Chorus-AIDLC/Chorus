---
name: chorus-cli
description: How to install, configure, and use the `chorus` CLI — install it, manage agents with `chorus agents` (add/remove/list), the connection environment variables, and MCP operations via `chorus mcp`. A concise shared reference for any flow that drives Chorus from the shell.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.17.0"
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

## 3. Connection environment variables

- `CHORUS_URL` — the Chorus instance URL.
- `CHORUS_API_KEY` — an agent API key (`cho_…`).
- `CHORUS_AGENT_PROFILE` — optional name or UUID of the agent to act as. When set, `chorus mcp`
  resolves that agent's key from `~/.chorus/daemon.json`, so you need not export
  `CHORUS_API_KEY` for the CLI path. Daemon-woken sessions receive it automatically. (dsh
  scrubs credential-shaped env from tool subprocesses; the dsh doc-mirror wrapper also reads
  `CHORUS_AGENT_PROFILE` / credentials from `$DSH_HOME/.env`.)

> **Claude Code:** `chorus agents add` writes these three vars into the user-global
> `~/.claude/settings.json` `env` block, which Claude Code injects at session start and which
> **overrides** the shell env — so interactive Claude Code (native MCP + hooks + this CLI)
> needs no manual `export`. Adding a second Claude Code identity prompts before repointing.

## 4. MCP operations — `chorus mcp`

Call any Chorus MCP tool from the shell — a byte-exact, token-free path for large content:

- `chorus mcp call <tool> ['<json>'] [--arg-file key=<file>] [--agent <name|uuid>]` — call a tool.
  `--arg-file content=<file>` streams a file's raw bytes into the JSON `content` string (no
  re-typing through the model). Identity resolves from `--agent` → `CHORUS_AGENT_PROFILE` →
  `CHORUS_URL`+`CHORUS_API_KEY` → a single configured agent.
- `chorus mcp whoami` — print this agent's own UUID.
- `chorus mcp list` — list the tools this agent may call.

Requires `chorus >= 0.17.0` (the `chorus mcp` subcommand). See `chorus mcp --help`.
