---
title: "Chorus v0.12.0: Wake a Remote Claude Code, Hit Exactly the Right One"
description: "One daemon watches one directory. But your code lives in three repos across two machines. When a task lands, you don't get to say where it runs."
date: 2026-06-27
lang: en
postSlug: chorus-v0.12.0-release
---

# Chorus v0.12.0: Wake a Remote Claude Code, Hit Exactly the Right One

v0.11.0 gave you the daemon. One command, and your machine becomes a resident agent runtime: the server dispatches work, and the daemon picks it up and runs it locally.

It works. But you hit a wall fast: the daemon watches one directory, and your work isn't in one directory.

You have more than one repo — frontend, backend, maybe an infra repo too. You start a daemon in the frontend directory, a backend task comes in, and it spawns a Claude in the frontend directory. Wrong place. So you start one daemon per repo instead. That's worse. All those daemons log in as the same agent identity, the server sees them all as "online," and a dispatched task goes to whoever grabs it first. You have no way to say "this task, run it in the backend directory." Add a workstation, with daemons on both the laptop and the workstation, and now you really can't tell them apart.

The agent is online, but you can't aim it. [Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.12.0 turns every `(agent, host, cwd)` into an instance you can see and target on its own. One daemon can watch several directories. Pin an instance once on an idea, and its proposals and tasks follow along. Where a task runs — which machine, which directory — is finally yours to decide.

---

## One daemon, several directories

A daemon used to watch a single directory. Now you list the ones you want when you start it:

```bash
chorus daemon --cwd ~/work/frontend --cwd ~/work/backend --cwd ~/work/infra
```

Don't want it on the command line? `CHORUS_DAEMON_CWDS` or `~/.chorus/daemon.json` work the same way. Each directory is its own connection. A task dispatched to a directory spawns a Claude in that directory, and the connections don't cross.

The directories are isolated, and that matters. A conversation started in one directory only resumes there — try to `--resume` it from another directory and it's rejected, not quietly picked up somewhere else. Otherwise you get the worst kind of bug: you think it's editing code in repo A, and it's actually changing repo B.

## Dispatch a task to a specific directory

Once there are several directories, "this agent is online" isn't enough. You need to see which directories it's online in, so you can send the task to the right one.

That online-agent pill in the sidebar now opens into a collapsible card that drills down to one row per online directory. The list shows online instances only — offline ones, and the legacy v0.11.0 connections that carry no directory info, don't appear. If an agent has no online instance at all, it doesn't show up either. What you see is what can actually take work right now.

@-mention, task assignment, a quick ad-hoc message — they all use the same picker. One instance online, and it's selected automatically. Two or more, and you pick. Whichever directory you choose is where the task runs.

You don't have to sit and wait after dispatching. Open the conversation and watch the remote Claude pick up the work and step through it, live.

![Assign an idea to a directory on a remote agent, then open the conversation to watch it work](/images/agent-daemon-wake.gif)

## Pin once on the idea, inherit downstream

Once you can pick a specific instance, the next annoyance shows up: do you have to re-pick the directory for every task? An idea with seven or eight tasks under it, pinned one by one, gets old.

So this release makes the idea the root for that pin. Pin an instance once on the idea, and the proposals, tasks, and wakes under it follow that pin — as long as it's the same agent — with no re-pinning. An `(agent, host, cwd)` is now something you can assign directly, alongside a user or an agent, a third kind of assignee.

There are soft pins and hard pins. Assignment is a soft pin: if the pinned instance is offline, it falls back to another online instance of the same agent, so the work doesn't stall. An @-mention is a hard pin: if the instance is offline, it just files a notification and doesn't wake anything. You named that instance — if it's not around, it waits for it, rather than swapping in a different one.

The REST claim routes and `chorus_pm_assign_task` take an optional `instanceUuid` — pass it to pin precisely, leave it off for a plain assignment that inherits the idea's pin at wake time.

## Pin one, wake only that one

Getting the instance right on the server still isn't enough. In v0.11.0, a wake from a task dispatch or an @-mention was an SSE event broadcast to every connection under the agent. That fights with pinning to a specific instance: you pinned the backend directory, the broadcast goes out, the frontend directory's instance hears it too, and whoever `--resume`s first wins. The pin may as well not exist.

This release makes pinned wakes a directed delivery. The server sends a `deliver_turn` to just the one online connection it resolved, and that machine's directory takes the turn. Every other connection sees the broadcast, recognizes it isn't theirs, and ignores it. Pinned `mentioned`, `task_assigned`, and the proposal-writing wake triggered by "Verify Elaborate" all go through this directed channel. If the instance is offline, it notifies without waking — which lines up with the hard-pin rule above.

There's also a small but nasty case. A conversation starts in some directory, and partway through, that directory's daemon goes offline. The conversation used to be dead — no way to continue it. Now, as long as the agent has another online instance, you can move the conversation there and keep going. The `sessionId` stays the same; it's still the same conversation, just running from a different spot.

---

Back to where we started. Same agent, two machines, three repos — where does the work go? Now one daemon can watch all those directories, you pin once on the idea, the proposals and tasks under it land in the right directory, and a pinned wake reaches exactly that instance instead of whoever grabbed it first. The agent isn't just online. You can aim it.

## Also fixed

- **Comment @-mentions of agents are now live status badges**: a name with an online dot, a click-through identity card (with directory and host for a pinned mention), and — for the owner, while the agent is online — a one-click jump into the daemon chat.
- **Comments switched to cursor-based infinite scroll**: the first paint loads only the newest page; scroll down to pull older ones. Live new comments merge in deduped by uuid instead of reloading the whole list, so your scroll position and already-loaded comments survive.
- **`chorus daemon` now shuts down gracefully**: the server's signal handlers used to be registered unconditionally and pre-empt the daemon's own graceful stop, so the daemon was killed before it disconnected cleanly (leaving stale presence). Those handlers are now scoped to the server launch path.
- **A batch of mobile and picker fixes**: the instance picker's second directory was unselectable, the assign-task and assign-idea modals overflowed short mobile viewports, and the @-mention directory picker's footer was unreachable under a soft keyboard.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Start a daemon with the directories you want it to watch:

```bash
chorus daemon --cwd ~/work/frontend --cwd ~/work/backend
```

The daemon currently supports Claude Code as the local agent backend; other CLIs like Codex are in the works.

This release ships four DDL migrations (a cwd column on the daemon connection, a new `AgentInstance` table and FK, and dropping the two temporary pin columns on Task). No data migration — run `prisma migrate` once.

v0.12.0 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.12.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.12.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.12.0)
