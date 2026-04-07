---
title: "The Model Got Dumber. Your Workflow Shouldn't."
description: "Anthropic quietly nerfed Claude Code's thinking depth and cut off OpenClaw's subscription access. The real problem isn't what changed — it's that your workflow had zero resilience to it."
date: 2026-04-07
lang: en
postSlug: model-got-dumber-workflow-shouldnt
---

# The Model Got Dumber. Your Workflow Shouldn't.

> Anthropic quietly nerfed Claude Code's thinking depth, then cut off OpenClaw's subscription access. The model got dumber and the platform got tighter. The community demanded a rollback. Almost nobody asked the harder question: why did a single parameter change bring your entire workflow to its knees?

---

## What 6,852 Session Files Tell Us

On April 2, 2026, one of the most data-rich bug reports in recent memory hit the Claude Code issue tracker: [#42796 "[MODEL] Claude Code is unusable for complex engineering tasks with the Feb updates"](https://github.com/anthropics/claude-code/issues/42796). It racked up 1,043 reactions and 95 comments.

This wasn't a rant. The team behind it does systems programming — C, MLIR, GPU drivers — running five to ten concurrent Claude Code sessions on a daily basis. They exported 6,852 session logs spanning late January through early April and crunched the numbers.

What they found: Anthropic started dialing back thinking depth in late February. By early March, thinking content was being redacted — users could no longer see what the model was "thinking." Redaction crept from 1.5% on March 5 to 100% by March 12.

Not vibes. Telemetry.

### Key Metrics

| Metric | Before ("Good") | After ("Degraded") | Change |
|--------|-----------------|---------------------|--------|
| Read:Edit ratio | 6.6 | 2.0 | -70% |
| Thinking depth (median) | ~2,200 chars | ~600 chars | -73% |
| Full-file overwrite rate | 4.9% | 10.0% | +104% |
| User frustration indicators | 5.8% | 9.8% | +68% |
| Laziness hook triggers | 0/day | ~10/day | 0 → 173 in 17 days |

When the Read:Edit ratio was 6.6, the model would read seven related files before touching one. At 2.0, it reads two and starts editing. The team also built a custom hook to catch "edit without reading" — before March 8, it never fired once. Over the next 17 days, it fired 173 times.

### The Timeline Lines Up

On March 8, thinking redaction hit 58.4%. That same day, users started flooding in with quality complaints. From the issue:

> "The quality regression was independently reported on March 8 — the exact date redacted thinking blocks crossed 50%."

Run the correlation: 7,146 paired samples, Pearson r = 0.971. Not a coincidence.

---

## House of Cards

The discussion under the issue coalesced around three demands: bring back thinking depth, create a "max thinking" paid tier, surface thinking token usage in the API. All fair asks. But they're all variations on one theme — make the model smart again.

Nobody stopped to ask: why did one parameter change blow up my entire workflow?

If your development process lives inside the model's context window and nowhere else, you've built a house of cards. When the model thinks deep, the code is good. When it thinks shallow, the code is bad. You don't control that dial. Anthropic does, and according to this issue, they already turned it — without a word.

That's the core argument behind Harness Engineering. The word "harness" comes from horse tack — reins, saddle, bit — gear for steering a powerful animal that won't steer itself. In AI, the model is the horse: fast, strong, directionless. The harness is everything the rider wraps around it. Software engineering has used "test harness" even longer to mean a controlled environment for running code under test. When Mitchell Hashimoto [named "harness engineering"](https://mitchellh.com/writing/my-ai-adoption-journey) in February 2026, he was drawing on both senses: constrain it, guide it, close the feedback loop.

Once Claude Code's thinking got shallower, the symptoms piled up fast. The model stopped doing research before making edits (Read:Edit collapsed). It stopped catching its own mistakes (laziness triggers spiked from zero to ten a day). It stopped holding a thread across long sessions (full-file overwrites doubled). Every one of those failures traces back to the same root cause: capabilities that belonged in the harness were left inside the model's head.

---

## What Externalized Reasoning Looks Like

Start with the "edit without reading" problem. Back in January, Claude Code would read the target file, grep for call sites, check the headers and tests, then make a precise edit. All of that research ran on thinking tokens. Cut the thinking, and the research disappeared with it.

Now imagine a different setup. Each task spells out what "done" looks like — explicit acceptance criteria. A separate review agent checks the code against those criteria after every edit. In that world, doing your homework isn't optional. It's not something the model might feel like doing. It's a gate. Miss it and you fail verification.

Planning is the same story. The issue reports that the model stopped thinking ahead — it just dove straight into code. But if planning lives in its own phase — requirements clarified through Q&A, work broken into a dependency graph, each node tagged with testable acceptance criteria — then planning never needed thinking tokens in the first place. It was already finished before the first line of code got written.

And verification. The model stopped reviewing its own output? Then don't ask it to. Put an independent reviewer agent on the other end. In Chorus, the task-reviewer is strictly read-only — it can run tests and inspect code, but it cannot edit a single file. Its only job is to find problems, not fix them. Anything that doesn't match the acceptance criteria gets kicked back to the dev agent. The agent that writes the code and the agent that checks it are different agents with different permissions. That's not waste. That's cross-validation.

---

## It Gets Worse: Platform Access

The model getting dumber was bad enough. Two days later, it got worse.

On April 4, 2026, Boris Cherny, Anthropic's head of Claude Code, [announced](https://www.theverge.com/ai-artificial-intelligence/907074/anthropic-openclaw-claude-subscription-ban) that Claude subscriptions would no longer cover third-party tools like OpenClaw. OpenClaw was the most popular open-source AI agent platform at the time. Thousands of developers had been running around-the-clock agentic workflows on $20/month Pro or $200/month Max plans. Overnight, that was gone — switch to per-token API billing at potentially 10x the cost, or walk. OpenClaw creator Peter Steinberger [tried to negotiate](https://timesofindia.indiatimes.com/technology/tech-news/openclaw-creator-who-sam-altman-hired-for-millions-reacts-to-anthropic-banning-his-ai-agent-says-tried-to-talk-sense-into-anthropic-but-/articleshow/130016220.cms). All he got was a one-week reprieve.

It wasn't a one-off. Anthropic had been tightening the noose since January, when they quietly blocked Claude Pro/Max OAuth tokens from third-party tools ([openclaw/openclaw#559](https://github.com/openclaw/openclaw/issues/559)). February: written into the terms. April: enforced. The pattern is textbook platform economics — tolerate the ecosystem while you need it for growth, lock it down once you don't. People drew comparisons to Twitter killing third-party clients and Apple cracking down on App Store workarounds. Same playbook.

So the threat isn't just "the model got dumber." It's "the platform can rewrite the rules whenever it wants." If your orchestration layer runs on a provider's OAuth and subscription rails, you're exposed on two fronts: model capability and platform access, both controlled by someone else. The alternative is local orchestration — integrate models through plugins and skills, keep your workflow definitions, task graphs, and verification logic on your own machines. The model is a swappable executor. Not the brain you can't live without.

---

## Chorus in Practice: Trust No Single Agent

We built [Chorus](https://github.com/Chorus-AIDLC/Chorus) around one bet: no single agent is reliable enough to own an entire task end-to-end.

The AI-DLC (AI-Driven Development Lifecycle) workflow pulls planning out of the model's head and makes it a first-class pipeline stage. An idea goes through elaboration — a structured Q&A that nails down what's actually needed. A PM Agent then produces a Proposal: product spec, technical design, and a task dependency graph where every task carries measurable acceptance criteria. A separate Reviewer Agent does adversarial review when the proposal is submitted and again when each task is completed. The Dev Agent that writes code is one node in the pipeline. Everything around it exists to check its work.

So what happens when thinking tokens get cut? Planning doesn't degrade — it was never inside the model to begin with. It finished during the Proposal stage. And here's why that distinction matters: without a harness, "plan before you code" is a behavior that lives inside the model's thinking. When tokens are generous, the model plans. When they're not, it skips. You have no say. In Chorus, planning is a structural gate. An Idea can't become a Proposal without elaboration. A Proposal can't spawn Tasks without passing review. The model doesn't get to skip it — the pipeline won't let it. Same for orchestration: task dependencies, execution order, parallelism — it's all in the Task DAG, not floating around in some agent's context window hoping to be remembered.

Execution works the same way. The task-reviewer catches sloppy edits, and each task is scoped small enough that the model can finish it without needing to sustain deep reasoning over a long stretch. The harness takes what used to be the model's good intentions — planning, coordination, self-review — and turns them into hard system constraints. The model got dumber, but the pipeline didn't. Its intelligence was never in the model's thinking depth. It's in the structure between stages.

---

## Stop Kidding Yourself

The data is on the table. The risk is on the table. If you're still focused on getting Anthropic to restore thinking depth, you're solving the wrong problem. The issue was never that the model got dumber. It's that nothing in your workflow could absorb the hit.

Models get smarter and they get dumber. Prices rise and fall. Platforms open up and lock down. The only constant is change. Your harness should make you immune to it — not leave you hoping it doesn't happen.

Building certainty on top of uncertainty. That's engineering.

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus)

**The issue that started the conversation**: [anthropics/claude-code#42796](https://github.com/anthropics/claude-code/issues/42796) — *"[MODEL] Claude Code is unusable for complex engineering tasks with the Feb updates"*, by stellaraccident, 2026-04-02
