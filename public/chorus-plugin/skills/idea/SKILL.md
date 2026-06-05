---
name: idea
description: Chorus Idea workflow — claim ideas, run elaboration rounds, and prepare for proposal creation.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.4"
  category: project-management
  mcp_server: chorus
---

# Idea Skill

This skill covers the **Ideation** stage of the AI-DLC workflow: claiming Ideas, running structured elaboration rounds to clarify requirements, and preparing for Proposal creation.

---

## Overview

Ideas are the starting point of the AI-DLC pipeline. Humans (or Admin agents) create Ideas describing what they need. The PM Agent claims an Idea, runs elaboration to clarify requirements, and then moves on to `/proposal` to create a Proposal with document and task drafts.

**Idea status lifecycle (3 stored states):**

```
open --> elaborating --> elaborated
```

All post-elaboration progress (planning, building, verifying, done) is **derived** from the state of linked Proposals and Tasks. No agent should set Idea status directly beyond elaboration -- all transitions are side-effects of claiming, releasing, or completing elaboration.

---

## Tools

**Idea Management:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_create_idea` | Create a new idea in a project (on behalf of humans) |
| `chorus_claim_idea` | Claim an open idea (open -> elaborating) |
| `chorus_release_idea` | Release a claimed idea (elaborating -> open) |
| `chorus_move_idea` | Move an Idea to a different Project. Cascade-migrates the Idea, all linked Proposals (any status), all materialized Documents and Tasks, and all related Activities atomically. Comments, TaskDependency, AcceptanceCriterion, AgentSession, SessionTaskCheckin, Notification history, and Task assignees are NOT modified. Returns `moved: { proposals, documents, tasks, activities }` counts. Requires `idea:write` only — no project-level checks. |

**Requirements Elaboration:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_start_elaboration` | Generate an elaboration round (first, follow-up, or appended-after-resolution) |
| `chorus_pm_validate_elaboration` | Mark the whole elaboration complete (requires `idea:admin`; requires human confirmation first) |
| `chorus_pm_skip_elaboration` | Skip elaboration for trivially clear Ideas |
| `chorus_answer_elaboration` | Submit answers for an elaboration round (`roundUuid` optional — auto-locates the active round) |
| `chorus_get_elaboration` | Get full elaboration state (rounds, questions, answers) |

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts.

### Step 2: Find Work

```
chorus_get_available_ideas({ projectUuid: "<project-uuid>" })
```

Or check existing assignments:

```
chorus_get_my_assignments()
```

### Step 3: Claim an Idea

Claiming automatically transitions the Idea to `elaborating` status:

```
chorus_claim_idea({ ideaUuid: "<idea-uuid>" })
```

### Step 4: Gather Context

Before elaborating, understand the full picture:

1. **Read the idea in detail:**
   ```
   chorus_get_idea({ ideaUuid: "<idea-uuid>" })
   ```

2. **Read existing project documents** (for context, tech stack, conventions):
   ```
   chorus_get_documents({ projectUuid: "<project-uuid>" })
   chorus_get_document({ documentUuid: "<doc-uuid>" })
   ```

3. **Review past proposals** (to understand patterns and standards):
   ```
   chorus_get_proposals({ projectUuid: "<project-uuid>", status: "approved" })
   ```

4. **Check existing tasks** (to avoid duplication):
   ```
   chorus_list_tasks({ projectUuid: "<project-uuid>" })
   ```

5. **Read comments** on the idea for additional context:
   ```
   chorus_get_comments({ targetType: "idea", targetUuid: "<idea-uuid>" })
   ```

### Step 4.5: Brainstorm Mode (Optional Prelude)

If the Idea is fuzzy and you'd struggle to enumerate concrete multi-choice questions, offer the user a brainstorm prelude before structured elaboration. Ask once via `AskUserQuestion` (header `"Brainstorm"`, two options: `"Already clear, run structured elaboration"` and `"Brainstorm first to explore directions"`).

- **"Already clear":** Skip to Step 5.
- **"Brainstorm first":** Invoke the `/brainstorm` skill. See `/brainstorm` for the dialogue cadence and synthesis rules — do NOT re-implement them here.

