---
title: "The Model Got Dumber. Your Workflow Shouldn't."
description: "Anthropic quietly nerfed Claude Code's thinking depth and cut off OpenClaw's subscription access. The real problem isn't what changed — it's that your workflow had zero resilience to it."
date: 2025-04-07
lang: en
postSlug: model-got-dumber-workflow-shouldnt
---

# The Model Got Dumber. Your Workflow Shouldn't.

> Anthropic quietly nerfed Claude Code's thinking depth, then cut off OpenClaw's subscription access. The model got dumber and the platform got tighter. The community demanded a rollback. Almost nobody asked the harder question: why did a single parameter change bring your entire workflow to its knees?

---

## What 6,852 Session Files Tell Us

On April 2, 2026, a heavyweight post landed on the Claude Code issue tracker: [#42796 "[MODEL] Claude Code is unusable for complex engineering tasks with the Feb updates"](https://github.com/anthropics/claude-code/issues/42796). As of this writing, 1,043 reactions and 95 comments.

This wasn't a rant. The team behind it does systems programming — C, MLIR, GPU drivers — and routinely runs five to ten concurrent Claude Code sessions. They pulled 6,852 session logs from late January through early April and ran a full quantitative analysis.

The conclusion was unambiguous: Anthropic started reducing thinking depth in late February. In early March, they began redacting thinking content entirely — users could no longer see what the model was "thinking." The redaction rate climbed from 1.5% on March 5 to 100% by March 12.

This wasn't vibes. It was telemetry.

### Key Metrics

| Metric | Before ("Good") | After ("Degraded") | Change |
|--------|-----------------|---------------------|--------|
| Read:Edit ratio | 6.6 | 2.0 | -70% |
| Thinking depth (median) | ~2,200 chars | ~600 chars | -73% |
| Full-file overwrite rate | 4.9% | 10.0% | +104% |
| User frustration indicators | 5.8% | 9.8% | +68% |
| Laziness hook triggers | 0/day | ~10/day | 0 → 173 in 17 days |

A Read:Edit ratio of 6.6 dropping to 2.0 means the model used to read seven related files before touching one. Now it reads two and starts editing. The team also built a custom hook to catch "edit without reading" behavior. Before March 8, it never fired. In the 17 days after, it fired 173 times.

### The Timeline Lines Up

On March 8, the thinking redaction rate hit 58.4%. The same day, users began reporting quality degradation en masse. From the issue:

> "The quality regression was independently reported on March 8 — the exact date redacted thinking blocks crossed 50%."

Correlate the two datasets: 7,146 paired samples, Pearson coefficient of 0.971. Not a coincidence.

---

## Castles in the Air

The discussion under the issue converged on three asks: restore thinking depth, offer a "max thinking" paid tier, expose thinking token usage in the API response. All reasonable. But they all amount to the same thing — make the model smart again.

Nobody asked a more fundamental question: why did a single parameter change break my entire workflow?

If your development process lives entirely inside the model's context window, you're building castles in the air — looks solid until you realize there's nothing underneath. When the model thinks deep, code quality is good. When it thinks shallow, code quality tanks. You have zero control over this variable. Anthropic can change it tomorrow, and according to this issue, they already did — without telling anyone.

This is exactly the problem that Harness Engineering addresses. The word "harness" comes from horse tack — reins, saddle, bit — gear for controlling a powerful animal that doesn't take directions on its own. In the AI context, the model is the horse: fast but directionless. The harness is everything the rider puts around it to steer. In software engineering, "test harness" is older still — a controlled environment for running code under test. When Mitchell Hashimoto [coined "harness engineering"](https://mitchellh.com/writing/my-ai-adoption-journey) in February 2026, he drew on both meanings: constrain it, guide it, give it feedback.

After Claude Code's thinking got shallower, the model stopped researching before editing (Read:Edit ratio collapsed), stopped self-correcting (laziness triggers went from zero to ten per day), and stopped maintaining coherent reasoning across long sessions (full-file overwrites doubled). Every single one of these regressions happened because capabilities that should have been externalized were left inside the model's internal reasoning.

---

## What Externalized Reasoning Looks Like

Take the "edit without reading" regression. In January, Claude Code would read the target file, search for call sites, check headers and tests, then make a surgical edit. That entire research process lived inside the model's thinking tokens. When thinking got cut, the research vanished with it. But if you have structured tasks with explicit acceptance criteria, and a separate review agent that checks the code against those criteria line by line, then research is no longer something the model might or might not feel like doing. The system requires it. Fall short and you don't pass verification.

Planning works the same way. The issue reports that the model stopped planning multi-step operations — it just dove in. But if planning happens in a dedicated phase — requirements clarified through Q&A, tasks decomposed into a dependency graph, each node carrying measurable acceptance criteria — then planning doesn't need thinking tokens at all. It's already done before the model writes its first line of code.

Verification too. The model stopped checking its own work? Then stop relying on self-review. Have an independent reviewer agent compare the output against acceptance criteria after each task. If it doesn't match, kick it back. The agent that writes the code and the agent that verifies it are not the same. That's not redundancy. That's cross-validation.

---

## Adding Insult to Injury: Platform Access

The model getting dumber was bad enough. Then it got worse.

On April 4, 2026 — two days after #42796 went up — Anthropic's head of Claude Code, Boris Cherny, [announced](https://www.theverge.com/ai-artificial-intelligence/907074/anthropic-openclaw-claude-subscription-ban) that Claude subscriptions would no longer cover usage from third-party tools like OpenClaw. OpenClaw was the most popular open-source AI agent platform at the time. Huge numbers of developers were running 24/7 agentic workflows on $20/month Pro or $200/month Max subscriptions. Overnight, that path was closed. Switch to per-token API billing (potentially 10x the cost for equivalent usage), or leave. OpenClaw's creator Peter Steinberger said he [tried to reason with Anthropic](https://timesofindia.indiatimes.com/technology/tech-news/openclaw-creator-who-sam-altman-hired-for-millions-reacts-to-anthropic-banning-his-ai-agent-says-tried-to-talk-sense-into-anthropic-but-/articleshow/130016220.cms) — the best he managed was a one-week delay.

This wasn't a one-off. Back in January, Anthropic had already quietly blocked Claude Pro/Max OAuth tokens from working in third-party tools ([openclaw/openclaw#559](https://github.com/openclaw/openclaw/issues/559)). In February they wrote it into the terms. In April they pulled the trigger. The pattern is clear: the platform tolerates the ecosystem while it's growing, then tightens the screws once it's established. People compared it to Twitter killing third-party clients and Apple tightening App Store rules. Same playbook.

So you're not just dealing with "the model got dumber." You're dealing with "the platform can change the rules whenever it wants." If your orchestration layer is locked into a provider's OAuth and subscription system, then both model capability and platform access are in someone else's hands. The alternative is to keep orchestration local — integrate models through plugins and skills, and keep your workflow definitions, task structures, and verification logic off the provider's servers. The model becomes a replaceable executor, not an irreplaceable brain.

---

## Chorus in Practice: Trust No Single Agent

We built [Chorus](https://github.com/Chorus-AIDLC/Chorus) on one assumption: never trust any single agent's end-to-end capability.

The entire AI-DLC (AI-Driven Development Lifecycle) workflow is designed to pull planning out of the model's head and into structured pipeline stages. An idea goes through elaboration, where requirements get clarified in a Q&A process. Then a PM Agent produces a Proposal containing product documentation, a technical design, and a task dependency graph, with measurable acceptance criteria on every task. An independent Reviewer Agent performs adversarial review at both proposal submission and task completion. The Dev Agent that writes code is just one link in the chain — everything around it is checking its work.

What happens when thinking tokens get cut? The planning layer doesn't degrade, because planning was already finished in Chorus's Proposal stage — it was never in the model's head to begin with. Here's the critical distinction: without a harness, "plan before you code" is something that might or might not happen inside the model's thinking process. When thinking tokens are plentiful, the model tends to plan. When they get cut, it skips planning. You have no control over this. But in Chorus's pipeline, planning is a structural gate: an Idea cannot become a Proposal without going through elaboration, and a Proposal cannot be broken into executable Tasks without passing reviewer validation. This isn't something the model "chooses" to do — the pipeline topology makes it mandatory. The same goes for global task orchestration: which tasks depend on which, what runs in what order, what can be parallelized — all of it is encoded in the Task DAG, not left for some agent to remember mid-session.

The execution layer works the same way. The task-reviewer catches "edit without reading" behavior, and each task is small enough that the model doesn't need to sustain high-quality reasoning over a long stretch to complete it. In other words, the harness turns what used to depend on the model's spontaneous diligence — planning and global coordination — into hard constraints at the system level. The model got dumber, but the pipeline didn't, because the pipeline's intelligence doesn't come from any single model's thinking depth. It comes from structural enforcement between stages.

---

## Stop Kidding Yourself

6,852 session files put the data on the table. The OpenClaw ban put the risk on the table. If you're still debating how to get Anthropic to restore thinking depth, you're missing the point. The real problem was never that the model got dumber. It's that your workflow had zero resilience to model changes.

Models will get smarter and they'll get dumber. Prices will go up and they'll come down. Platforms will open up and they'll lock down. The only certainty is that things will change. Your harness should make you immune to those changes, not leave you praying they don't happen.

Building certainty on top of uncertainty. That's engineering.

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus)

**The issue that started the conversation**: [anthropics/claude-code#42796](https://github.com/anthropics/claude-code/issues/42796) — *"[MODEL] Claude Code is unusable for complex engineering tasks with the Feb updates"*, by stellaraccident, 2026-04-02
