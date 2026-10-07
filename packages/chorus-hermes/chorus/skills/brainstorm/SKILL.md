---
name: brainstorm
description: Optional divergent-then-convergent dialogue for fuzzy ideas on Hermes. Invoked from the idea skill as a prelude to structured elaboration; asks one question at a time (in chat, or as single-question elaboration rounds when no human is in chat), produces one ElaborationRound of decision-point Q&A and returns control. Never writes files, never posts summary or transcript comments, never resolves elaboration.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.22.0"
  category: project-management
  mcp_server: chorus
---

# Brainstorm Skill

A divergent-then-convergent dialogue cadence for ideas whose direction is still being formed. Compresses the conversation into one `ElaborationRound` of decision-point Q&A — same shape as a structured elaboration round, but the questions, options and answers are synthesized at the end of the conversation rather than asked up front.

This skill is a **producer** of one elaboration round; the **scheduler** decision (resolve vs. follow-up) belongs to the calling idea skill.

---

## When invoked

Only as a sub-step of the idea skill, only after the user has explicitly opted in (a yes to the brainstorm offer, given in chat or as a reply to the idea skill's @mention comment). Never run standalone, never run without user opt-in. The expected entry point is the idea skill's "Step 4.5: Brainstorm Mode (Optional Prelude)" — load it with `skill_view("chorus:idea")` to see the surrounding flow.

---

## How a brainstorm question reaches the human

Every question in this skill is asked **one at a time**, through one of two channels. Pick the channel from the session you are in:

- **Interactive mode — the human is in chat** (a Hermes CLI/TUI session where the human is typing to you): ask the question directly in the chat. Number it, list the options with letters (`a`, `b`, `c`…), mark your recommended option, and wait for the reply. Do not create an elaboration round per chat question — the synthesized round in Step 6 is the audit trail for interactive brainstorms.
- **Gateway mode — Chorus woke you, or no human is in chat** (a `hermes gateway` turn triggered by a Chorus notification, in the session keyed `idea:<ideaUuid>`): each question becomes **one single-question elaboration round**:
  1. `chorus_pm_start_elaboration({ ideaUuid, depth: "minimal", questions: [ <exactly one question> ] })`. Prefix brainstorm question ids with `bs` (`bs1`, `bs2`, …) so the rounds are recognizable when you resume.
  2. Post **one** pointer comment on the Idea with `chorus_add_comment` that @mentions the owner (`@[Name](user:<ownerUuid>)`, owner from the `## Checkin` the Chorus Hermes plugin injected, or `chorus_checkin`), e.g. `"@[Owner](user:<uuid>) Brainstorm question <n> is waiting in the elaboration panel: <one-line question>."` The comment only points at the round; it never carries a summary or transcript.
  3. **END THE TURN.** Do not poll. The gateway wakes you (same `idea:<ideaUuid>` session) when the round is answered or the owner replies.
  4. On wake, re-read `chorus_get_elaboration({ ideaUuid })` to recover the answers so far (context may have been compressed), then continue with the next single question.

  Each gateway round counts toward the Idea's 10-round cap, and the caller still needs room for a follow-up structured round. Keep gateway brainstorms tight: few divergent questions, then the convergence question.

The Chorus UI adds a free-text "Other" to every round question automatically — do not add one yourself. In chat, the human may always answer in free text.

---

## Research boundary

Reuse the calling Idea's findings and follow the shared research rules (`skill_view("chorus:research")`); switching into brainstorm does not grant a second investigation. If the goal needed focusing first, after the user selects a direction and before synthesis, apply the caller's optional research decision once with that focus. Return any findings alongside the synthesized round for the Idea caller to persist. Research does not choose the user's direction, remove the opt-in/selection gate, write files/comments, or resolve elaboration.

## Hard rules

1. **One question at a time.** Each chat message asks exactly one question; in gateway mode each `chorus_pm_start_elaboration` call contains exactly one question entry. Wait for the answer before asking the next.
2. **Multi-choice preferred.** Frame each question as 2-4 options where possible. Open-ended is acceptable when options would be premature, but lean toward concrete choices. (A round question always needs 2-5 options; if you truly need an open question in gateway mode, give your best-guess options and let the human use "Other".)
3. **Propose 2-3 directions before stopping divergence.** Once the requirement direction is clear enough to enumerate, present 2-3 distinct approaches in a single question (one chat question, or one single-question round). Mark exactly one as recommended: in chat append `(Recommended)` to that option; in a round, append ` (Recommended)` to that option's `label` and say why in its `description`.
4. **Explicit user approval required to exit divergence.** Do NOT proceed to synthesis until the user has selected one of the proposed directions.
5. **No files written.** Do NOT write any markdown, design doc, scratch file, or any other file to disk. The conversation produces an `ElaborationRound` and nothing else on disk.
6. **No summary or transcript comments.** Do NOT use `chorus_add_comment` for anything except the gateway-mode pointer comment described above (one short @mention per pending single-question round). Summaries, confirmations and discussion belong to the idea skill or the user, not to the brainstorm step.
7. **No design-doc handoff.** Do NOT invoke any skill whose purpose is to produce a design document or implementation plan. The brainstorm output is the synthesized round — there is no separate doc.
8. **No `validate_elaboration` call.** Do NOT call `chorus_pm_validate_elaboration` from this skill. Whether to resolve the elaboration or open a follow-up round (`chorus_pm_start_elaboration` again) is the calling idea skill's decision, not this skill's.
9. **Never answer on the human's behalf.** Divergent and convergence questions are answered by the human (in chat or in the Chorus UI). The only answers you submit yourself are the Step 6 synthesized round, which records decisions the human already made.

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

Ask one question at a time through the channel chosen above. Aim to surface:

- The **goal** the idea is trying to serve (often more abstract than the idea statement).
- The **constraints** that exclude entire branches of solution space (deadlines, compatibility, scope).
- The **success criteria** — how will the user know this is done.

Keep each question single-purpose. If you need to ask three things, that is three questions (three chat turns, or three single-question rounds), not one combined question.

Interactive example:

```
Question 1 — What is the main goal behind this idea?
  a) Cut onboarding time for new users (Recommended — the idea text leans this way)
  b) Reduce support load on the team
  c) Unblock a specific customer request
Reply with a letter, or describe something else.
```

Gateway example (one round, then the pointer comment, then end the turn):

```
chorus_pm_start_elaboration({
  ideaUuid,
  depth: "minimal",
  questions: [
    {
      id: "bs1",
      text: "What is the main goal behind this idea?",
      category: "business_context",
      options: [
        { id: "a", label: "Cut onboarding time (Recommended)", description: "The idea text leans this way" },
        { id: "b", label: "Reduce support load" },
        { id: "c", label: "Unblock a specific customer request" }
      ]
    }
  ]
})
```

### 3. Propose 2-3 directions

When the goal, constraints, and success criteria are clear enough that you can name distinct approaches, present them in a single convergence question.

Interactive:

```
Question <n> — <the convergence question>
  a) Option A (Recommended) — <what + tradeoff>
  b) Option B — <what + tradeoff>
  c) Option C — <what + tradeoff>
Why I recommend A: <one sentence about the dominant tradeoff>.
```

Gateway (one single-question round, then the pointer comment, then end the turn):

```
chorus_pm_start_elaboration({
  ideaUuid,
  depth: "minimal",
  questions: [
    {
      id: "bs<n>",
      text: "<the convergence question>",
      category: "<derived category>",
      options: [
        { id: "a", label: "Option A (Recommended)", description: "<what + tradeoff>. Recommended because <dominant tradeoff>." },
        { id: "b", label: "Option B", description: "<what + tradeoff>" },
        { id: "c", label: "Option C", description: "<what + tradeoff>" }
      ]
    }
  ]
})
```

The recommendation must be visibly marked to the user. State **why** you recommend it — usually a sentence about the dominant tradeoff.

### 4. Wait for explicit approval

Do not proceed to synthesis if the user has not selected one of the options. If the user picks "Other" (or replies in free text), treat that as a new constraint — go back to step 2 or step 3 with the refined direction.

### 5. Synthesize decision-point Q&A

For each material decision the user made during the conversation, build one `ElaborationQuestion`. A "material decision" is a moment where the user chose between alternatives or set scope explicitly. Map each decision per the synthesis spec below. In gateway mode, read the answered `bs*` rounds with `chorus_get_elaboration` as your source.

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

Then submit the answers in one call (these record the human's own decisions; they are not answers on the human's behalf):

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

- If the synthesized round answers cover everything → caller obtains human confirmation, then resolves with `chorus_pm_validate_elaboration`.
- If gaps remain → caller opens a structured Round 2 by calling `chorus_pm_start_elaboration` again.

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
- **Transcript-as-comment.** Posting the raw conversation log as a comment on the idea (or anywhere). The synthesized round IS the artifact. Raw transcripts pollute the audit trail with noise. The gateway pointer comment is one line that points at a pending round — nothing more.
- **File writes.** Writing any markdown, design doc, plan, or scratch file to disk. There is no design doc in this flow. The brainstorm output is the synthesized round, not an external document.
- **`validate_elaboration` calls.** Closing the elaboration phase from this skill. The lifecycle decision belongs to the idea skill. Calling it here strips the caller of its scheduler role.
- **Design-doc handoff.** Invoking any skill that produces an implementation plan or design document. The Chorus pipeline already has Proposal → Document Drafts → Task Drafts for that — the brainstorm output feeds them through ElaborationRound, not through external doc skills.
- **Length-2 binary "yes / no" framings.** Reducing every decision to "do this thing — yes / no". Almost always the genuine alternatives are 3+ approaches with meaningfully different tradeoffs. Length-2 framings often mean the divergent phase ended too early.
- **Asking multiple questions at once.** The cadence is one question per turn during divergence (one chat question, or one single-question round), then one final convergence question with 2-3 options. Combining unrelated questions in one message or one round is a sign you are rushing.
- **Polling in gateway mode.** Looping on `chorus_get_elaboration` waiting for the human. Post the pointer comment and end the turn; the gateway wakes you.
