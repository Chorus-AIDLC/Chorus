---
name: brainstorm
description: Optional divergent-then-convergent dialogue for fuzzy ideas. Invoked from the idea skill as a prelude to structured elaboration; produces one ElaborationRound of decision-point Q&A and returns control. Never writes files, never posts comments, never validates elaboration.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.0"
  category: project-management
  mcp_server: chorus
---

# Brainstorm Skill

A divergent-then-convergent dialogue cadence for ideas whose direction is still being formed. Compresses the conversation into one `ElaborationRound` of decision-point Q&A — same shape as a structured elaboration round, but the questions, options and answers are synthesized at the end of the conversation rather than asked up front.

This skill is a **producer** of one elaboration round; the **scheduler** decision (validate vs. follow-up) belongs to the calling idea skill.

---

## When invoked

Only as a sub-step of the idea skill, only after the user has explicitly opted in via `AskUserQuestion`. Never run standalone, never run without user opt-in. The expected entry point is the idea skill's "Step 4.5: Brainstorm Mode (Optional Prelude)" — see the idea skill for the surrounding flow.

---

## Hard rules

1. **One question at a time.** Each `AskUserQuestion` call MUST contain exactly one question entry. Wait for the answer before asking the next.
2. **Multi-choice preferred.** Frame each question as 2-4 options where possible. Open-ended is acceptable when options would be premature, but lean toward concrete choices.
3. **Propose 2-3 directions before stopping divergence.** Once the requirement direction is clear enough to enumerate, present 2-3 distinct approaches in a single `AskUserQuestion`. Mark exactly one as the recommended option per the host tool's `AskUserQuestion` recommendation convention (the spec does not dictate a specific marking format — follow the tool's documentation).
4. **Explicit user approval required to exit divergence.** Do NOT proceed to synthesis until the user has selected one of the proposed directions.
5. **No files written.** Do NOT write any markdown, design doc, scratch file, or any other file to disk. The conversation produces an `ElaborationRound` and nothing else on disk.
6. **No comments posted.** Do NOT call `chorus_add_comment` from this skill. Comments belong to the idea skill or the user, not to the brainstorm step.
7. **No design-doc handoff.** Do NOT invoke `writing-plans`, `writing-skills`, or any skill whose purpose is to produce a design document. The brainstorm output is the synthesized round — there is no separate doc.
8. **No `validate_elaboration` call.** Do NOT call `chorus_pm_validate_elaboration` from this skill. Whether to validate (resolve elaboration) or follow up (issues + followUpQuestions) is the calling idea skill's decision, not this skill's.

---

## Step-by-step

### 1. Gather context

Before asking the first divergent question, read the idea and surrounding project state. Mirror the idea skill's gather-context list:

```
chorus_get_idea({ ideaUuid })
chorus_get_documents({ projectUuid })
chorus_get_document({ documentUuid })   # for any document worth reading in full
chorus_get_proposals({ projectUuid, status: "approved" })   # to understand patterns
chorus_list_tasks({ projectUuid })   # to avoid duplicating existing work
chorus_get_comments({ targetType: "idea", targetUuid: ideaUuid })
```

Skim each result for: stated background, stated requirements, stated constraints, and what is conspicuously NOT stated. The gaps are the questions worth asking.

### 2. Divergent Q&A

Ask one question at a time via `AskUserQuestion`. Aim to surface:

- The **goal** the idea is trying to serve (often more abstract than the idea statement).
- The **constraints** that exclude entire branches of solution space (deadlines, compatibility, scope).
- The **success criteria** — how will the user know this is done.

Keep each question single-purpose. If you need to ask three things, that is three rounds, not one combined `AskUserQuestion`.

### 3. Propose 2-3 directions

When the goal, constraints, and success criteria are clear enough that you can name distinct approaches, present them in a single `AskUserQuestion`:

```
AskUserQuestion({
  questions: [
    {
      question: "<the convergence question>",
      header: "<short header>",
      options: [
        { label: "Option A (Recommended)", description: "<what + tradeoff>" },
        { label: "Option B", description: "<what + tradeoff>" },
        { label: "Option C", description: "<what + tradeoff>" }
      ],
      multiSelect: false
    }
  ]
})
```