When `/brainstorm` returns, you own the lifecycle decision (the brainstorm skill deliberately leaves it to you):

- If the synthesized round answers cover everything → obtain human confirmation, then call `chorus_pm_validate_elaboration` to resolve the elaboration. (Resolve needs `idea:admin` — see Step 5.6 if your key is `pm_agent`-preset.)
- If gaps remain → call `chorus_pm_start_elaboration` again to open a structured Round 2. Pick the depth yourself — do NOT re-prompt the user.

Either outcome ends Step 4.5; skip Step 5.

### Step 5: Elaborate on the Idea

**Every Idea should go through elaboration.** Skip only when requirements are completely unambiguous (e.g., bug fix with clear steps). Elaboration improves Proposal quality and reduces rejection cycles.

#### Simple Ideas (skip elaboration)

You may skip elaboration, but **you MUST ask the user for permission first** via AskUserQuestion before calling `chorus_pm_skip_elaboration`. Never skip on your own judgment alone.

```
chorus_pm_skip_elaboration({
  ideaUuid: "<idea-uuid>",
  reason: "Bug fix with clear reproduction steps"
})
```

#### Standard/Complex Ideas (run elaboration)

> **Elaboration is a loop, not a straight line.** Steps 2–5 below are **one round**. Keep looping back to `chorus_pm_start_elaboration` (a new round) until every open question is settled, then resolve **once** in Step 6. You re-enter the loop whenever:
> - the answers to a round **derive new questions** or surface a contradiction/gap, **or**
> - at the resolve gate (Step 5d / Step 6) the **human raises a new concern or correction**.
>
> Each new round is just another `chorus_pm_start_elaboration` call — there is no separate "follow-up" flag, and you do not resolve until the loop is genuinely done. Round cap is 10.

1. **Determine depth** based on idea complexity:
   - `"minimal"` — 2-4 questions (small features, minor enhancements)
   - `"standard"` — 5-10 questions (typical new features)
   - `"comprehensive"` — 10-15 questions (large features, architectural changes)

2. **Create elaboration questions:**

   > **Note:** Do NOT include an "Other" option in your questions. The UI automatically adds a free-text "Other" option to every question.

   ```
   chorus_pm_start_elaboration({
     ideaUuid: "<idea-uuid>",
     depth: "standard",
     questions: [
       {
         id: "q1",
         text: "What user roles should have access to this feature?",
         category: "functional",
         options: [
           { id: "a", label: "All users" },
           { id: "b", label: "Admin only" },
           { id: "c", label: "Role-based (configurable)" }
         ]
       }
     ]
   })
   ```

3. **Present questions to the user — MUST use `AskUserQuestion`.** Do NOT display questions as plain text. Map each elaboration question to an AskUserQuestion call (max 4 questions per call; batch if needed):

   ```
   AskUserQuestion({
     questions: [
       {
         question: "Which new locales should be prioritized for V1?",
         header: "Scope",
         options: [
           { label: "Japanese only", description: "Single locale for initial release" },
           { label: "Japanese + Korean", description: "Two East Asian locales" }
         ],
         multiSelect: false
       }
     ]
   })
   ```

   After the user answers, map their selections back to option IDs and call `chorus_answer_elaboration`. If the user selected "Other", set `selectedOptionId: null` and `customText` to their input.

4. **Submit answers:**
   ```
   chorus_answer_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     answers: [
       { questionId: "q1", selectedOptionId: "c", customText: null },
       { questionId: "q2", selectedOptionId: null, customText: "Custom hybrid approach" }
     ]
   })
   ```

   Answer format:
   - **Select an option**: `selectedOptionId: "a", customText: null`
   - **Select an option + add a note**: `selectedOptionId: "a", customText: "additional context"`
   - **Choose "Other" (free text)**: `selectedOptionId: null, customText: "your answer"` — customText is required when no option is selected

   > `roundUuid` is **optional** on `chorus_answer_elaboration`. Omit it and the service auto-locates the Idea's single active (`pending_answers`) round. Pass it explicitly only when you need to target a specific round.

