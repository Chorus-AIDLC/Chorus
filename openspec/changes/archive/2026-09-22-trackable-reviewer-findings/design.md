# Design — Trackable reviewer findings (prose-only)

## Overview

Every change here is text inside a reviewer definition. There is no runtime component: the
reviewer is an LLM reading its own definition, and the only consumer of its output is the
orchestrating LLM reading the comment it posts. That constrains the design in two ways worth
stating up front, because they explain choices that would otherwise look like under-engineering:

1. **A rule only exists if it is written in all 21 files.** The three reviewer definitions are
   duplicated across 7 surfaces and are *not* verbatim copies of one another (117–226 lines;
   the Kiro surface embeds the whole prompt as a JSON string). There is no shared include
   mechanism, so "add a rule" literally means "write the rule 21 times, adapted to each file's
   voice". The parity test exists because that is error-prone, and has already gone wrong once.
2. **Nothing here is enforceable.** No hook parses the comment, no server route reads the
   verdict (`grep -rn 'VERDICT' src/` → zero hits). The IDs and acknowledgement states are a
   convention the reviewer is instructed to follow and a human can audit. The design must not
   describe them as guarantees.

## The 21 files

| Surface | Files | Cap instances |
|---|---|---|
| Claude Code plugin | `public/chorus-plugin/agents/{code,task,proposal}-reviewer.md` | 2 each (frontmatter reminder + output section) |
| Standalone skill | `public/skill/{code,task,proposal}-reviewer-chorus/SKILL.md` | 1 each |
| Codex plugin | `plugins/chorus/skills/chorus-{code,task,proposal}-reviewer/SKILL.md` | 2 each |
| OpenClaw plugin | `packages/openclaw-plugin/skills/{code,task,proposal}-reviewer/SKILL.md` | 2 each |
| Pi | `packages/chorus-pi/agents/chorus-{code,task,proposal}-reviewer.md` | 2 each |
| dsh | `packages/chorus-dsh/skills/{code,task,proposal}-reviewer-chorus/SKILL.md` | 2 each |
| Kiro | `public/kiro-plugin/.kiro/agents/chorus-{code,task,proposal}-reviewer.json` | 1 each (inside the `prompt` string) |

