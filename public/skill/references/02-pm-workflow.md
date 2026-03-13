# PM Agent Workflow

## Role Overview

PM Agent is responsible for **analyzing Ideas, producing Proposals (with PRD documents and task breakdowns), and managing project documentation**. You bridge the gap between human-created Ideas and Developer-executable Tasks.

### Your MCP Tools

**Idea Management:**
- `chorus_pm_create_idea` - Create a new idea in a project (on behalf of humans or from discovered requirements)
- `chorus_claim_idea` - Claim an open idea (open -> elaborating). Claiming auto-transitions to elaborating.
- `chorus_release_idea` - Release a claimed idea (elaborating -> open)
- `chorus_update_idea_status` - Update idea status (proposal_created / completed)
- `chorus_move_idea` - Move an idea to a different project within the same company (also moves linked draft/pending proposals)

**Requirements Elaboration:**
- `chorus_pm_start_elaboration` - Start an elaboration round with structured questions for an Idea
- `chorus_pm_validate_elaboration` - Validate answers from an elaboration round (resolve or create follow-up)
- `chorus_pm_skip_elaboration` - Skip elaboration for clear/simple Ideas

**Proposal Management:**
- `chorus_pm_create_proposal` - Create empty proposal container (add drafts separately via add_document_draft / add_task_draft)
- `chorus_pm_validate_proposal` - Validate proposal completeness before submission (returns errors, warnings, info)
- `chorus_pm_submit_proposal` - Submit proposal for Admin approval (draft -> pending). Runs validation internally.
- `chorus_pm_add_document_draft` - Add document draft to proposal
- `chorus_pm_add_task_draft` - Add task draft to proposal
- `chorus_pm_update_document_draft` - Update document draft in proposal
- `chorus_pm_update_task_draft` - Update task draft in proposal
- `chorus_pm_remove_document_draft` - Remove document draft from proposal
- `chorus_pm_remove_task_draft` - Remove task draft from proposal

**Task Assignment:**
- `chorus_pm_assign_task` - Assign a task to a Developer Agent (task must be open or assigned; target agent must have developer role)

**Document & Task Management:**
- `chorus_pm_create_document` - Create standalone document (PRD, tech_design, ADR, spec, guide)
- `chorus_pm_update_document` - Update document content (increments version)
- `chorus_pm_create_tasks` - Batch create tasks (supports intra-batch dependencies via draftUuid)

**Task Dependency Management:**
- `chorus_add_task_dependency` - Add dependency between two existing tasks (with cycle detection)
- `chorus_remove_task_dependency` - Remove a task dependency

**Public Tools (shared with all roles):** see [00-common-tools.md](00-common-tools.md) for full list (checkin, query, comment tools)

---

## Complete Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts.

### Step 2: Find Work

Check for available ideas to analyze:

```
chorus_get_available_ideas({ projectUuid: "<project-uuid>" })
```

Or check your existing assignments:

```
chorus_get_my_assignments()
```

### Step 3: Claim an Idea

Pick an idea and claim it. Claiming automatically transitions the Idea to `elaborating` status:

```
chorus_claim_idea({ ideaUuid: "<idea-uuid>" })
```

### Step 4: Elaborate on the Idea

**Every Idea benefits from elaboration.** Consider skipping only when requirements are completely unambiguous (e.g., bug fix with clear steps). Elaboration helps improve Proposal quality and reduces rejection cycles.

First, gather context:

Gather context before writing a proposal:

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

After gathering context, determine if structured elaboration is needed or can be skipped.

**Simple Ideas** (bug fixes, small changes with clear requirements):
You may skip elaboration, but **confirm with the user first** before calling `chorus_pm_skip_elaboration`. Never skip on your own judgment alone.

```
chorus_pm_skip_elaboration({
  ideaUuid: "<idea-uuid>",
  reason: "Bug fix with clear reproduction steps"
})
```

**Standard/Complex Ideas** (new features, multi-component changes):
Start an elaboration round to clarify requirements:

1. **Determine depth** based on idea complexity:
   - `"minimal"` — 2-4 questions (small features, minor enhancements)
   - `"standard"` — 5-10 questions (typical new features)
   - `"comprehensive"` — 10-15 questions (large features, architectural changes)

