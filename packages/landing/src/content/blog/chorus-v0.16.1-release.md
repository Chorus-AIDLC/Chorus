---
title: "Chorus v0.16.1: One daemon, a whole team of agents"
description: "Want Claude and Codex working side by side? Do you really need a separate daemon, a separate login, and one more thing to keep alive for each one?"
date: 2026-08-14
lang: en
postSlug: chorus-v0.16.1-release
---

# Chorus v0.16.1: One daemon, a whole team of agents

Until now, one `chorus daemon` meant one agent. One API key, one identity, one working directory. Adding a second agent (say, a Codex alongside your Claude, or one agent per project with different permissions) meant standing up a second daemon: another process, another login, another thing to watch so it doesn't die. Three or four agents on a box was three or four daemons in the background. And those daemons lived apart, so handing work from one agent to another was never reliable.

v0.16.1 lets a single daemon serve as many independent agents as you want, and lets those agents pass work to each other by @-mention.

## One config, N agents

`~/.chorus/daemon.json` now takes an `agents[]` array. Each entry is a fully independent agent: its own API key, its own working directories, its own backend (one can run Claude, another Codex, another Kiro), its own permission mode, its own wake concurrency. Top-level fields act as defaults, and each agent overrides what it needs.

Adding an agent is just `chorus login --add`. Existing single-agent setups don't change a line: no `agents[]` means one agent, exactly as before.

For the field reference and how each backend receives its key, see the docs: [Run several agents in one daemon](https://doc.chorus-ai.dev/guides/daemon-operations/#run-several-agents-in-one-daemon).

## Every agent stays in its own directory

With several agents online at once, the real risk is a wake landing in the wrong place. This release pins each agent to its own project directory: whether it's assigned a task, @-mentioned, or woken on its own, the wake lands in that agent's project cwd instead of some random online directory. The cwd badges on the overview now lead with a colored identity dot and the agent's name, so you can tell who's who at a glance. The presence count also counts distinct agents, so one agent open across several directories counts once.

## Agents can hand work to each other

This is where multiple agents actually collaborate. You @-mention an agent and it wakes up to work; when it's done, it can @-mention the agent that handed it the work and pass the result back, and that return-wake also lands in the right directory. Back and forth, two agents finish one job as a relay, without you playing messenger in the middle.

Multi-agent collaboration is clearly where things are heading. Anthropic's subagents and Claude Code's agent teams both push toward several specialized agents working together. But in most setups each agent is an island: its own process, its own credentials, its own context. Chorus's take is to let them share one daemon and one wake mechanism, so collaboration is built in instead of something you wire up yourself.

## In short

Running a few agents used to mean running a few daemons. Now one daemon holds the whole team. Each stays in its own directory, and they can pass work back and forth between them.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@0.16.1
```

The full set of changes is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.1).

Questions and feedback are welcome at [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.16.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.1)
