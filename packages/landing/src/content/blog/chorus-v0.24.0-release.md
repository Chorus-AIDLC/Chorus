---
title: "Chorus v0.24.0: Your agents are finally a team"
description: "You handed the review to a different agent. It showed up carrying the memory of writing the code. Different agent, same head."
date: 2026-11-05
lang: en
postSlug: chorus-v0.24.0-release
---

# Chorus v0.24.0: Your agents are finally a team

Connect three or four agents to Chorus and in practice one of them still does everything. It writes the proposal, writes the code, then reviews the code it just wrote. The "independent review" is a sub-agent spawned inside that same session, handed its task prompt by the author, so it tends to miss whatever the author missed.

Splitting the work means dispatching it yourself. Who is free. Who holds the right permissions. Who reviewed round one, because round two should go to the same agent. You make those calls again every time.

Then there is a subtler one. Even when the review does go to a different agent, if that agent is also the developer on this line of work, it reviews with the full development memory. Different agent, same head.

v0.24.0 turns the team into a piece of configuration. Set the roles once, bind them to a project, let a tool tell you who should take the work, and run reviews in sessions of their own.

## A team routes work. It grants nothing.

Build a team by role under **Agent teams** in Settings. There are four: product, development, review, and lead. One agent can hold several of them, and an empty team is a valid team. Then bind it to a project in the **Team** tab of Project Settings.

The two notices in that panel are not legal boilerplate. They are the boundary of the feature. Saving a team dispatches no work. The configuration is readable only by you and your agents, and a role grants no permissions and no project access. A team decides exactly one thing: who does what.

So "can this agent take this role's work" is computed, not checked off. The agent has to be yours, hold the permissions that role needs, and have collaboration access on the project. Members who fall short stay in the role list with the reason shown; nothing is silently dropped. Online status and current load are listed separately, because offline does not mean ineligible. It just means busy or not.

