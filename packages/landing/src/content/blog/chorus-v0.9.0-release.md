---
title: "Chorus v0.9.0: Give your ideas a beginning and an end"
description: "Pinned down on technical decisions before the idea is even shaped, then disbanded the moment it ships. This release patches both ends."
date: 2026-05-25
lang: en
postSlug: chorus-v0.9.0-release
---

# Chorus v0.9.0: Give your ideas a beginning and an end

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.9.0 is out. This release patches both ends of an idea: the front, by helping you think it through before committing; the back, by leaving a written summary once it's shipped.

---

## Help you think it through

Sometimes the idea in your head is still fuzzy — you haven't fully figured out what you want to build. If clarification opens with technical questions like "ISO 8601 or relative time?" or "Settings page or user-avatar dropdown?", it's easy to paper over the layer underneath, the part where you haven't decided whether this thing is even worth building. You follow the technical fork all the way down, and what you end up with may not be what you actually wanted.

Chorus's idea clarification has always been structured multiple-choice — every round is a 2-to-5-option question. That format is great for converging: every option is on the table, reviewable, diffable, and snaps directly into the proposal context once approved. But it assumes you already have a rough plan and just need to pick a path. Run it on an idea that hasn't gelled yet, and the real question gets buried.

[@obra](https://github.com/obra) figured this out a while back. His [superpowers](https://github.com/obra/superpowers) is a skill set for Claude Code, and one of its most popular skills is brainstorming: open-ended dialogue first to give the fuzzy idea a shape, structured work after. The same pattern slots cleanly into Chorus's clarification flow — diverge first, then converge.

v0.9.0 borrows the idea and adds an optional `brainstorm` skill that sits in front of clarification.

It runs in two steps.

Step one is divergent. The agent has an open-ended chat with the user — no options, no schema, just talking. "Who's mainly going to look at this?" "When would they look?" "Do you care about second-level precision or is minutes fine?" Until the user has a rough outline of what they actually want.

Step two is convergent. The skill condenses the conversation into one round of clarification — a 2-to-5-option multiple-choice question per decision point — calls `start_elaboration` + `answer_elaboration`, and hands control back to the idea skill.

When a user is clarifying an idea with the agent, the agent first decides whether the idea is still in the unshaped phase. If so, it proposes a brainstorm round; if the idea already has a clear direction, it goes straight into the more specific implementation questions like technical choices. No extra steps when none are needed.

---

## So you finished. Now what?

The front of the idea is patched. The other end has its own way of fraying.

Chorus accumulates a lot of decision and execution records. Agents can roll them up fast and get a sense of where a project is and what's inside it. But humans have always been missing one thing: a summary of how each idea actually landed. Open the Chorus UI, stare at a wall of projects and ideas, and there's no way to get the high-level read — did this thing actually get done? What got left undone? What were the key decisions in the end?

Everyone writes these summaries already, just somewhere else. In PR descriptions, on wikis, in Slack threads, in monthly reports. The problem is none of that lives in Chorus. Next person who opens the idea in Chorus sees none of it.

### Every shipped idea deserves a summary

v0.9.0 gives every idea a completion report. It has three fixed sections: what got done (Summary), what key decisions were made along the way (Decisions), and what's still open (Follow-ups).

When does the agent write it? It checks at three moments:

- During an end-to-end `/yolo` run, once every task on the idea is verified, the agent writes the report on its own as the closing step.
- During step-by-step `/develop` work, the agent gets prompted to write one after finishing the last task.
- Any time a proposal has all its tasks done but no report yet, the next task verification triggers a system reminder for the agent to fill it in.

Where do humans see it? On the idea detail page, under the Overview tab, below the timeline there's a new "Reports" list that aggregates every report under that idea's proposals, newest first. Click a row and the document panel slides in with the full text.

![Idea completion report](/images/idea-report.png)

---

## A few other things

**MCP tool surface trimmed.** From 80 down to 77. The three we cut are all same-shape duplicates: `chorus_pm_create_tasks` was already marked deprecated and identical to `chorus_create_tasks`; `chorus_add_task_dependency` and `chorus_remove_task_dependency` were already covered by `chorus_update_task` with `addDependsOn` / `removeDependsOn`. The wider the tool surface, the more often the model picks the wrong one, so cutting redundancy buys selection accuracy directly. This is the first slice of a multi-pass cleanup; more to come.

**Session lifecycle collapsed to two states.** `AgentSession` used to have three: active, inactive, closed. `inactive` was the auto-fallback after an hour with no heartbeat. Looking back, no caller actually cared about that middle state — "is this session fresh?" can be computed at query time. So this release shrinks the state machine to `{active, closed}` and turns freshness into a query predicate over `lastActiveAt`, with a default 1-hour window.

A nice side effect fell out of this: every MCP tool a session touches now refreshes `lastActiveAt` on success. Which means agents are extending their sessions automatically just by working — no separate heartbeat needed. `chorus_session_heartbeat` is still around for the rare case you want to extend explicitly. The `expiresAt` parameter on `chorus_create_session` (which nobody was using) got cleaned up too.

**Reviewer turn limits raised.** `proposal-reviewer` went from 40 to 100, `task-reviewer` from 50 to 100. Reviewers were running out of turns mid-review without producing a verdict, forcing manual respawns with bigger budgets. The frontmatter now gives them enough headroom to finish a single review pass. Codex doesn't have an equivalent frontmatter knob, so this change only covers the Claude Code plugin.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code plugin:

```bash
/plugin marketplace update chorus-plugins
```

Codex plugin: reinstall per the release docs.

Heads up: dropping `chorus_pm_create_tasks` / `chorus_add_task_dependency` / `chorus_remove_task_dependency` is a hard break with no deprecation window. If your scripts call these names directly, swap them for the equivalents above.

v0.9.0 is up on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.9.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.0)
