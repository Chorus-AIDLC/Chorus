---
title: "Chorus v0.6.0: Your Agent Team Just Got a Foreman"
description: "v0.6.0 ships independent Review Agents, real-time Presence, and IdeaTracker. When 5 agents work in parallel, humans finally stop flying blind."
date: 2026-04-09
lang: en
postSlug: chorus-v0.6.0-release
---

# Chorus v0.6.0: Your Agent Team Just Got a Foreman

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.0 is out!

> Three questions this release answers: who reviews the agents' work? What are agents doing right now? And what does the full picture look like from idea to delivery?

---

## Review Agents: Set a Thief to Catch a Thief

"AI proposes, humans verify" sounds great — until you're running five Dev Agents in parallel.

Five agents pushing code and proposals at the same time, one human reviewer trying to keep up. It doesn't work. Worse, agents love to sneak in questionable technical decisions — API contracts that don't match upstream, dependency graphs drawn backwards, acceptance criteria vague enough to pass anything. You won't catch these without reading every line. That's where all the human energy goes.

So v0.6.0 introduces adversarial review. Two independent Review Agents — **proposal-reviewer** and **task-reviewer** — run as Claude Code plugin agents, automatically stepping in when a Proposal is submitted or a Task is marked complete. Their job is to stand between the dev agent and the human: catch bad technical decisions, verify acceptance criteria, and make sure agents fix their own problems within a bounded number of rounds. By the time work reaches a human, it's already survived a round of adversarial scrutiny. The human makes the final call, not the first pass.

![Review Agents in Claude Code](/images/review-agents.png)

### Beyond pass/fail

The early prototype used binary verdicts. It was terrible — either too lenient and rubber-stamped everything, or too strict and bounced work endlessly. v0.6.0 uses three tiers: approve (ship it), revise (send it back with specific findings), and escalate (flag it for a human decision).

Revise is the one that matters. The reviewer can't just say "no" — it has to say what's wrong and how to fix it. Every finding is classified as `must_fix`, `should_fix`, or `nit`. Dev agents only address `must_fix`, so they don't spiral into infinite revision loops.

### Guaranteed convergence

An unbounded review loop is a disaster — reviewer and dev playing ping-pong until the tokens run out. v0.6.0 puts a hard cap on it: 3 rounds of review-revise per task, max. If it's still not passing after 3 rounds, it auto-escalates to a human. In subsequent rounds, the reviewer only checks whether the previous `must_fix` findings were addressed — no introducing new issues. The loop always terminates.

### Don't want it? Turn it off

Review Agents are controlled by a userConfig toggle. Run just the task-reviewer, just the proposal-reviewer, both, or neither. For quick prototypes where you'd rather review everything yourself, skip it entirely. No judgment.

---

## God Mode: Is Your Agent Slacking Off?

Five agents working at once — what do you actually see when you open Chorus? Before this release, the answer was: a bunch of pages suddenly reloading. Any agent submitting progress triggered a full-page refresh for everyone. That proposal detail page you were reading? Gone. Reload.

That experience was awful. v0.6.0 rebuilds the real-time system from scratch.

### Surgical refreshes, not full reloads

Agent updates Task #42? Only the Task #42 card re-renders. The proposal detail page you're reading doesn't flinch. Events route to individual entities, not the whole page. There's also toast notifications now — agent finishes a task, submits a review, creates a proposal, you get a pop-up in the corner. No need to stare at the board.

### Presence Indicator

The most visceral feature in this release. When an agent is working on a Task or Proposal, the card lights up with a real-time highlight border — solid line means it's actively working (writing code, submitting review), dashed line means it's just looking (reading code, analyzing context). Who's changing what, who's just watching — obvious at a glance.

![Kanban Presence](/images/kanban-presence.gif)

Same thing on the Proposal detail page. When an agent is building a Proposal — adding document drafts, splitting tasks, editing the dependency graph — you see the presence indicator in real time:

![Proposal Presence](/images/proposal-presence.gif)

### Kanban animations

Cards moving across columns now animate smoothly (Framer Motion layoutId). When multiple agents are pushing tasks forward simultaneously, you can actually track each card's trajectory instead of staring at a board that just rearranges itself.

---

## The Life of a Feature Request

The old project overview page was a handful of numbers and charts. Glance and leave. The problem: a requirement goes through elaboration, proposal, task breakdown, execution, and verification — spread across four or five different pages. You want to know "where is this requirement at?" and you have to piece it together in your head.

v0.6.0 replaces the project overview with IdeaTracker — every Idea's full journey from inception to delivery, compressed into a single panel.

Click any Idea, and a detail panel opens on the right. The Overview tab shows the complete lifecycle timeline — creation, elaboration Q&A, proposal approval, task execution progress. Where this requirement stands, at a glance:

![IdeaTracker Overview — Lifecycle timeline](/images/idea-tracker-overview.png)

Switch to the Proposal tab: split view. Left side renders the PRD document inline, right side shows the linked Proposal, Documents, and Task status. No jumping to the Proposals page and back:

![IdeaTracker Proposal — Document and plan side by side](/images/idea-tracker-document.png)

The Tasks tab, same split layout. Left side: individual task detail — description, dependencies, acceptance criteria. Right side: all tasks under this Idea with their status. Jump straight to Kanban from here:

![IdeaTracker Tasks — Task detail and progress tracking](/images/idea-tracker-task.png)

![IdeaTracker full demo](/images/idea-tracker.gif)

### Deep Links — A Shared Coordinate System for Humans and Agents

Every Idea detail panel has its own URL, like `projects/{uuid}/ideas?idea={uuid}&tab=execution`. Drop the link to a colleague and they land right on the execution view. No hunting.

But the real payoff is that this URL structure works just as well for agents. @mention a Dev Agent in a comment with a deep link, and it instantly knows which Idea you're looking at, which Task is stuck, what the acceptance criteria say — no need to re-explain context in natural language. It works the other way too — agents include deep links in their work reports, and humans click straight into the detail panel to review.

Five agents and three humans working on the same project. Deep links are the shortest path to shared context — whether you're carbon-based or silicon-based.

---

## Other Changes

Ideas now have global lifecycle tracking from creation to the last task being done. Previously, Idea status was isolated — you had to count finished tasks yourself. IdeaTracker now aggregates progress across elaboration, proposal, and task stages into a single completion metric from idea to delivery.

MCP session idle timeout is gone. It used to disconnect after 30 minutes of inactivity, which was hostile to always-on agents. Now sessions only close when the client explicitly disconnects.

Full changelog at [CHANGELOG](https://github.com/Chorus-AIDLC/Chorus/blob/main/CHANGELOG.md).

---

## Get Started

v0.6.0 is live on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.0). Docker users: pull the latest image. New to Chorus? Check the Quick Start in the README.

If you're on Claude Code, install the [Chorus Plugin](https://github.com/Chorus-AIDLC/Chorus/tree/main/public/chorus-plugin) to enable Review Agents and session automation — no changes to your existing workflow.

Questions or feedback? Open a [GitHub Issue](https://github.com/Chorus-AIDLC/Chorus/issues) or join the [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.0)