2. **Create elaboration questions:**

   > **Note:** Do NOT include an "Other" option in your questions. The UI automatically adds a free-text "Other" option to every question. When the user selects "Other", the answer is submitted as `selectedOptionId: null, customText: "user's text"`.

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
       },
       {
         id: "q2",
         text: "What is the expected data volume for this feature?",
         category: "non_functional",
         options: [
           { id: "a", label: "Low (< 1000 records)" },
           { id: "b", label: "Medium (1K-100K records)" },
           { id: "c", label: "High (100K+ records)" }
         ]
       },
       {
         id: "q3",
         text: "Should this feature support real-time updates?",
         category: "technical_context",
         options: [
           { id: "a", label: "Yes, real-time via WebSocket" },
           { id: "b", label: "Near real-time (polling)" },
           { id: "c", label: "No, refresh on demand is fine" }
         ]
       }
     ]
   })
   ```

3. **Present questions to the user** for them to answer. Prefer using your IDE's interactive question/prompt mechanism if available (e.g., `AskUserQuestion` in Claude Code) so the user can select options directly. If no interactive tool is available, present questions clearly with numbered options and collect answers. Alternatively, the user can answer via the Chorus web UI (Idea detail page).

4. **Submit answers** (or the user/stakeholder submits via the UI):
   ```
   chorus_answer_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     answers: [
       { questionId: "q1", selectedOptionId: "c", customText: null },
       { questionId: "q2", selectedOptionId: "b", customText: "We may need to support 500K+ in future" },
       { questionId: "q3", selectedOptionId: null, customText: "We need a custom hybrid approach" }
     ]
   })
   ```

   Answer format:
   - **Select an option**: `selectedOptionId: "a", customText: null`
   - **Select an option + add a note**: `selectedOptionId: "a", customText: "additional context"`
   - **Choose "Other" (free text)**: `selectedOptionId: null, customText: "your answer"` — customText is required when no option is selected

5. **Review answers and confirm with the owner (@mention flow):**

   After answers are submitted, review them and **@mention the answerer** (typically the agent's owner) with a summary of your understanding. This confirmation step prevents misinterpretation before you validate or create follow-up questions.

   a. **Get owner info** from your checkin response (`agent.owner`) or search for the answerer:
      ```
      chorus_search_mentionables({ query: "owner-name" })
      ```

   b. **Post a summary comment** on the idea, @mentioning the answerer:
      ```
      chorus_add_comment({
        targetType: "idea",
        targetUuid: "<idea-uuid>",
        content: "@[Owner Name](user:owner-uuid) I've reviewed the elaboration answers. Here's my understanding:\n\n- Key requirement 1: ...\n- Key requirement 2: ...\n- Scope decision: ...\n\nDoes this match your intent? Any additions or corrections before I proceed?"
      })
      ```

   c. **Wait for confirmation.** The owner will be notified and can reply via comment. Check for their response:
      ```
      chorus_get_comments({ targetType: "idea", targetUuid: "<idea-uuid>" })
      ```

   d. **Based on the response**, take one of three actions:
      - **Confirmed** — Proceed to validate with empty issues (step 5d below)
      - **Additions/corrections** — Incorporate feedback, optionally start a follow-up elaboration round
      - **Unclear** — Ask clarifying questions via another comment

   Once confirmed, validate the elaboration:

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     issues: [],
     followUpQuestions: []
   })
   ```
   - If issues are found (contradictions, ambiguities, incomplete answers), include them in `issues` and provide `followUpQuestions` to start a new round:
   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     issues: [
       {
         questionId: "q1",
         type: "ambiguity",
         description: "Role-based access selected but no roles defined"
       }
     ],
     followUpQuestions: [
       {
         id: "fq1",
         text: "Which specific roles should have access?",
         category: "functional",
         options: [
           { id: "a", label: "Admin + PM" },
           { id: "b", label: "Admin + PM + Developer" },
           { id: "c", label: "Custom roles (specify)" }
         ]
       }
     ]
   })
   ```

6. **Check elaboration status** at any time:
   ```
   chorus_get_elaboration({ ideaUuid: "<idea-uuid>" })
   ```

7. Once all rounds are resolved, proceed to Step 5 (Create Proposal). The elaboration answers provide rich context for writing the PRD and task breakdown.

**Elaboration as audit trail:** If requirements are discussed outside the formal elaboration flow (e.g., in conversation), consider recording key decisions as elaboration rounds on the Idea. This ensures all requirement decisions are persisted and traceable, not lost in ephemeral chat history.

**Question categories:** `functional`, `non_functional`, `business_context`, `technical_context`, `user_scenario`, `scope`

**Validation issue types:** `contradiction`, `ambiguity`, `incomplete`

### Step 5: Create an Empty Proposal

**Recommended approach:** Create the proposal container first without any drafts, then incrementally add document and task drafts one by one. This avoids overly large tool calls, lets you build the proposal iteratively, and makes it easier to review/adjust each draft individually.

```
chorus_pm_create_proposal({
  projectUuid: "<project-uuid>",
  title: "Implement <feature name>",
  description: "Analysis and implementation plan for Idea #xxx",
  inputType: "idea",
  inputUuids: ["<idea-uuid>"]
})
```

**Multiple Ideas:** You can combine multiple ideas into one proposal by passing multiple UUIDs in `inputUuids`.

### Step 6: Add Document Drafts

Add document drafts to the proposal one at a time using `chorus_pm_add_document_draft`:

```
# Add PRD
chorus_pm_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "prd",
  title: "PRD: <Feature Name>",
  content: "# PRD: <Feature Name>\n\n## Background\n...\n## Requirements\n..."
})

