---
title: "Chorus v0.19.0: Ground rules for AI reviewers"
description: "Ten review comments, but how many need a fix? And when last round's blocker disappears, who checked that it was resolved?"
date: 2026-09-23
lang: en
postSlug: chorus-v0.19.0-release
---

# Chorus v0.19.0: Ground rules for AI reviewers

An AI review can create plenty of work: ask for error handling that already exists, reopen an approved design decision, then bury a real authorization flaw among naming suggestions.

The coding agent makes changes. A second review arrives. The authorization flaw is no longer mentioned. Was the fix verified? Was the issue overlooked? Did the reviewer move on? Someone has to compare the comments and work out what PASS actually means.

Chorus v0.19.0 gives its three reviewers clearer rules: stay within scope, provide evidence, assign each finding a stable identity, and account for it in later rounds.

## Three reviews, three questions

Chorus already has proposal review, task review, and a final review of the complete feature. Independent reviewers check the work and send defects through a fix-and-review loop. v0.18.0 also added intent alignment: reviewers revisit the human's original Idea, clarification answers, and comments.

Each stage answers a different question:

| Stage | Question |
| --- | --- |
| Proposal review | Will this plan and task breakdown deliver what the user asked for? |
| Task review | Does this task's code meet its requirements and avoid concrete defects? |
| Aggregate code review | Do the interfaces, permissions, and complete feature hold together across tasks? |

Those boundaries need to be explicit. Otherwise, proposal review demands implementation details before code exists, task review debates an approved architecture, and the final review repeats naming complaints.

The opposite failure matters too. A task omits an authorization check. Its reviewer leaves security to the final review, which assumes individual tasks have already been checked. The defect falls between responsibilities.

This release defines both what reviewers should leave alone and what they must catch themselves.

## Cloudflare's lesson: teach reviewers what to ignore

A direct reference for this work was Ryan Skidmore's [“Orchestrating AI Code Review at scale”](https://blog.cloudflare.com/ai-code-review/) on the Cloudflare blog.

Their early approach fed a diff to a model and asked for bugs. The results included vague suggestions, hallucinated syntax errors, and requests for error handling in functions that already had it. They moved to CI orchestration around OpenCode, with specialist reviewers managed by a coordinator.

The article covers up to seven specialists, model tiers, circuit breakers, and fallback chains. The part most useful to this Chorus release was the **What NOT to Flag** instructions.

Cloudflare's security reviewer looks for exploitable or concretely dangerous issues. It excludes theoretical risks with unlikely preconditions, extra defenses where the primary protection is adequate, and old problems unaffected by the change.

The coordinator then deduplicates findings, adjusts categories, and filters speculation and advice that conflicts with project conventions. When unsure, it reads the source to verify.

Before a model's observation becomes a developer's task, the system asks: Is it in scope? Is there evidence? Has another reviewer already reported it? Does it warrant blocking a merge? More reviewers also require a way to control the work they create.

Cloudflare reports 131,246 reviews in its first 30 days, about 1.2 findings per review, a median duration of 3 minutes 39 seconds, and an average cost of $1.19. Those numbers describe scale and output density; finding counts alone cannot establish accuracy. Chorus is borrowing the review practices. Their effect in our workflow still needs measurement.

## Apply the boundaries to Chorus's reviewers

Cloudflare divides reviewers by specialty, such as security and performance. Chorus divides them by delivery stage, so each existing reviewer now has its own DO / NOT-DO list.

**Proposal review checks whether the plan works.** Requirements must trace to human intent, acceptance criteria must be verifiable, and task dependencies and integration checkpoints must make sense. Wording, heading order, and a preference for another architecture should not hold up a viable proposal. Implementation choices belong at the task stage.

**Task review checks the code this task delivers.** It should not reopen approved design decisions or block on gaps another task owns. An authorization hole introduced by this task, however, belongs in this review.

**Aggregate review checks what emerges when tasks connect.** Does one task consume the fields another returns? Do permissions remain sound across module boundaries? Do passing unit tests leave an untested path through the feature? Repeating individual task reviews crowds out these questions.

All three share one rule: **verify absence before reporting something as missing.** Search for the helper. Check the file path. Say what you inspected.

Evidence must also fit the claim. Missing tenant scoping can be demonstrated with source and line references. A race condition needs a concrete interleaving and reachable path. Being unable to run code does not erase a visible defect, and imagining a runtime failure does not prove one.

## Keep the evidence; limit minor suggestions

The old aggregate reviewer had contradictory instructions: provide commands, output, expected results, and actual results for every BLOCKER, but keep the entire response under 1,000 characters. Other reviewers had different total-length limits.

Several real defects could exhaust that budget quickly. Cutting the response could remove the evidence the coding agent needed to fix them.

v0.19.0 removes total character caps across all three reviewers:

- **BLOCKER evidence stays complete.**
- **Round one allows at most five new NOTEs.** Drop the least relevant extras.
- **Later rounds introduce no new NOTEs.** Focus on existing findings.
- **Acknowledging prior findings has no count limit.** Every earlier item still needs a response.

