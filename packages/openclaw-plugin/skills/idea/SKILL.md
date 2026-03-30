---
name: idea
description: Chorus Idea workflow — claim ideas, run elaboration, and prepare for proposal.
metadata:
  openclaw:
    emoji: "💡"
---

# Idea Skill

This skill covers the **Ideation** stage of the AI-DLC workflow: claiming Ideas, running structured elaboration rounds to clarify requirements, and preparing for Proposal creation.

---

## Overview

Ideas are the starting point of the AI-DLC pipeline. Humans (or Admin agents) create Ideas describing what they need. The PM Agent claims an Idea, runs elaboration to clarify requirements, and then moves on to `/proposal` to create a Proposal with document and task drafts.

### Idea Lifecycle

```
open --> elaborating --> proposal_created --> completed
                   \--> closed
```

| Status | Meaning |
|--------|---------|
| `open` | Idea is available for an agent to claim |
| `elaborating` | An agent has claimed the idea and is gathering requirements |
| `proposal_created` | A Proposal has been created from this idea |
| `completed` | The resulting Proposal was approved and work is done |
| `closed` | Idea was closed without implementation |

Claiming an idea automatically transitions it from `open` to `elaborating`.

---

## Tools

**Idea Management:**

| Tool | Purpose |
|------|---------|
| `chorus_claim_idea` | Claim an open idea (open -> elaborating) |
| `chorus_get_available_ideas` | List open ideas in a project available to claim |
| `chorus_get_idea` | Get detailed information for a single idea |
| `chorus_get_ideas` | List ideas in a project with optional status filter |
| `chorus_pm_create_idea` | Create a new idea in a project |
| `chorus_move_idea` | Move an idea to a different project (also moves linked draft/pending proposals) |

**Requirements Elaboration:**

| Tool | Purpose |
|------|---------|
| `chorus_start_elaboration` | Start an elaboration round with structured questions |
| `chorus_validate_elaboration` | Validate answers — empty issues = resolved, with issues = follow-up round |
| `chorus_answer_elaboration` | Submit answers for an elaboration round |
| `chorus_get_elaboration` | Get full elaboration state (all rounds, questions, answers) |

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## SSE Wake Events (OpenClaw-Specific)

OpenClaw is a single-agent model with SSE-driven wake. The following notification events trigger the agent to wake and act:

| SSE Event | Trigger | Agent Action |
|-----------|---------|--------------|
| `idea_claimed` | An idea is assigned to you | Wake, review the idea with `chorus_get_idea`, claim it if not auto-claimed |
| `elaboration_requested` | Elaboration round started on an idea you own | Wake, review questions with `chorus_get_elaboration` |
| `elaboration_answered` | Answers submitted for your elaboration round | Wake, review answers, validate or create follow-up round |

When an SSE event fires, the plugin's event router fetches the notification details and triggers the agent with context (ideaUuid, projectUuid, action). You do not need to poll — work arrives via these events.

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

**Every Idea should go through elaboration.** Elaboration improves Proposal quality and reduces rejection cycles.

#### Elaboration Depth

Determine depth based on idea complexity:

- `"minimal"` — 2-4 questions (small features, minor enhancements)
- `"standard"` — 5-10 questions (typical new features)
- `"comprehensive"` — 10-15 questions (large features, architectural changes)

#### Question Categories

`functional`, `non_functional`, `business_context`, `technical_context`, `user_scenario`, `scope`

#### Starting an Elaboration Round

> **Note:** Do NOT include an "Other" option in your questions. The UI automatically adds a free-text "Other" option to every question.

```
chorus_start_elaboration({
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
    },
    {
      id: "q2",
      text: "What is the expected data volume?",
      category: "non_functional",
      options: [
        { id: "a", label: "Low (<1000 records)" },
        { id: "b", label: "Medium (1K-100K records)" },
        { id: "c", label: "High (>100K records)" }
      ]
    }
  ]
})
```

This triggers an `elaboration_requested` SSE event to stakeholders.

#### Submitting Answers

When answers arrive (via `elaboration_answered` SSE wake event or manual flow):

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

#### @Mention Workflow After Answers

After answers are submitted, **@mention the answerer** with a summary of your understanding. This prevents misinterpretation before you validate.

1. **Get mentionable info:**
   ```
   chorus_search_mentionables({ query: "owner-name" })
   ```

2. **Post a summary comment** on the idea:
   ```
   chorus_add_comment({
     targetType: "idea",
     targetUuid: "<idea-uuid>",
     content: "@[Owner Name](user:owner-uuid) I've reviewed the elaboration answers. Here's my understanding:\n\n- Key requirement 1: ...\n- Key requirement 2: ...\n\nDoes this match your intent?"
   })
   ```

3. **Wait for confirmation** via comments or a `mentioned` SSE event.

4. **Based on the response:**
   - **Confirmed** — Proceed to validate with empty issues
   - **Additions/corrections** — Incorporate feedback, optionally start a follow-up round
   - **Unclear** — Ask clarifying questions via another comment

#### Validating the Elaboration

When answers are satisfactory:

```
chorus_validate_elaboration({
  ideaUuid: "<idea-uuid>",
  roundUuid: "<round-uuid>",
  issues: []
})
```

If issues are found (contradictions, ambiguities, incomplete answers), include them and provide follow-up questions for a new round:

```
chorus_validate_elaboration({
  ideaUuid: "<idea-uuid>",
  roundUuid: "<round-uuid>",
  issues: [
    { questionId: "q1", type: "ambiguity", description: "Role-based access selected but no roles defined" }
  ],
  followUpQuestions: [
    {
      id: "fq1",
      text: "Which specific roles should have access?",
      category: "functional",
      options: [
        { id: "a", label: "Admin + Editor" },
        { id: "b", label: "All authenticated users" }
      ]
    }
  ]
})
```

This starts a new elaboration round, triggering another `elaboration_requested` event. The cycle repeats until all issues are resolved.

**Validation issue types:** `contradiction`, `ambiguity`, `incomplete`

#### Multi-Round Elaboration

Complex ideas may require multiple rounds:

1. Round 1: Broad scoping questions (functional, scope)
2. Round 2: Follow-up on ambiguous answers (technical_context)
3. Round 3: Final confirmation of edge cases (user_scenario)

Each round preserves the full history. Use `chorus_get_elaboration` at any time to see all rounds and their status.

#### Checking Elaboration Status

```
chorus_get_elaboration({ ideaUuid: "<idea-uuid>" })
```

Returns all rounds, questions, answers, and a progress summary.

---

## Tips

- When combining multiple ideas, explain how they relate in the proposal description
- Elaboration improves Proposal quality — run it for all non-trivial ideas
- Record decisions made in conversation as elaboration rounds for auditability
- Always @mention the owner to confirm understanding before validating
- SSE events mean you do not need to poll — the plugin wakes you when action is needed

---

## Next

- Once elaboration is resolved, use `/proposal` to create a Proposal with document and task drafts
- For platform overview and shared tools, see `/chorus`