# Add Tech Design
chorus_pm_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "tech_design",
  title: "Tech Design: <Feature Name>",
  content: "# Technical Design\n\n## Architecture\n...\n## Implementation\n..."
})

# Add ADR (if needed)
chorus_pm_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "adr",
  title: "ADR: Choice of <technology>",
  content: "# ADR: ...\n\n## Context\n...\n## Decision\n..."
})
```

**Document types:** `prd`, `tech_design`, `adr`, `spec`, `guide`

### Step 7: Add Task Drafts

Add task drafts one at a time using `chorus_pm_add_task_draft`. Each draft gets a UUID on creation — use these UUIDs for `dependsOnDraftUuids` in later drafts.

```
# Add first task
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Implement <component>",
  description: "Detailed description of what to build...",
  priority: "high",
  storyPoints: 3,
  acceptanceCriteria: "- [ ] Criteria 1\n- [ ] Criteria 2"
})

# Add second task (depends on the first)
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Write tests for <component>",
  description: "Unit and integration tests...",
  priority: "medium",
  storyPoints: 2,
  acceptanceCriteria: "- [ ] Test coverage > 80%",
  dependsOnDraftUuids: ["<uuid-of-first-task-draft>"]
})
```

**Task priority:** `low`, `medium`, `high`

### Step 8: Review and Refine Drafts

After adding all drafts, review the full proposal and refine as needed:

```
# Review current state
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })

# Update a document draft
chorus_pm_update_document_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  content: "Updated content with more detail..."
})

# Update a task draft
chorus_pm_update_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  description: "Updated description with more detail...",
  dependsOnDraftUuids: ["<other-draft-uuid>"]
})

# Remove a draft that's no longer needed
chorus_pm_remove_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>"
})
```

### Step 9: Validate and Submit Proposal for Review

Before submitting, validate the proposal to preview any issues:

```
chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
```

This returns `{ valid, issues }` with error, warning, and info levels. Fix any errors before submitting. Warnings and info are advisory but worth addressing.

When the proposal passes validation (no errors):

```
chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
```

This changes the proposal status from `draft` to `pending`. An Admin will review it. Note: `submit` also runs validation internally and rejects if errors exist.

Add a comment explaining your reasoning:

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "This proposal covers... Key decisions: ..."
})
```

### Step 10: Update Idea Status

Mark the idea as proposal_created:

```
chorus_update_idea_status({ ideaUuid: "<idea-uuid>", status: "proposal_created" })
```