BLOCKERs require resolution. NOTEs are non-blocking suggestions. Both can be useful without receiving equal priority in a fix cycle.

## A finding needs an explicit ending

Cloudflare's approach to repeat reviews is worth examining too.

After a new push, its coordinator receives the previous review, inline findings, and their resolution status. Unfixed issues must be reported again. Fixed issues disappear from the new output, and the MCP server resolves their discussion threads. Developer replies also inform the decision.

That behavior has thread state behind it. Chorus currently exchanges review results mainly through comments, so this release adds explicit tracking rules to those comments.

Each finding gets a stable ID:

```text
B1-tenant-scope-missing
N1-unclear-helper-name
```

`B` means BLOCKER, `N` means NOTE, and the number identifies the first reporting round. A round-one finding keeps its `B1-` ID in round three.

From round two onward, reviewers must acknowledge every prior BLOCKER and NOTE using one of three states:

| State | Meaning |
| --- | --- |
| `fixed` | Rechecked this round and confirmed resolved, with evidence |
| `still-open` | Rechecked this round; the problem remains |
| `not-verifiable` | Could not verify this round; explain what was missing |

An illustrative follow-up might read:

```text
Prior findings:
- B1-tenant-scope-missing: fixed
  Reran the cross-tenant access test; other tenants' records are excluded.
- B1-error-swallowed: not-verifiable
  No test database this round; could not rerun the failure path.
- N1-unclear-helper-name: still-open
  Rechecked the function definition; the name is unchanged.

VERDICT: FAIL
```

The first item is closed. The second has not been shown to be fixed. The third remains a suggestion. “I've fixed everything” from the coding agent does not replace these checks.

The three verdicts remain `PASS`, `PASS WITH NOTES`, and `FAIL`. An open or unverifiable BLOCKER yields FAIL. An unresolved NOTE can yield PASS WITH NOTES, but never becomes a blocker simply by surviving another round.

There is a cost: a real fix may receive FAIL because the environment cannot verify it. That calls for another check or human intervention. The review must distinguish what was demonstrated from what could not be checked.

## Passing the acceptance criteria is not enough

This release also strengthens the task reviewer's default quality checks.

Acceptance criteria (AC) are usually written before the code. “Users can save settings” cannot anticipate every defect in the eventual implementation. Reporting success after a failed save or reading another account's settings still warrants a finding, even without an AC spelling out that exact bug.

Task reviewers now check five dimensions by default:

- Concrete bugs in the task's code, including those without a matching AC.
- Reimplementation of an available platform feature, dependency, or repository utility. The finding must identify the existing capability.
- Security defects introduced by the task itself.
- Tests that would still pass with an incorrect implementation.
- Masked failures of required operations, including failure paths that report success.

These checks need boundaries too. Using a mock does not make a test invalid. If the requirement is “call the callback exactly once,” a call-count assertion directly tests it. A documented best-effort telemetry operation that records a failure without propagating it is also behaving as intended.

“This could be shorter” is a preference. “This duplicates the existing helper at this path” identifies something actionable. A blocking finding needs a concrete defect and a small, sufficient fix.

## Rules for the review workflow

Cloudflare's article also covers risk tiers, model routing, retries, observability, and checking whether `AGENTS.md` remains current. Those mechanisms support its large-scale CI review system.

Chorus v0.19.0 focuses on how its existing reviewers judge work and hand findings between rounds. Stable IDs, explicit acknowledgments, scope boundaries, and default quality checks live in reviewer instructions. Kiro's task and aggregate reviewers also gain constrained read-only shell inspection.

The rules cover 21 reviewer definitions across Claude Code, Codex, OpenClaw, Kiro, Pi, dsh, and standalone skills. A parity test checks that each definition carries the rules. It guards the instructions against drift; adherence during real reviews still needs observation.

Finding IDs and states remain comment text, consumed by the orchestrating agent under the workflow. This release adds neither server-enforced approval gates nor dedicated records that authenticate each reviewer invocation. Platform verification of review origin, code revision, and state transitions would need separate design.

The release also fixes Pi worker and reviewer dispatch and tool access, agent description parsing, and npm publication delays after successful uploads. All six plugins and four npm packages move to `0.19.0`.

Back in that opening review, the authorization flaw should have evidence, a stable ID, and a verified resolution. A naming suggestion can remain a NOTE without starting another cycle of minor revisions.

The coding agent should know why each blocker needs fixing. The person reading PASS should be able to trace how earlier problems were closed. That is the work these rules ask reviewers to do.

---

## Upgrade

```bash
npm install -g @chorus-aidlc/chorus@0.19.0
chorus agents add
```

Update your agent's Chorus plugin and restart it to load the new reviewer rules.

Further reading: [Cloudflare's article](https://blog.cloudflare.com/ai-code-review/), [Chorus reviewer changes, PR #573](https://github.com/Chorus-AIDLC/Chorus/pull/573), and [GitHub Release v0.19.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.19.0).
