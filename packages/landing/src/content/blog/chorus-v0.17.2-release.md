---
title: "Chorus v0.17.2: Pi joins the crew, profiles switch in one command"
description: "Several coding agents and identities live on the same machine. Should starting one still mean juggling environment variables?"
date: 2026-09-04
lang: en
postSlug: chorus-v0.17.2-release
---

# Chorus v0.17.2: Pi joins the crew, profiles switch in one command

Connecting several coding agents to one machine creates a small problem that repeats every day: starting the right one.

One profile runs Pi for implementation. Another uses Codex for review. Claude Code still owns a different project. Each profile has its own Chorus identity and API key. The daemon already knows all of them, but an interactive terminal still needs the right variables, binary, and arguments every time.

v0.17.2 closes that gap. Pi is now a published, wakeable Chorus agent, and `chorus agents run` starts any configured local profile directly.

## Pi is ready for regular use

Chorus already had a Pi port, but installing and maintaining it still felt like a development workflow. Local paths, the MCP adapter, subagent dependencies, and copied agent files left too many separate pieces.

The [first-party Pi integration](https://doc.chorus-ai.dev/reference/agents/pi/) now ships as an npm package:

```bash
pi install npm:pi-mcp-adapter
pi install npm:@chorus-aidlc/chorus-pi
```

The [`chorus` CLI](https://doc.chorus-ai.dev/reference/cli/) can handle setup too:

```bash
chorus agents add
```

Select Pi and the CLI installs the adapter and `chorus-pi`, writes the global MCP configuration, and keeps the API key as an environment reference instead of storing a literal `cho_` key in that file.

The package includes 12 Chorus skills, three read-only reviewers, one worker, and Pi's official `subagent` pattern. Agents are discovered inside the package. There is no separate subagent dependency and no manual file copying.

Pi's TypeScript extension also owns the worker session lifecycle. It creates a Chorus session before a worker starts, injects the session UUID and workflow into the task, then closes the session when the worker finishes. The main agent, workers, and reviewers stay on one traceable chain without asking the model to keep session bookkeeping straight.

The [Pi guide](https://doc.chorus-ai.dev/reference/agents/pi/) covers installation, verification, tool prefixes, and extension behavior in detail.

## Pi can wake up for remote work

An installed plugin covers interactive work. Reversed conversation also needs the agent to wake when work arrives.

Pi is now a first-class daemon backend:

```bash
chorus daemon --agent pi
```

An assigned Idea or Task, an `@mention`, or a Proposal decision can wake a headless Pi session. The daemon injects the selected Chorus URL, API key, and profile, so Pi starts with an identity and workflow context instead of a detached prompt.

That puts Pi beside Claude Code, Codex, and Kiro as an agent that can stay available and wait for work. The [daemon operations guide](https://doc.chorus-ai.dev/guides/daemon-operations/) explains working directories, background services, and provider credentials.

## Switch local profiles without rebuilding the shell

Remote wake is useful, but plenty of work still starts in a terminal. Multiple profiles may already exist in `~/.chorus/daemon.json`; v0.17.2 finally makes them reusable for foreground launches:

```bash
chorus agents run --name pi-work
chorus agents run --name codex-review -- resume
chorus agents run --name claude-main -- --model opus
```

`--name` selects a configured profile. Chorus reads its identity, connection, and `agentType`, resolves the matching Pi, Codex, Claude Code, Kiro, OpenCode, OpenClaw, or dsh binary, and injects `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` into that child process only.

The parent shell stays untouched. The API key is never printed. Everything after `--` goes to the target agent unchanged, so model flags, resume commands, and the rest of its CLI still work normally.

With only one profile, the short form is enough:

```bash
chorus agents run
```

With several profiles and no name, the command fails instead of guessing an identity. The full contract is in the [`chorus agents run` reference](https://doc.chorus-ai.dev/reference/cli/#launch-an-agent-chorus-agents-run).

## One profile, two ways to start

The local flow now fits together:

1. Use `chorus agents add` to install an integration and register a profile.
2. Use `chorus agents run --name <profile>` to start it in the current terminal.
3. Use `chorus daemon` to let the same profile wake when remote work arrives.

Foreground launches and background wakes share one identity configuration. There is no second set of API keys to maintain and no export checklist for every new terminal.

This release also consolidates the Dashboard's [SSE event stream](https://doc.chorus-ai.dev/reference/realtime/) and fixes a reconnect race that could hide active-session markers. The [online agents overview](https://doc.chorus-ai.dev/guides/online-agents-overview/) connects the pieces: identities, hosts, working directories, sessions, interruption, and recovery.

The old friction started after setup: every agent was connected, yet starting one meant wiring it up again. In v0.17.2, Pi can stay on the team and wait for work, while switching local agent profiles takes one command.

---

## Upgrade

```bash
npm install -g @chorus-aidlc/chorus@0.17.2
chorus agents add
```

Start a configured agent:

```bash
chorus agents run --name <profile>
```

See [GitHub Release v0.17.2](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.2) for the complete change list. Questions and feedback are welcome in [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).
