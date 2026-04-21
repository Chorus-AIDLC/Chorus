---
name: idea
description: Chorus Idea workflow — claim ideas, run elaboration rounds, and prepare for proposal creation.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.7.3"
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
| `chorus_move_idea` | Move an idea to a different project (also moves linked draft/pending proposals) |

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
- Use `AskUserQuestion` for all interactive questions — never plain text
- Record decisions made in conversation as elaboration rounds for auditability
- Always @mention the owner to confirm understanding before validating

---

## Next

- Once elaboration is resolved, use `/proposal` to create a Proposal with document and task drafts
- For platform overview and shared tools, see `/chorus`