Verified cap wording varies and all variants must be removed: `Keep your comment under 1000
characters`, `Keep total output under 1000 characters`, `under ~800 characters`, `Total under
1000 chars`, `Total output under 800 characters`, and the Kiro JSON's `Keep total output under
1000 characters` inside the embedded prompt.

**Not edited — generated or vendored copies:** `.next/standalone/**` (Next build output),
`packages/chorus-cdk/cdk.out/**` (CDK asset staging), `.claude/worktrees/**`. These contain
stale copies of the same files; editing them would be editing build artifacts. The parity test
must scope itself to the 21 paths above for the same reason.

## Change 1 — relevance budget replaces the byte budget

Remove every character cap. Replace with:

- **BLOCKER evidence is unbounded.** Whatever the output format demands for a BLOCKER
  (`Evidence` / `Expected` / `Actual`, plus `Command run` / `Output observed` on the surfaces
  that can execute commands) is written in full. Truncating evidence is never the right way to
  shorten a comment.
- **At most 5 newly-raised NOTEs, in round 1.** Past 5, drop the least relevant rather than
  compressing all of them into fragments. Dropping is honest; a comment full of half-sentences
  is not.

**How the cap composes with the existing round-2+ rule — state this explicitly, it is the one
place these files can contradict themselves.** All 21 files already say, twice each, "Round 2+:
do NOT introduce new NOTEs on areas not flagged in previous rounds". That rule is kept exactly as
it is. The cap therefore binds per round in only one round:

| | Newly-raised NOTEs | Carried-forward acknowledgement lines |
|---|---|---|
| Round 1 | at most 5 | none exist yet |
| Round 2+ | **zero** — the existing rule already forbids them | **all of them, uncapped** |

So the cap and the existing rule never both apply to the same thing: in round 1 there is nothing
to carry forward, and in round 2+ there are no new NOTEs to cap. Each file must say that the
limit governs newly-raised NOTEs only and never the carried-forward trail — otherwise the cap
would silently destroy the trail that Change 3 exists to create, and "max 5 NOTEs" is exactly the
kind of rule an LLM over-applies.

## Change 2 — per-reviewer DO / NOT-DO lists

One shared rule, promoted to all three reviewers (it currently exists only in
`proposal-reviewer`): **never report something as missing without first confirming its absence
with read-only Bash.**

Shell availability is per file, not per surface — verified from the Kiro agent definitions'
`tools` arrays: `chorus-proposal-reviewer.json` grants `["read","shell","@chorus"]`, while
`chorus-code-reviewer.json` and `chorus-task-reviewer.json` grant only `["read","@chorus"]`. In
any file whose reviewer has no shell, the rule is written as **confirm by reading the relevant
files, and say what you read** — do not hand a reviewer a shell it was not given.

(Aside, out of scope and not fixed here: the Kiro `code-reviewer` has no shell at all, yet the
aggregate code review is defined around running the project's build and tests. That is a
pre-existing inconsistency in that surface, not something this change introduces or repairs.)

Everything else is per-reviewer, matched to what that reviewer alone can see:

**proposal-reviewer** — reviews drafts, not implementations.
- DO: requirements traceable to human intent; AC machine-verifiable; task granularity and the
  dependency DAG sound; an integration checkpoint present once there are 4+ tasks.
- NOT: document wording or formatting; "the implementation detail isn't specific enough" (that
  is the task stage's judgement); alternative architectures; future extensibility.

**task-reviewer** — one task against its own AC.
- DO: run this task's tests/build and quote real output; judge only against this task's AC and
  this task's diff; AC not actually covered → BLOCKER.
- NOT: re-litigate decisions in an already-approved proposal; pre-existing problems the task
  never touched; gaps that belong to a different task; **absent end-to-end integration tests**
  (that is the aggregate reviewer's dimension, not this gate's).

**code-reviewer** — the aggregate.
- DO: report only what the combination exposes — cross-task contract mismatches, architectural
  drift, a security hole assembled from parts, a regression no task owned, test gaps between
  tasks; run the full build/test.
- NOT: redo the per-line review each task already passed; style and naming; pre-existing issues
  outside the aggregate diff; speculative races with no demonstrable trigger path; **escalating
  a read-only conclusion to BLOCKER** — which is the verification-avoidance anti-pattern the
  file already warns about, now stated as a hard rule.

## Change 3 — stable IDs and cross-round acknowledgement

**ID format.** `B<round>-<slug>` for BLOCKERs, `N<round>-<slug>` for NOTEs, where `<round>` is
the round that **first reported** the finding and `<slug>` is a short kebab-case label
(`B1-tenant-scope-missing`, `N2-stale-cli-flag`). The round number is part of the identity and
is **never renamed** when the finding is carried into a later round — so a `B1-…` line appearing
in a round-3 comment is itself the signal that this problem has survived two fix attempts.

**Acknowledgement.** Round 2+ must list every prior BLOCKER and every prior NOTE by ID with
exactly one state, and with the command it actually re-ran this round:

| State | Meaning | Effect |
|---|---|---|
| `fixed` | Re-verified this round; cite the command and its result. | Closed. |
| `still-open` | Re-checked and the problem is still there. | BLOCKER → FAIL; NOTE → PASS WITH NOTES. |
| `not-verifiable` | Could not check this round; say why (no shell, missing dependency, no DB). | **Never counts as fixed.** BLOCKER → **`VERDICT: FAIL`**; NOTE → PASS WITH NOTES. |

A `not-verifiable` BLOCKER resolves to `FAIL`, not to a softer verdict. The reasoning has to be
written down because it is the one place where the frozen verdict set costs something: a BLOCKER
that could not be re-verified has not been *shown* fixed, and with `VERDICT: INCOMPLETE` rejected
there are only three values to choose between. `PASS WITH NOTES` would mean shipping on an
unverified blocker, so `FAIL` is the only honest option left. The cost is a known false-positive
mode — a genuinely-fixed blocker that merely could not be re-run this round reads as FAIL, and the
orchestrator's fix-task loop will spin on it until the round cap escalates to a human. That is the
accepted trade: a spurious escalation is recoverable, a spurious ship is not.

One vocabulary for both finding kinds — `fixed` / `still-open` / `not-verifiable`. (Earlier
drafts used `still-present` for BLOCKERs and `open` for NOTEs; a single triple is chosen so the
same three words can be written into 21 files without per-file drift.)

**Two rules that close existing holes:**

- **Silence is not a fix.** Not re-reporting a finding does not close it; only an explicit
  `fixed` line does. This directly amends the current instruction ("if all previous BLOCKERs are
  resolved → PASS"), which today treats an omitted finding as resolved.
- **NOTEs never escalate.** An open or not-verifiable NOTE yields `PASS WITH NOTES`. A NOTE can
  never become the reason for a `FAIL`. Only BLOCKERs block, exactly as today.

The verdict set is untouched: `PASS` / `PASS WITH NOTES` / `FAIL`.

## Change 4 — parity test

A Vitest test in the shape of `src/i18n/__tests__/locale-parity.test.ts`: a hardcoded array of
the 21 paths, read from disk, asserting for each file that it

- contains no character-cap instruction (regex over the known variants **and** a general
  `under ~?\d+ characters?` / `under \d+ chars` form, so a re-introduced cap with new wording
  still fails),
- carries the finding-ID convention, the three acknowledgement states, the silence-is-not-a-fix
  rule, and its own reviewer's NOT-DO list marker.

Reading the Kiro JSON files as text is sufficient and intentional — the rules live inside the
`prompt` string, and a text-level assertion checks exactly what the model will be shown.

Zero new dependencies (`vitest` and `node:fs` only), no CI workflow change — the existing
`pnpm test` step picks it up. Note that CI has no lint step, so `pnpm lint` must be run locally.

## What this design does not claim

- It does not make a verdict trustworthy. A comment ending in `VERDICT: PASS` can still be
  written by anything that can comment; IDs do not change that. Provenance needs a server-side
  record, which is explicitly out of scope (tier C in the idea).
- It does not reduce noise by a measurable amount. No baseline was collected, so the claim is
  "removes a rule that demonstrably squeezes out evidence, and adds exclusions in the shape that
  worked for Cloudflare" — not a percentage.
- It does not detect a reviewer that ignores its definition. The parity test proves the text is
  present in all 21 files; it cannot prove a model obeyed it.

## Risks

| Risk | Mitigation |
|---|---|
| Removing the cap makes comments long enough to crowd the orchestrator's context. | The NOTE cap (5) and the per-reviewer NOT-DO lists are the replacement bound; BLOCKER-heavy output is the case we *want* to be verbose. |
| A reviewer over-applies "max 5 NOTEs" and drops carried-forward acknowledgements. | Stated explicitly in every file: the cap applies to newly-raised NOTEs only. Parity test asserts the carve-out sentence is present. |
| 21 hand-edits drift in wording. | Parity test asserts the load-bearing markers per file; task AC requires it green. |
| Kiro JSON edit breaks JSON validity. | Task AC requires `JSON.parse` on all three Kiro agent files after editing. |
| A future surface is added and misses the rules. | The parity test's path array is the registry; adding a surface without updating it leaves the new file unguarded — called out in the test's header comment. |
