# Task review checks correctness and quality by default, not only the AC

## Why

The task gate is currently AC-driven. Its procedure verifies each acceptance criterion, cross-references the proposal documents, runs the task's tests, fires 2-3 adversarial probes, and checks intent alignment. Its classification list then closes with `Only functional/behavioral issues → BLOCKER`.

That leaves a defect with no owner. The acceptance criteria are written by an LLM PM **before the code exists**: they describe what to build, never how well it was built. Anything that depends on the code as written — a bug no criterion happens to mention, a missing authorization check, a test that cannot fail — structurally cannot be in the AC. So "no AC covers it" silently became "nobody reports it".

The aggregate code reviewer does not close the gap, for two reasons. Its `NOT DO` list opens with "do not redo the per-line review each task already passed", on the assumption that a per-line correctness review happened — but the task gate never promised one. And its security dimension is scoped to "risks visible only when the pieces are seen together", which is explicitly *not* a hole one task wrote by itself. Verified: `grep -ciE "security|authz|tenant|injection"` over the task reviewer's definition returns no security dimension at all. In this repository `CLAUDE.md`'s multi-tenancy rule happens to catch that via the Project-constraints check, but Chorus ships to arbitrary repositories, most of which declare no such rule.

## What Changes

A new default-review block is added to all seven task-reviewer definitions, placed immediately before the intent-alignment step. It states that the AC are a floor rather than a ceiling, and names five BLOCKER-bearing dimensions plus one collected NOTE-level line:

1. **Correctness without an AC** — behaviour that is simply wrong where no criterion speaks to it.
2. **Reimplementation** — a three-tier preference (platform feature → standard library or an already-present dependency → an existing utility in this repo → new code), with the duplicated thing named. Drawn from the `ponytail` skill's YAGNI ordering rather than from "write fewer lines": its own benchmark reports the gain concentrated on over-building traps and near zero where code is already minimal, and an independent run measured a median 15% reduction with a null quality result. "Could be shorter" with nothing named is explicitly not a finding.
3. **Security in this task's own code** — missing authorization, a query missing tenant scoping, injection, a secret in source or logs, unsafe deserialization.
4. **Tests that cannot fail** — a test offered as covering an AC that asserts only that a mock was called, snapshots nothing, or asserts a tautology; that AC is unverified.
5. **Silent failure** — an empty catch, an error logged then discarded, an ignored rejection, a failure path returning success.
6. **NOTE-level** — maintainability, leftovers, diff hygiene, loose contracts, obvious performance defects, collected in one line.

A severity rule bounds all of it: a quality finding is a NOTE by default and becomes a BLOCKER only when the reviewer can name the concrete defect. Taste never blocks.

The classification list's closing rule is rewritten in the same change, because `Only functional/behavioral issues → BLOCKER` directly contradicts the new list — a duplicated utility and a tautological test are neither functional nor behavioural. Leaving it would ship the same self-contradiction class this repository has just spent a release removing.

## Capabilities

- `task-review-default-quality` — the dimensions the task gate checks without an acceptance criterion, and the severity rule bounding them.

## Impact

- **Changed:** the seven task-reviewer definitions (`public/chorus-plugin/agents/task-reviewer.md`, `public/skill/task-reviewer-chorus/SKILL.md`, `plugins/chorus/skills/chorus-task-reviewer/SKILL.md`, `packages/openclaw-plugin/skills/task-reviewer/SKILL.md`, `packages/chorus-pi/agents/chorus-task-reviewer.md`, `packages/chorus-dsh/skills/task-reviewer-chorus/SKILL.md`, `public/kiro-plugin/.kiro/agents/chorus-task-reviewer.json`), plus `src/__tests__/reviewer-rule-parity.test.ts`.
- **Unchanged:** the proposal and aggregate-code reviewers; the verdict set; the advisory nature of the verdict; the relevance budget; the stable-ID and cross-round ledger rules.

## Consequences worth stating

**The gate's character changes.** A task can now FAIL for something the proposal never asked for. A developer can no longer answer a finding with "every AC passed". That is the intent, and it is a policy shift rather than a clarification.

**Quality NOTEs are a round-1 check in practice.** Round 2 and later forbid introducing new NOTEs, so a NOTE-level quality issue introduced by a fix round is not reported unless it reaches a BLOCKER threshold. Accepted: fix rounds should stay focused on the prior findings. Changing that would mean changing the round-2+ rule, not this block.

**The NOTE budget is unchanged at five newly-raised NOTEs.** Quality findings compete for the same five slots and the least relevant are dropped rather than compressed. Accepted because the five severe dimensions are BLOCKER-bearing and therefore outside the NOTE budget entirely; what gets dropped is leftovers and naming.