5. **Review answers and confirm with the owner (@mention flow):**

   After answers are submitted, **@mention the answerer** (typically the agent's owner) with a summary of your understanding. This prevents misinterpretation before you resolve.

   a. **Get owner info** from checkin response (`agent.owner`) or search:
      ```
      chorus_search_mentionables({ query: "owner-name" })
      ```

   b. **Post a summary comment** on the idea:
      ```
      chorus_add_comment({
        targetType: "idea",
        targetUuid: "<idea-uuid>",
        content: "@[Owner Name](user:owner-uuid) I've reviewed the elaboration answers. Here's my understanding:\n\n- Key requirement 1: ...\n- Key requirement 2: ...\n\nDoes this match your intent?"
      })
      ```

   c. **Wait for confirmation** via comments.

   d. **Based on the response — this is the loop decision point:**
      - **Confirmed, nothing left to discuss** — Treat this as the human confirmation required to resolve; proceed to Step 6 and call `chorus_pm_validate_elaboration`.
      - **Human raises a new concern / correction / question** — Do **NOT** resolve. Loop back: open a **new round** with `chorus_pm_start_elaboration` capturing the new questions, collect answers (Steps 2–5 again), and re-confirm. Repeat until the human has no remaining concerns.
      - **The answers themselves derived new questions or a contradiction** — Same as above: loop back to `chorus_pm_start_elaboration` for another round before resolving.
      - **Unclear** — Ask clarifying questions via another comment, then continue the loop.

6. **Resolve the elaboration (the single commit gate — only when the loop is done):**

   Resolving marks the **whole elaboration phase** complete — it sets `idea.elaborationStatus = "resolved"` (Idea → `elaborated`), which is the gating signal that lets a downstream Proposal be submitted. It is an **Idea-level** action (takes only `ideaUuid`, does not target a round). Resolve **once**, only after the Step 5d loop has fully settled — every derived question answered and the human has no remaining concerns. If anything is still open, go back to `chorus_pm_start_elaboration` instead of resolving.

   > **Precondition:** resolve requires the Idea to have at least one round and **every** round to be fully answered (none left in `pending_answers`). If a round still has open questions, answer it (or it'll be rejected).

   > **⚠️ Human confirmation required.** Outside YOLO automation you MUST obtain explicit human confirmation before resolving. The "Confirmed" reply in step 5d above counts as that confirmation. Never resolve on your own judgment alone.

   > **Permission (N1): `chorus_pm_validate_elaboration` requires `idea:admin`.** The `pm_agent` preset only grants `idea:write`, so a PM-preset agent **cannot** resolve — it must hand off to an `admin_agent`-preset agent (or an admin-preset API key) to perform the resolve. If your key lacks `idea:admin`, surface this to the human and request the handoff instead of failing silently.

   > **Assignee precondition (N2):** the resolving actor must be the Idea's **assignee**. A separate human reviewer resolving a PM-owned Idea therefore needs **both** `idea:admin` **and** to be assigned the Idea (claim/reassign it first). Admin permission alone is not enough.

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>"
   })
   ```

   **Want a follow-up round instead of resolving?** Just call `chorus_pm_start_elaboration` again — there is no separate "open a round" flag. It works while still `elaborating` (a normal follow-up round) and, after you've already resolved, as an **appended round** (`isAppended: true`) that keeps the Idea `elaborated` and never blocks an in-flight Proposal. Per-question issue tagging no longer exists.

7. **Check elaboration status** at any time:
   ```
   chorus_get_elaboration({ ideaUuid: "<idea-uuid>" })
   ```

**Elaboration as audit trail:** Even if the user discusses requirements with you outside the formal elaboration flow, record key decisions as elaboration rounds so they are persisted and visible to the team.

**Question categories:** `functional`, `non_functional`, `business_context`, `technical_context`, `user_scenario`, `scope`

---

## Tips

- When combining multiple ideas, explain how they relate in the proposal description
- Elaboration improves Proposal quality — don't skip it unless the requirements are trivially clear
- Use `AskUserQuestion` for all interactive questions — never plain text
- Record decisions made in conversation as elaboration rounds for auditability
- Always @mention the owner to confirm understanding before resolving

---

## Next

- Once elaboration is resolved, use `/proposal` to create a Proposal with document and task drafts
- For platform overview and shared tools, see `/chorus`