A Viewer can open and save their own team configuration, but adding members to a role and handing off an Idea both need project Editor access. The per-role permission requirements, how to read member status, and how to unbind all live in [Organize your agents into a Team](https://doc.chorus-ai.dev/guides/agent-teams/).

## Who orchestrates the line

Once a team is bound, assign an Idea to one of your own agents and that line is Team-managed. The assignee is its orchestrator. It does not have to be the lead. When one of your agents opens a child Idea under a managed parent, that child is managed too.

The managed state is not stored in any table. It is computed at read time. The server looks at who assigned the Idea to whom, who owns the assigned agent, which team that person bound on this project, plus the Idea's lineage and activity trail. No new tables, no migration, nothing to backfill when you upgrade.

A team does not change who may approve or verify. The server gates are the same as before: approval checks `proposal:admin`, verification checks `task:admin`, and no team gate was added on top.

What changes is what the orchestrator is supposed to do. A task waits for a current-round PASS or PASS WITH NOTES and all required acceptance criteria before the orchestrator closes it out. A proposal it may approve itself only when a human turned on YOLO for that Idea; without YOLO it posts a comment after PASS, @mentions the human, and keeps its hands off the button.

## Ask who before you dispatch

The orchestrator does not guess who to pick. It asks `chorus_recommend_team_agent`.

Ineligible candidates drop out first, then offline ones. Among the rest it prefers whoever posted the VERDICT last round, and failing that, whoever is least loaded. On a genuine tie it does not decide for you: it returns `lead_decision` and the orchestrator picks from the candidates.

The other three outcomes mean what they say. `recommended` you just use. `paused` means stop and find a human. `manual` means this line cannot be routed automatically, so dispatch by hand.

If the recommendation is the orchestrator itself, it claims the task and starts in the same turn. Assigning a task to yourself sends no wake.

Review requests go through `chorus_request_review`. The server composes the body and wakes only that one reviewer into its review session. A hand-written comment opens no review session at all.

The reviewer stays read-only and posts exactly one VERDICT comment per round, with exactly one @mention: whoever has to act next. Three rounds per entity, maximum.

Worth knowing: review recommendation excludes nobody, so the agent that wrote the code can be handed back its own work. And when the review role is empty or everyone in it is offline, the tool falls back to the orchestrator and has it run the matching reviewer sub-agent that turn. That fallback is a deliberate way to degrade rather than stall. It is not the normal path.

## The agent reviewing your code should not remember writing it

The root cause sat in the daemon. One key was doing two jobs. It was the business key of the Chorus session and the lane in the wake queue, and that key was the agent's direct Idea. So when a review wake arrived, what came back was the development session.

Now the server picks a session anchor based on what the wake is for. Idea-level work stays on the Idea anchor: assignment, elaboration, proposal authoring, orchestration handoffs, and the instructions you send in the Idea conversation.

A task wake goes to `task:<taskUuid>` for the task's current assignee. When that assignee is also the orchestrator, only assignment and reopen use the task anchor and everything else stays in its Idea conversation. Team review requests go to `review:task|proposal|idea:<uuid>`. The server delivers the anchor along with the wake, and the daemon uses it as both the queue lane and the backend session anchor.

With that split, a review wake no longer resumes a development session, and the first review of any target starts fresh. When the same reviewer looks at the same target again, it resumes its own review session instead.

## And one agent can now push two tasks at once

That single lane had a second side effect. Every wake for one agent on one Idea queued up in it, so tasks with nothing to do with each other ran one after another. With the anchors split, different anchors run concurrently, bounded by the agent's existing `maxConcurrency`.

You can see it in the UI. Tasks and reviews are now child conversations under their Idea's conversation, labelled "Task: title" and "Review: title", each with its own transcript, run state, and interrupt/resume controls. Instructions still go in the Idea conversation.

This covers the Chorus CLI daemon path. Native routing in OpenClaw, Hermes, and dsh is unchanged and still keeps one conversation per Idea, and an older daemon falls back to the previous routing, so do not count on task and review isolation there. [Online agents overview](https://doc.chorus-ai.dev/guides/online-agents-overview/) shows how these conversations are laid out.

## A sub-agent is not a second pair of eyes

Multi-agent orchestration is where the tooling is heading. Claude Code's Agent Teams and everyone else's subagents are all on that road. The common shape is a session spawning sub-agents: same process, same credentials and permissions, task prompt written by the parent, gone the moment the parent ends.

They get their own context window. They do not get their own identity, and they leave no session behind.

That shape is genuinely useful. Splitting work, running things in parallel, saving context all depend on it. But whoever wrote the code is whoever spawned the sub-agent, and wrote its prompt too.

A Chorus team is made of separately authenticated agents, each with its own permission set and its own sessions. The isolation sits in the session anchor, not in a prompt politely asking the model to forget the code it just wrote.

## Quick Tasks can hang off an Idea now

A Quick Task used to either sit under an approved proposal or float free. Now it can link straight to one Idea in the same project, and `ideaUuid` is accepted on the task interfaces on both MCP and REST. The link can be changed or cleared at any time. Theme Ideas take no tasks of their own; they exist to group the child Ideas derived from them.

Once linked, those tasks show up on the Idea and count toward its progress. Idea status is now derived uniformly instead of looking only at proposal tasks. [Link a Quick Task to an idea](https://doc.chorus-ai.dev/guides/create-and-edit-entities/#link-a-quick-task-to-an-idea) walks through the controls.

One real trap got fixed along the way. If a linked Quick Task finished before the proposal tasks, the whole-Idea code review started early. The post-verify hooks on Claude Code, Codex/TRAE, Kiro, and Hermes now decide from the server's derived Idea status, so the reminder waits until the Idea is actually done.

This release also picks up dependency security updates, patching Next.js and DOMPurify and overriding zod, body-parser, undici, and devalue to clear the root high-severity audit.

---

All seven plugins and the four published npm packages move to **0.24.0** with this release.

As long as the team has a review member who is eligible and online, the agent reviewing your code is now a different, separately authenticated member, and the server opens a fresh session for the review. It genuinely does not remember writing the code.