The recommendation must be visibly marked to the user using the host tool's `AskUserQuestion` convention. State **why** you recommend it — usually a sentence about the dominant tradeoff.

### 4. Wait for explicit approval

Do not proceed to synthesis if the user has not selected one of the options. If the user picks "Other" with free text, treat that as a new constraint — go back to step 2 or step 3 with the refined direction.

### 5. Synthesize decision-point Q&A

For each material decision the user made during the conversation, build one `ElaborationQuestion`. A "material decision" is a moment where the user chose between alternatives or set scope explicitly. Map each decision per the synthesis spec below.

### 6. Persist the round

Call `chorus_pm_start_elaboration` with the synthesized questions:

```
chorus_pm_start_elaboration({
  ideaUuid,
  depth: "standard",
  questions: [
    { id: "q1", text: "...", category: "...", options: [...] },
    ...
  ]
})
```

Then submit the answers in one call:

```
chorus_answer_elaboration({
  ideaUuid,
  roundUuid,
  answers: [
    { questionId: "q1", selectedOptionId: "...", customText: "<rationale>" },
    ...
  ]
})
```

### 7. Return control

Stop here. Do **NOT** call `chorus_pm_validate_elaboration`. The idea skill's caller now decides:

- If the synthesized round answers cover everything → caller validates with `issues: []`.
- If gaps remain → caller validates with `issues + followUpQuestions` to start a structured Round 2.

The depth of any follow-up round is the caller's call, not yours.

---

## Synthesis spec

Each material decision becomes exactly one `ElaborationQuestion` with these fields:

| Field | Source |
|---|---|
| `text` | The decision question, phrased neutrally. Example: "Which depth-model placement?" |
| `category` | `functional`, `non_functional`, `business_context`, `technical_context`, `user_scenario`, or `scope` — derived from the topic. |
| `options` | All directions that were considered, length 2-5. Collapse near-duplicates into one option. |
| `selectedOptionId` | The id of the option the user approved. |
| `customText` | A 1-3 sentence rationale capturing the constraint or tradeoff that drove the choice. Not a transcript dump. |

Rules:

- A `customText` longer than ~3 sentences is a sign you are summarizing transcript instead of capturing rationale. Cut.
- An `options` array of length 2 with binary "yes / no" framing is a sign you pre-narrowed alternatives. Re-examine — there are usually at least three meaningfully different paths, even if two of them get rejected quickly.
- Skip "decisions" that were never genuinely contested. If the user agreed instantly to the only proposal, that is information for the idea content, not a decision-point Q&A.

---

## Anti-patterns

Do not do any of the following. Each has a specific failure mode that this skill must prevent:

- **Single-summary `customText` blob.** Compressing the entire conversation into one ElaborationQuestion with a long markdown summary in `customText`. The schema is multi-question for a reason — preserve the decision granularity.
- **Transcript-as-comment.** Posting the raw conversation log as a comment on the idea (or anywhere). The synthesized round IS the artifact. Raw transcripts pollute the audit trail with noise.
- **File writes.** Writing any markdown, design doc, plan, or scratch file to disk. There is no design doc in this flow. This is a deliberate divergence from the upstream `superpowers/brainstorming` cadence — read the design.md if confused.
- **`validate_elaboration` calls.** Closing the elaboration phase from this skill. The lifecycle decision belongs to the idea skill. Calling validate here strips the caller of its scheduler role.
- **`writing-plans` / design-doc handoff.** Invoking any skill that produces an implementation plan or design document. The Chorus pipeline already has Proposal → Document Drafts → Task Drafts for that — the brainstorm output feeds them through ElaborationRound, not through external doc skills.
- **Length-2 binary "yes / no" framings.** Reducing every decision to "do this thing — yes / no". Almost always the genuine alternatives are 3+ approaches with meaningfully different tradeoffs. Length-2 framings often mean the divergent phase ended too early.
- **Asking multiple questions in one `AskUserQuestion`.** The cadence is one question per turn during divergence, then one final convergence question with 2-3 options. Combining unrelated questions is a sign you are rushing.
