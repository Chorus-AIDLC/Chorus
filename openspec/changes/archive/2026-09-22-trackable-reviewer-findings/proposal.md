# Trackable reviewer findings (prose-only)

## Why

Three verified problems with the current reviewer definitions, all of them prompt-level:

1. **The output cap contradicts the evidence requirement.** Every reviewer is told to keep its whole comment under a byte budget — 1000 characters for `code-reviewer`, 800 for `task-reviewer` and `proposal-reviewer` — while the same files' required output format demands `Evidence` / `Expected` / `Actual` for every BLOCKER, plus `Command run` / `Output observed` for the two that execute commands. A single BLOCKER's evidence block approaches that budget on its own, so the cap's practical effect is to squeeze out the evidence for serious problems. Noise should be bounded by a relevance boundary, not by a byte budget.

2. **There is no exclusion list anywhere.** All three reviewers have a BLOCKER/NOTE *classification* taxonomy but no "what not to flag" rule, so the default model behaviour is to report anything it thought of — speculative races with no trigger path, pre-existing issues outside the diff, style the linter does not enforce, "consider adding X" enhancements. The Cloudflare write-up this idea draws from treats a per-reviewer exclusion list as the primary noise lever.

3. **Findings have no identity across rounds.** Round 2+ is told to "read your prior verdict comments" and re-check previous BLOCKERs. With no stable identifier, a re-review cannot state per-finding what happened, and the existing rule "if all previous BLOCKERs are resolved → PASS" silently treats *not being re-reported* as *fixed*. NOTEs are not carried forward at all.

## What Changes

Three prose-only edits to each of the 3 reviewer definitions across all 7 plugin surfaces (21 files):

1. **Replace the total output cap with a relevance budget.** Remove every "keep total output under N characters" instruction (both the 1000 and the 800 variants, in the frontmatter reminder as well as the output-format section). BLOCKER evidence is explicitly unbounded; newly-raised NOTEs are capped at 5, with the excess dropped by relevance rather than compressed. The cap binds newly-raised NOTEs only — it composes with, and does not replace, the existing round-2+ rule that no new NOTEs are introduced at all, and it never applies to the carried-forward acknowledgement lines that change 3 creates.

2. **Add a per-reviewer DO / NOT-DO list.** Each reviewer gets its own list matched to what only it can see; exactly one rule is shared by all three (never report something as missing without first confirming its absence with read-only Bash).

3. **Give BLOCKERs and NOTEs stable IDs and carry both across rounds.** IDs are `B<round>-<slug>` / `N<round>-<slug>`, assigned in the round that first reports the finding and never renamed. Round 2+ must acknowledge every prior BLOCKER and every prior NOTE by ID with exactly one state — `fixed`, `still-open`, or `not-verifiable` — plus the command it actually re-ran. Silence is not a fix: only `fixed` closes a finding. A BLOCKER left `still-open` **or** `not-verifiable` yields `VERDICT: FAIL`; an unresolved NOTE never yields worse than `PASS WITH NOTES`.

A Vitest parity test asserts all 21 files carry the new rules, because these files are not verbatim copies of each other (117–226 lines) and a past change landed its wording in only 3 of the 6 non-Claude-Code surfaces.

## Capabilities

- `reviewer-finding-identity` — finding IDs, cross-round acknowledgement states, the relevance budget, and the per-reviewer exclusion lists.

## Impact

- **Changed:** `public/chorus-plugin/agents/{code,task,proposal}-reviewer.md`, `public/skill/{code,task,proposal}-reviewer-chorus/SKILL.md`, `plugins/chorus/skills/chorus-{code,task,proposal}-reviewer/SKILL.md`, `packages/openclaw-plugin/skills/{code,task,proposal}-reviewer/SKILL.md`, `packages/chorus-pi/agents/chorus-{code,task,proposal}-reviewer.md`, `packages/chorus-dsh/skills/{code,task,proposal}-reviewer-chorus/SKILL.md`, `public/kiro-plugin/.kiro/agents/chorus-{code,task,proposal}-reviewer.json`.
- **Added:** a Vitest parity test over those 21 files.
- **Unchanged:** the database schema, every MCP tool, every server route, the `PASS` / `PASS WITH NOTES` / `FAIL` verdict set, and the advisory nature of the verdict. No gate is added, tightened, or loosened.

## Explicitly out of scope

Decided by the human on 2026-09-22 and recorded in elaboration rounds 2–4:

- **No verdict header format.** An earlier draft proposed `SCOPE:` (committed range / dirty tree / worktree-only) and `COVERAGE:` lines. Rejected.
- **No fourth verdict value.** No `VERDICT: INCOMPLETE`. A new enum value would have to be understood by the orchestrator, the hooks, and all 7 surfaces.
- **No server-side review record, no provenance, no enforcement gate.** The trade-off was stated and accepted: a prose-only change buys noise reduction and a readable cross-round trail, and buys nothing at all toward proving a verdict comment really came from a given reviewer invocation (`Comment` carries no provenance and sub-agents share the parent's credential).
- **No risk tiering, no additional specialist reviewers, no model control plane, no automatic approve or merge.**
