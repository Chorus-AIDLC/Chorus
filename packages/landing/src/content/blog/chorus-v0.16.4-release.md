---
title: "Chorus v0.16.4: Hello DeepSeek Harness 🐳"
description: "DeepSeek's harness shipped a few days ago. Chorus already speaks it."
date: 2026-08-19
lang: en
postSlug: chorus-v0.16.4-release
---

# Chorus v0.16.4: Hello DeepSeek Harness 🐳

DeepSeek shipped its own agent harness a few days ago: DeepSeek Harness (dsh), open source, MIT. As of v0.16.4, Chorus officially supports it. dsh is now the sixth agent Chorus connects, sitting alongside Claude Code, Codex, Kiro, Pi, and OpenClaw, and it runs the same idea → proposal → execute → verify pipeline.

One apology up front: this release doesn't have dsh's daemon mode yet. The part where an agent wakes on its own to pick up an assigned task isn't ready, so for now you drive dsh interactively, keeping a session open and talking it forward. Daemon support lands in a later version.

## One command to make dsh a Chorus agent

dsh is built on Cordis, where everything is a plugin, so you connect it differently from the other agents: you install a package instead of copying a pile of files. We publish a public npm bundle, `@chorus-aidlc/chorus-dsh`. Add it to the dsh profile you want to use:

```bash
dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w
```

That one package carries everything: Chorus's 14 skills, the persona and instructions, and the MCP config. Write your credentials once, start the profile, and tell it to `check in to chorus`. It reports back its identity, permissions, and current tasks, like any other Chorus agent.

## Once it's in, it's just an agent

A connected dsh gets no special treatment. It runs the same pipeline start to finish: claim an idea, run elaboration, submit a proposal, get stopped at the reviewer, come back after fixing it. What you see in Chorus is still the same reversed conversation, AI proposes and a human verifies, with DeepSeek running underneath. You can have Claude Code write the plan and a DeepSeek agent take a few of the tasks, on the same pipeline, through the same verification gate.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@0.16.4
```

The full set of changes is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.4).

Questions and feedback are welcome at [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.16.4](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.4)
