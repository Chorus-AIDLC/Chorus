---
name: idea
description: Chorus Idea workflow — claim ideas, run elaboration rounds, and prepare for proposal creation.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.0"
  category: project-management
  mcp_server: chorus
---

# Idea Skill

This skill covers the **Ideation** stage of the AI-DLC workflow: claiming Ideas, running structured elaboration rounds to clarify requirements, and preparing for Proposal creation.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_get_idea`). Bare names are used below for readability — prepend `chorus__` when invoking. See `/chorus` for the full rule.

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
| `chorus_pm_start_elaboration` | Start an elaboration round with structured questions |
| `chorus_pm_validate_elaboration` | Validate answers (resolve or create follow-up round) |
| `chorus_pm_skip_elaboration` | Skip elaboration for trivially clear Ideas |
| `chorus_answer_elaboration` | Submit answers for an elaboration round |
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

If the Idea is fuzzy and you'd struggle to enumerate concrete multi-choice questions, offer the user a brainstorm prelude before structured elaboration.

> **OpenClaw note:** there is no `AskUserQuestion` primitive. Ask the user once **as a plain-text prompt** whether they want to brainstorm first or jump straight to structured elaboration, e.g.:
>
> > "This idea is still fuzzy. Do you want to (A) brainstorm directions together first, or (B) go straight to structured elaboration? Reply A or B."

- **"Already clear" (B):** Skip to Step 5.
- **"Brainstorm first" (A):** Invoke the `/brainstorm` skill. See `/brainstorm` for the dialogue cadence and synthesis rules — do NOT re-implement them here.

When `/brainstorm` returns, you own the lifecycle decision (the brainstorm skill deliberately leaves it to you):

- If the synthesized round answers cover everything → call `chorus_pm_validate_elaboration` with `issues: []` to resolve elaboration.
- If gaps remain → call `chorus_pm_validate_elaboration` with `issues + followUpQuestions` to start a structured Round 2. Pick the depth yourself — do NOT re-prompt the user.

Either outcome ends Step 4.5; skip Step 5.

### Step 5: Elaborate on the Idea

**Every Idea should go through elaboration.** Skip only when requirements are completely unambiguous (e.g., bug fix with clear steps). Elaboration improves Proposal quality and reduces rejection cycles.

#### Simple Ideas (skip elaboration)

You may skip elaboration, but **you MUST ask the user for permission first** before calling `chorus_pm_skip_elaboration`. On OpenClaw, ask as a plain-text prompt (e.g. "This idea has clear reproduction steps. OK to skip elaboration? Reply yes/no."). Never skip on your own judgment alone.

```
chorus_pm_skip_elaboration({
  ideaUuid: "<idea-uuid>",
  reason: "Bug fix with clear reproduction steps"
})
```

#### Standard/Complex Ideas (run elaboration)

1. **Determine depth** based on idea complexity:
   - `"minimal"` — 2-4 questions (small features, minor enhancements)
   - `"standard"` — 5-10 questions (typical new features)
   - `"comprehensive"` — 10-15 questions (large features, architectural changes)

2. **Create elaboration questions:**

   > **Note:** Do NOT include an "Other" option in your questions. Treat the free-text path as always available — a user may answer any question with free text instead of picking an option.

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

3. **Present questions to the user as plain text (OpenClaw has no `AskUserQuestion`).** Render each elaboration question and its options as a readable numbered/lettered prompt and ask the user to reply with their selections (and any free-text notes). Example:

   ```
   I have a few questions to clarify this idea. Please reply with your choice for each (you can also write a free-text answer):

   1. Which new locales should be prioritized for V1?
      a) Japanese only — single locale for initial release
      b) Japanese + Korean — two East Asian locales
      (or describe your own)

   2. ...
   ```

   After the user replies, map their answers back to option IDs and call `chorus_answer_elaboration`. If the user gave a free-text answer that doesn't match an option, set `selectedOptionId: null` and put their text in `customText`.

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
   - **Free text (no option matched)**: `selectedOptionId: null, customText: "your answer"` — customText is required when no option is selected

5. **Review answers and confirm with the owner (@mention flow):**

   After answers are submitted, **@mention the answerer** (typically the agent's owner) with a summary of your understanding. This prevents misinterpretation before you validate.

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

   d. **Based on the response:**
      - **Confirmed** — Proceed to validate with empty issues
      - **Additions/corrections** — Incorporate feedback, optionally start a follow-up round
      - **Unclear** — Ask clarifying questions via another comment

6. **Validate the elaboration:**

   `chorus_pm_validate_elaboration` is the **single commit gate for the entire elaboration phase**, NOT a per-round close. Calling it with `issues: []` resolves the whole elaboration (sets `idea.elaborationStatus = "resolved"`); calling it with `issues + followUpQuestions` opens a new round while keeping elaboration in progress. Do not call validate after every round — call it once when you believe elaboration is done, or when you want to start a follow-up round.

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     issues: [],
     followUpQuestions: []
   })
   ```

   If issues are found (contradictions, ambiguities, incomplete answers), include them in `issues` and provide `followUpQuestions` for a new round:

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     issues: [
       { questionId: "q1", type: "ambiguity", description: "Role-based access selected but no roles defined" }
     ],
     followUpQuestions: [
       { id: "fq1", text: "Which specific roles should have access?", category: "functional", options: [...] }
     ]
   })
   ```

7. **Check elaboration status** at any time:
   ```
   chorus_get_elaboration({ ideaUuid: "<idea-uuid>" })
   ```

**Elaboration as audit trail:** Even if the user discusses requirements with you outside the formal elaboration flow, record key decisions as elaboration rounds so they are persisted and visible to the team.

**Question categories:** `functional`, `non_functional`, `business_context`, `technical_context`, `user_scenario`, `scope`

**Validation issue types:** `contradiction`, `ambiguity`, `incomplete`

---

## Tips

- When combining multiple ideas, explain how they relate in the proposal description
- Elaboration improves Proposal quality — don't skip it unless the requirements are trivially clear
- Present interactive questions as plain text and collect free-text replies — OpenClaw has no `AskUserQuestion` primitive
- Record decisions made in conversation as elaboration rounds for auditability
- Always @mention the owner to confirm understanding before validating

---

## Next

- Once elaboration is resolved, use `/proposal` to create a Proposal with document and task drafts
- For platform overview and shared tools, see `/chorus`
