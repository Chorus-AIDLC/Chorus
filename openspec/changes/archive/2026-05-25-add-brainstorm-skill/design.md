# Design: Idea-stage brainstorm skill

## Architecture

```
chorus_claim_idea ──▶ idea skill: gather context
                            │
                            ▼
              AskUserQuestion("brainstorm? yes/no")
                            │
              ┌─────────────┴─────────────┐
              │                           │
            yes                          no
              │                           │
              ▼                           ▼
       brainstorm skill            structured elaboration
       (free-form Q&A,             (existing minimal/standard/
        2-3 directions,             comprehensive Q&A flow)
        approve gate)
              │
       Decision-point synthesis
              │
       chorus_pm_start_elaboration(depth="standard", questions=[…])
       chorus_answer_elaboration(answers=[…])
              │
       (skill terminates — no validate)
              │
              ▼
       idea skill: validate or follow-up?
              │
        ┌─────┴─────┐
        │           │
   covers all   gaps remain
        │           │
        ▼           ▼
 validate({   validate({
  issues:[]    issues, followUp
 })           Questions   ──▶ structured Round 2
              })              (depth picked by agent)
```

The brainstorm skill is **stateless** with respect to the idea: it produces one ElaborationRound and returns. All elaboration lifecycle decisions stay in the idea skill, matching the existing skill-boundary convention.

## Components

### 1. `brainstorm/SKILL.md` — the new skill

One source-of-truth body (~80–120 lines), distributed to four packages with platform-specific frontmatter. Section order:

- `## When invoked` — only as a sub-step of the `idea` skill, only after the user opts in via `AskUserQuestion`. Never invoked standalone.
- `## Hard rules` — (1) one question at a time via `AskUserQuestion`, (2) multi-choice preferred, (3) propose 2-3 directions with a recommendation before locking in, (4) get explicit approval before stopping the divergent phase, (5) do not write files, do not post comments, do not invoke writing-plans, do not call `validate_elaboration`.
- `## Step-by-step` — gather context → divergent Q&A → converge to 2-3 directions → confirm direction → synthesize decision-point Q&A → `start_elaboration` + `answer_elaboration` → return.
- `## Synthesis spec` — exact mapping from conversation to `ElaborationQuestion[]` (see "Data flow" below).
- `## Anti-patterns` — explicit "do not" list to keep the skill from drifting toward the original superpowers contract.

### 2. `idea/SKILL.md` — modified Step 4.5

Insert between current Step 4 (Gather Context) and Step 5 (Elaborate). The new step:

1. After `chorus_get_idea` + the gather-context calls, ask the user via `AskUserQuestion` whether to run brainstorm. The question header is "Brainstorm"; options are "Already clear, run structured elaboration" vs "Brainstorm first to explore directions".
2. On yes → invoke the `brainstorm` skill (Claude Code: `Skill brainstorm`; Codex: equivalent skill invocation).
3. On brainstorm return → the idea skill alone owns the choice between `validate_elaboration({ issues: [] })` and `validate_elaboration({ issues, followUpQuestions })`. The follow-up depth (minimal / standard / comprehensive) is the agent's call — the user is not asked again.
4. On no → proceed to Step 5 unchanged.

The current Step 5.6 (`chorus_pm_validate_elaboration`) wording is amended to clarify that this call is the **single commit gate** for the entire elaboration phase, not a per-round close. This was a known source of confusion (an earlier brainstorm draft assumed per-round validate) and the corrected mental model belongs in the canonical idea skill.

### 3. No other components

No backend changes. No `ElaborationRound.kind` field. No UI changes. No new MCP tool. No config flag. The brainstorm rounds render in the existing elaboration UI as decision-point Q&A — they are well-formed `ElaborationQuestion` rows with options, a selected option, and rationale in `customText`.

## Data flow

### Input (from idea skill at Step 4.5)
- `ideaUuid` (already claimed)
- Project context already loaded (documents, prior proposals, comment thread)
- User has answered `yes` to the brainstorm prompt

### Output (back to idea skill)
- Exactly one `ElaborationRound` in `answered` status
- The round's `roundUuid` (returned by `start_elaboration`)
- Skill returns control; no comments posted, no files written

### Synthesis from conversation to ElaborationQuestion

