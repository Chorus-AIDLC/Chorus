---
title: "Chorus v0.14.1: Connect Amazon Kiro CLI"
description: "Your team moved to Kiro, but the collaboration platform only knew Claude Code and Codex. This release closes the gap."
date: 2026-07-16
lang: en
postSlug: chorus-v0.14.1-release
---

# Chorus v0.14.1: Connect Amazon Kiro CLI

v0.14.1 makes Amazon Kiro the fourth way to connect [Chorus](https://github.com/Chorus-AIDLC/Chorus). Until now it supported Claude Code, Codex, and OpenClaw — the AI-DLC flow from idea to proposal to execution never reached a Kiro user's terminal. Kiro works both as a local, interactive plugin and as a daemon backend that runs headlessly when a task is dispatched to it remotely. This release targets Kiro CLI v2; v3 changes the trust model, hooks, and agent format and still has a headless-execution gap, so it will be handled in a separate release.

## The plugin: one command to install

Kiro is unlike the other three. It doesn't use a packaged plugin — it reads loose `agents / skills / steering / settings` files under `~/.kiro/`. So what Chorus ships is a template tree, merged into your Kiro config directory by an installer:

```bash
export CHORUS_URL="https://your-chorus-instance"
export CHORUS_API_KEY="cho_..."
curl -fsSL "$CHORUS_URL/install-kiro.sh" | bash
```

The script is idempotent and safe to re-run. Once installed, Kiro gains:

- the Chorus remote MCP server;
- eight `chorus-*` workflow skills (`/chorus-idea`, `/chorus-proposal`, `/chorus-develop`, `/chorus-yolo`, and more);
- a `chorus` main agent that pre-loads those skills plus the Chorus steering context, spawns read-only reviewer subagents, and manages the session lifecycle automatically;
- three read-only reviewer subagents.

By default it installs globally to `~/.kiro/`, so one install works in every directory. Pass `--workspace` to install to a project-local `<cwd>/.kiro/` instead, for per-project isolation. The API key is interpolated at runtime through the `${env:CHORUS_API_KEY}` variable, so it's never written to disk.

To confirm the connection, type `/chorus-idea` in Kiro, or launch the main agent with `kiro-cli --agent chorus` (full session hooks wired in) and ask it to check in.

## The daemon backend: dispatch remotely, run headless locally

The plugin covers the case where you're sitting in front of Kiro developing. The other half is the Chorus daemon model: turn a machine into a resident agent runtime that wakes a local agent to handle each task dispatched to it.

This release adds a `--agent kiro` backend to the daemon, with wake, resume, interrupt, and transcript capture all wired through. Dispatch an idea from the Chorus web UI to a machine running Kiro, and it launches Kiro headlessly there to pick up the work — while you watch it run and interrupt it from the browser. The daemon now supports three backends: Claude Code, Codex, and Kiro.

## Other daemon improvements

Beyond Kiro, the daemon itself gets a few fixes:

- **Pin the working directory before waking**: waking a daemon-hosted agent used to default to the first daemon, not necessarily the machine or directory you meant. Now a cwd picker appears on wake and pins the assignee to a specific instance; the pin is hard, and `@mention` inherits an idea's existing pin.
- **Switching cwd or agent no longer forks the conversation**: changing an idea's working directory or agent used to leave a residual chat forked off, putting the interrupt button out of reach. Now the original conversation is re-pointed, and interrupt works from any thread.
- **Child-idea wake anchors to the child conversation**: waking a child idea used to light up the parent chat, and the approve note got dropped. Now the wake anchors to the child idea's own conversation, and the note is delivered inline.
- **`chorus daemon install` keeps its credentials**: systemd's `--user` service runs in a clean environment that strips `CHORUS_URL` / `CHORUS_API_KEY`, leaving a boot-started daemon unable to connect. The installer now persists and validates the credentials into `daemon.json`, and adds an interactive multi-cwd setup wizard.

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

v0.14.1 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.1) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.14.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.1)
