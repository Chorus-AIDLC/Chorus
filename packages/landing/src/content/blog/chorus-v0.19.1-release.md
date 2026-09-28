---
title: "Chorus v0.19.1: Lightweight Research and inline evidence citations"
description: "An agent can write a complete plan before checking its key assumptions. What happens when one of them falls apart halfway through development?"
date: 2026-09-28
lang: en
postSlug: chorus-v0.19.1-release
---

# Chorus v0.19.1: Lightweight Research and inline evidence citations

Ask an agent to integrate with a platform and export data in bulk. It can quickly produce a plan: an API wrapper, a job queue, an export page, even acceptance criteria.

But does that platform allow bulk reads? Which permissions are required? Do the documented rate limits apply to the current API version? Answer those questions from memory, and the whole plan rests on unchecked assumptions. Discover a restriction halfway through development, and the task breakdown needs to change too.

Chorus v0.19.1 adds lightweight Research and inline evidence citations so agents can check key facts during clarification and planning, then put the sources next to the claims they support.

## Start with a question that affects a decision

Research begins with a specific question: which decision could this fact change?

API permissions can affect the integration approach. An SDK's support for a particular version can affect the technology choice. Official documentation, source code, and other relevant material can answer those questions. Decisions about first-release scope or acceptable cost still belong to the person directing the work.

When creating an Idea, you can request Research before clarification. Leaving that option unchecked lets the agent judge whether a factual gap needs investigation. An explicit instruction to skip takes precedence. If the available evidence is sufficient, the workflow continues.

At the Proposal stage, the agent first reuses findings from the Idea. It investigates again only when design work raises a new factual question. Resuming a workflow, receiving a comment, or returning from brainstorm should not restart the same search.

## Stop when there is enough evidence to decide

Each Research pass focuses on one question. The skill asks the agent to aim for roughly 2–5 minutes and read at most five relevant sources in depth, favoring primary, official, and version-specific material. This is an instruction to the agent; tool behavior also affects elapsed time.

There is no minimum source count. If one official document answers the question, there is no need to find four more pages. If tools are unavailable, sources disagree, or the answer remains unclear, the agent records those limits and returns to the calling workflow.

Useful findings go into the existing Idea or proposal documents: what was established, how it affects the decision, and what remains unknown. The next agent can work from that record.

## Put the source next to the claim

Research also needs to be easy to check while reading a plan.

v0.19.1 supports inline evidence citations in Markdown across Ideas, Proposals, Tasks, Documents, and comments. The agent first attaches or reuses a real evidence record, then cites its UUID:

```markdown
This endpoint requires additional authorization.[1](ref:<evidence UUID>)
```

The reader sees a compact `[1]` marker. Hovering or focusing it with the keyboard shows the evidence title, type, URL, and notes. Clicking opens the source page.

A reviewer can follow a design claim straight to its supporting material. If the evidence record has been deleted, the citation stays visible and reports that the evidence is missing, making the gap easier to spot.

## Revisit a factual question before development starts

Some questions emerge after clarification, or even after a proposal has been approved.

The Idea Tracker's action menu now offers Research until actual development begins. An approved proposal with work still unstarted is eligible. The request joins the Idea's existing conversation, runs in sequence, and adds useful findings to its existing content.

That menu action has a defined stopping point: investigate, save useful findings, and end the turn. It preserves answered clarification questions and does not start development. If a new fact affects an approved proposal, the agent records the impact and the revision needed for the existing workflow to handle.

This release also gives Idea creation and Research dedicated daemon events. Conversation labels distinguish these operations from ordinary messages. Clients supporting the new protocol execute them as separate queued operations; older clients retain a compatibility path.

## Upgrade

Update the Chorus CLI, then follow the prompts to refresh your agent integration:

```bash
npm install -g @chorus-aidlc/chorus@0.19.1
chorus agents add
```

Restart the affected agent after updating.