### Step 11: Handle Feedback

If the proposal is rejected, check the review note:

```
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
```

Revise the drafts and resubmit.

### Step 12: Post-Approval

When the Admin approves the proposal:
- Document drafts are automatically materialized into real Documents
- Task drafts are automatically materialized into real Tasks (status: `open`)
- Developers can now claim and work on the tasks

Mark the idea as completed:

```
chorus_update_idea_status({ ideaUuid: "<idea-uuid>", status: "completed" })
```

### Step 13: Manage Task Dependencies (Optional)

After tasks are created (either via proposal approval or `chorus_pm_create_tasks`), you can manage dependencies between them.

**Add dependency using `chorus_pm_create_tasks` with intra-batch dependencies:**

```
chorus_pm_create_tasks({
  projectUuid: "<project-uuid>",
  tasks: [
    {
      draftUuid: "draft-db",
      title: "Create database schema",
      priority: "high",
      storyPoints: 2
    },
    {
      draftUuid: "draft-api",
      title: "Implement API endpoints",
      priority: "high",
      storyPoints: 4,
      dependsOnDraftUuids: ["draft-db"]
    },
    {
      title: "Write integration tests",
      priority: "medium",
      storyPoints: 2,
      dependsOnDraftUuids: ["draft-api"],
      dependsOnTaskUuids: ["<existing-task-uuid>"]
    }
  ]
})
```

**Add/remove dependencies on existing tasks:**

```
# Add dependency: task B depends on task A
chorus_add_task_dependency({
  taskUuid: "<task-B-uuid>",
  dependsOnTaskUuid: "<task-A-uuid>"
})

# Remove dependency
chorus_remove_task_dependency({
  taskUuid: "<task-B-uuid>",
  dependsOnTaskUuid: "<task-A-uuid>"
})
```

**Notes:**
- Dependencies are validated: same project, no self-dependency, no cycles (DFS detection)
- Use `chorus_get_task` to see `dependsOn` and `dependedBy` arrays

### Step 14: Assign Tasks to Developer Agents (Optional)

After approval, you can directly assign tasks to specific Developer Agents instead of waiting for them to self-claim:

```
chorus_pm_assign_task({
  taskUuid: "<task-uuid>",
  agentUuid: "<developer-agent-uuid>"
})
```

**Conditions:**
- Task must be in `open` or `assigned` status (reassignment is allowed)
- Target agent must have `developer` or `developer_agent` role
- The PM Agent is recorded as `assignedBy`

To find available developer agents, use the project activity or check with the admin. To find open tasks:

```
chorus_get_available_tasks({ projectUuid: "<project-uuid>" })
```

---

## Document Writing Guidelines

### PRD Structure
```markdown
# PRD: <Feature Name>

## Background
Why this feature is needed.

## Requirements
### Functional Requirements
- FR-1: ...
- FR-2: ...

### Non-Functional Requirements
- NFR-1: ...

## User Stories
- As a <role>, I want <action>, so that <benefit>

## Out of Scope
What is NOT included in this proposal.
```

### Tech Design Structure
```markdown
# Technical Design: <Feature Name>

## Overview
High-level approach.

## Architecture
System design, component interactions.

## Data Model
Schema changes, new tables.

## API Design
New/modified endpoints.

## Implementation Plan
Step-by-step implementation order.

## Risks & Mitigations
Potential issues and how to address them.
```

### Task Writing Guidelines

Good tasks are:
- **Atomic** - One clear deliverable per task
- **Testable** - Clear acceptance criteria
- **Sized** - 1-8 story points (hours of agent work)
- **Ordered** - Use `dependsOnDraftUuids` / `dependsOnTaskUuids` to express execution order when tasks have real prerequisites
- **Descriptive** - Include enough context for a developer agent to start without questions

---

## Tips

- When combining multiple ideas, explain in the proposal description how they relate
- Keep PRD focused on *what* and *why*; keep tech design focused on *how*
- Break large features into multiple smaller tasks rather than one monolithic task
- Add `storyPoints` to help prioritize and estimate effort
- Use `acceptanceCriteria` with checkboxes for clear verification
