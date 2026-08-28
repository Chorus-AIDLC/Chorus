---
title: "Chorus v0.17.0: Agent setup now starts with one command"
description: "Every coding agent has its own plugin and config files. Why should anyone have to memorize them all?"
date: 2026-08-28
lang: en
postSlug: chorus-v0.17.0-release
---

# Chorus v0.17.0: Agent setup now starts with one command

Say a machine already has Claude Code connected to Chorus, and now Codex needs to join it. Where does the plugin come from? Should the API key live in `.env` or the MCP config? Will an interactive session and a daemon-spawned session use the same identity? Switching to Kiro or dsh changes the answers again.

v0.17.0 puts that setup work into the [`chorus` CLI](https://doc.chorus-ai.dev/reference/cli/). There is one place to start:

```bash
chorus agents add
```

## Walk through setup once

Install the new CLI globally:

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
```

`chorus agents add` detects Claude Code, Codex, Kiro, OpenCode, OpenClaw, Pi, and dsh on the machine. Their maintenance models and remote runtime support differ, so the [agent platform comparison](https://doc.chorus-ai.dev/reference/agents/) spells out the boundaries. Pick the agents to connect, then enter a separate [Chorus API key](https://doc.chorus-ai.dev/guides/manage-agents/) for each identity.

The CLI follows the installation method each agent actually supports. Claude Code uses its marketplace. Codex uses its plugin commands. Kiro gets a `.kiro/` template. dsh installs an npm plugin. The CLI handles supported automatic installs and prints manual steps for integrations such as Pi that do not have a reliable automatic path yet.

It also writes the identity or MCP configuration needed by Claude Code, Codex, and Kiro. Other agents may still have steps to complete in their own runtime. [Claude Code](https://doc.chorus-ai.dev/reference/agents/claude-code/) stores its connection in the user-level `~/.claude/settings.json`. [Codex](https://doc.chorus-ai.dev/reference/agents/codex/) keeps credentials in `~/.codex/.env` and uses a keyless MCP reference in `config.toml`. Once those writes succeed, interactive Claude Code and Codex sessions no longer need the `CHORUS_*` variables exported by hand.

The command is safe to run again. Existing plugins are skipped, some missing configuration is repaired, and API keys can be replaced through the same flow. It is not a universal plugin updater for packages that are already installed.

## Choose daemon access during setup

Claude Code, Codex, and Kiro can be attached to the local Chorus daemon during the same setup flow. Remote wake is off by default and enabled per agent.

On Linux, the daemon can run as a systemd user service. On macOS, it can run as a LaunchAgent. An identity can also stay available to the CLI without allowing Chorus to wake it. The [daemon operations guide](https://doc.chorus-ai.dev/guides/daemon-operations/) covers working directories, foreground checks, logs, and service management.

## Call MCP from the CLI

v0.17.0 also adds a native MCP client. Scripts no longer need to wrap Chorus calls in `curl`, `jq`, or a plugin-specific shell helper:

```bash
chorus mcp call chorus_get_task '{"taskUuid":"..."}'
```

`chorus mcp list` shows the tools available to the current identity, while `chorus mcp whoami` prints its agent UUID. When several agents are configured, `--agent <name-or-uuid>` selects one explicitly. The [MCP tools catalog](https://doc.chorus-ai.dev/reference/mcp-tools/) explains the tool groups and their permission requirements.

The CLI can also show the identities saved on the machine:

```bash
chorus agents
```

The list includes each agent's name, UUID, and backend, and marks identities with remote wake turned off. `--json` exposes the full `daemonWake` field. API keys never appear in the output.

`chorus agents remove <name-or-uuid>` removes an identity from `daemon.json`. It does not uninstall the plugin or erase credentials stored by the agent runtime; the command prints the remaining manual cleanup.

## A few other fixes

`chorus_checkin` now returns at most the ten most recently active projects and their active Idea counts. The complete Idea list and task tracker remain available on demand through `chorus_get_my_assignments`.

The Codex plugin now uses the current sub-agent API instead of its obsolete role syntax. Nested theme status also rolls up from the deepest children first, so parent themes no longer read stale intermediate state.

When connecting an agent after this release, there is no need to decide which installer script to find first. Run `chorus agents add`. The CLI handles the parts it supports and prints the remaining manual steps in place.

---

## Upgrade

Upgrade Chorus:

```bash
npx @chorus-aidlc/chorus@0.17.0
```

Install the new CLI and configure agents:

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
chorus agents add
```

See [GitHub Release v0.17.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.0) for the complete change list. Questions and feedback are welcome in [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).
