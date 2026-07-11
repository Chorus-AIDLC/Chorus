---
title: "Chorus v0.14.0: Chorus goes dark"
description: "Every other tool on your screen can go dark. Chorus was the one white slab left, and watching agents work at night wore your eyes out. Not anymore."
date: 2026-07-11
lang: en
postSlug: chorus-v0.14.0-release
---

# Chorus v0.14.0: Chorus goes dark

Every other tool on your screen can go dark. [Chorus](https://github.com/Chorus-AIDLC/Chorus) was the one white slab left, and watching agents work late at night wore your eyes out. v0.14.0 adds dark mode. The toggle sits at the bottom of the sidebar — light, dark, or follow system — and it's remembered per device.

![Chorus in dark mode: the project overview with the idea list on the left and an idea detail panel on the right](/images/dark-mode.png)

---

## Two more languages

An all-English UI is a wall for a lot of people. You can read it, but it never quite feels like yours.

v0.14.0 adds Korean and Japanese. With the existing English and Chinese, that's four. On first open the app picks a language from your browser — land on `ja` and you get Japanese — and after that it follows whatever you switch to.

Korean came from the community. [moduvoice](https://github.com/Chorus-AIDLC/Chorus/pull/411) opened a PR and translated the whole app. Huge thanks for bringing a Korean Chorus to the project.

## Reference material, where the work lives

There's always external material on the side while you work. An API doc, a repo you're borrowing from, a discussion buried in an issue, a blog post that finally explained some gotcha. Chorus had nowhere to put any of it. You pasted it into a comment, or kept it somewhere else and dug it back up later.

The community asked for this in [issue #399](https://github.com/Chorus-AIDLC/Chorus/issues/399). Now you can attach references to any idea, proposal, or task — right where the work already lives, there to read whenever you come back. The idea list shows how many each one carries. Agents can add and read them through MCP tools too, so what an agent finds doesn't vanish when the conversation ends.

---

Since the mind-map release in 0.13.0, two versions — 0.13.1 and 0.13.2 — never got their own post. Here's what piled up in between.

## Grouping ideas before you break them down

A project grows and its ideas sprawl. They sit in one flat list, and you can't tell which ones are pulling in the same direction. This release adds **themes**: an idea whose only job is to group. It gathers related ideas under one shared direction. A theme doesn't write its own proposal — the real work happens in the child ideas you derive from it — but it can elaborate, giving those children a shared backdrop.

## Daemon improvements

- **Hand off work straight from the UI**: the idea detail panel gains **Start Development** and **Yolo** buttons. The first moves an idea into development and wakes an agent to pick it up; the second hands the whole idea to an agent to run end to end. No dropping back to the command line.
- **Start an idea by talking**: the new-idea dialog has a conversational mode. Instead of writing up a tidy description first, you talk it through with an agent — the idea, its session, and the first instruction get created in one step.
- **Resume after a crash**: if a remote agent dies mid-run, the chat window and connection deck now offer a **Resume**. It wakes the agent again with a crash-specific note and continues from where it stopped. Works for both Claude Code and Codex.
- **No more phantom "online"**: stopping the daemon didn't always shut down cleanly — the process was gone but the server still showed it online. Now the daemon reports its outcome on exit, and the server reconciles the unfinished runs left dangling by a dead daemon. There's also `chorus daemon install`, which sets the daemon up as a background service that starts on boot and restarts if it crashes.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

After upgrading, the theme toggle is at the bottom of the sidebar, next to the language picker.

v0.14.0 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.14.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.0)