Each "decision point" in the brainstorm conversation becomes one ElaborationQuestion. A decision point is any moment where the user chose between alternatives or set scope. Mapping:

| ElaborationQuestion field | Source from conversation |
|---|---|
| `text` | The decision question, phrased neutrally (e.g. "Which depth-model placement?") |
| `category` | Derived from the decision topic (`scope`, `functional`, `technical_context`, etc.) |
| `options` | All directions that were considered (max 5; collapse near-duplicates) |
| `selectedOptionId` | The direction the user approved |
| `customText` | 1–3 sentences capturing the rationale or constraint that drove the choice |

Synthesis is the responsibility of the brainstorm skill — concentrating it in one place ensures consistent shape across packages.

### Where the conversation log goes

It does not. By design. The chosen synthesis pattern (decision-point Q&A) preserves the *outcomes*; the running back-and-forth is intentionally not persisted. If a user wants the raw conversation, they can copy it from the IDE transcript before the session ends. We considered "decision-point Q&A + a separate full-text comment" as alternative C and rejected it — it doubles the audit surface and creates two potentially divergent records.

## Error handling

| Scenario | Skill behavior |
|---|---|
| `chorus_pm_start_elaboration` returns error | Surface the error verbatim, halt. Per project policy [no_silent_errors], we do not swallow. The idea remains in `elaborating` status; user can retry or release. |
| `chorus_answer_elaboration` returns error | Same — surface and halt. The round exists in `pending_answers` status and will appear in the UI; the idea skill's own retry path can re-call `answer_elaboration` later if the user resumes. |
| User abandons brainstorm mid-conversation | Out of scope this round. The idea stays in `elaborating` with no completed round. Recovery (`elaborating + no active round`) is not yet detected. We accept this gap because brainstorm is opt-in and resuming via the structured path is always available as a fallback. |
| Synthesis collapses too many alternatives into one option | Caught by review: the `Anti-patterns` section in `SKILL.md` explicitly warns against pre-narrowing. Reviewers should reject brainstorm rounds whose `options` arrays are all length-2 with binary "yes/no" framing. |

## Testing

This change is documentation-only — no unit tests apply. Acceptance is **dogfood**: run the four-package skill against a deliberately fuzzy Idea (e.g. one written as a single sentence with no concrete constraints) and confirm:

1. The user is offered the brainstorm choice via `AskUserQuestion`.
2. On `yes`, the brainstorm skill is invoked, asks one question at a time, proposes 2-3 directions, and gets explicit approval.
3. A single ElaborationRound is created, with one `ElaborationQuestion` per material decision, all answered.
4. Returning to the idea skill, the agent autonomously chooses between resolve and follow-up.
5. The same flow works on each of the four distribution packages.

A "did the audit trail capture what we needed to know?" check at the end is the canonical pass criterion.

## Risks and trade-offs

- **Skill drift across the four packages.** The body is hand-synced today across `idea`, `develop`, `proposal`, etc.; same risk applies here. Mitigation: keep the `brainstorm/SKILL.md` body short and treat one of the four locations (Claude Code plugin) as canonical, copy others from it. A diff check could be added to CI but is not part of this change. Note: the byte-identity guarantee applies to `brainstorm/SKILL.md` only — `idea/SKILL.md` already differs across the four packages today on cross-skill references (the three plugin packages use `/proposal`-style invocation; `public/skill/idea-chorus/SKILL.md` uses URL-style `proposal-chorus` references). The new Step 4.5 must follow each package's existing convention, not invent a new one.
- **Synthesis quality depends on the agent.** Fabricating an `ElaborationQuestion` with a single misleading "selected" option could pollute the audit trail. Mitigated by the `Anti-patterns` section and by the review gate that the proposal-reviewer skill applies.
- **No `kind` field means brainstorm rounds are indistinguishable from structured rounds at the data layer.** Acceptable for now — anyone reading the round can tell from the question shape (decision-point options vs. enumerated alternatives) which kind it is. If we ever want UI to render them differently, that's a future change.
- **The terminal contract diverges from `superpowers/brainstorming`.** Anyone familiar with the upstream skill will need to read our `Anti-patterns` section to understand we're forking the cadence, not the contract.
