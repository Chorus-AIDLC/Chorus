---
name: proposal
description: Chorus Proposal workflow — create proposals with document and task drafts, manage dependency DAG, validate and submit for review.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: project-management
  mcp_server: chorus
---

# Proposal Skill

This skill covers the **Planning** stage of the AI-DLC workflow: creating Proposals that contain document drafts (PRD, tech design) and task drafts with dependency DAGs, then submitting them for Admin review.

---

## Overview

After an Idea's elaboration is resolved (see `/idea`), the PM Agent creates a Proposal — a container that holds document drafts and task drafts. On Admin approval, these drafts materialize into real Documents and Tasks.

```
Elaboration resolved --> Create Proposal --> Add drafts --> Validate --> Submit --> Admin /review
```

---

## Tools

**Proposal Management:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_create_proposal` | Create empty proposal container |
| `chorus_pm_validate_proposal` | Validate proposal completeness (returns errors, warnings, info) |
| `chorus_pm_submit_proposal` | Submit proposal for Admin approval (draft -> pending) |

**Document Drafts:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_add_document_draft` | Add document draft to proposal |
| `chorus_pm_update_document_draft` | Update document draft content |
| `chorus_pm_remove_document_draft` | Remove document draft from proposal |

**Task Drafts:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_add_task_draft` | Add task draft (returns draftUuid for dependency chaining) |
| `chorus_pm_update_task_draft` | Update task draft |
| `chorus_pm_remove_task_draft` | Remove task draft from proposal |

**Post-Approval (tasks exist):**

| Tool | Purpose |
|------|---------|
| `chorus_pm_create_tasks` | Batch create tasks (supports intra-batch dependencies via draftUuid) |
| `chorus_pm_assign_task` | Assign a task to a Developer Agent |
| `chorus_pm_create_document` | Create standalone document |
| `chorus_pm_update_document` | Update document content (increments version) |
| `chorus_add_task_dependency` | Add dependency between existing tasks (with cycle detection) |
| `chorus_remove_task_dependency` | Remove a task dependency |

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 1: Create an Empty Proposal

**Recommended approach:** Create the proposal container first without any drafts, then incrementally add document and task drafts one by one.

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

### Step 2: Add Document Drafts

Add document drafts one at a time:

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
```

**Document types:** `prd`, `tech_design`, `adr`, `spec`, `guide`

### Step 3: Add Task Drafts

Add task drafts one at a time. The response returns the new draft's `draftUuid` — use it directly for `dependsOnDraftUuids` in subsequent drafts.

```
# First task -> response includes { draftUuid, draftTitle }
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Implement <component>",
  description: "Detailed description of what to build...",
  priority: "high",
  storyPoints: 3,
  acceptanceCriteria: "- [ ] Criteria 1\n- [ ] Criteria 2"
})

# Second task — depends on first
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Write tests for <component>",
  description: "Unit and integration tests...",
  priority: "medium",
  storyPoints: 2,
  acceptanceCriteria: "- [ ] Test coverage > 80%",
  dependsOnDraftUuids: ["<draftUuid-from-first-task>"]
})
```

**Task priority:** `low`, `medium`, `high`

### Step 4: Review and Refine Drafts

```
# Review current state
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })

# Update a document draft
chorus_pm_update_document_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  content: "Updated content..."
})

# Update a task draft
chorus_pm_update_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  description: "Updated description...",
  dependsOnDraftUuids: ["<other-draft-uuid>"]
})

# Remove a draft
chorus_pm_remove_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>"
})
```

### Step 5: Validate and Submit

Before submitting, validate to preview issues:

```
chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
```

Returns `{ valid, issues }` with error, warning, and info levels. Fix errors before submitting.

When validation passes:

```
chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
```

This changes the status from `draft` to `pending`. An Admin will review it (see `/review`).

Add a comment explaining your reasoning:

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "This proposal covers... Key decisions: ..."
})
```

### Step 6: Update Idea Status

```
chorus_update_idea_status({ ideaUuid: "<idea-uuid>", status: "proposal_created" })
```

### Step 7: Handle Feedback

If the proposal is rejected, check the review note:

```
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
```

Revise the drafts and resubmit.

### Step 8: Post-Approval

When the Admin approves:
- Document drafts become real Documents
- Task drafts become real Tasks (status: `open`, ready for developers)

Mark the idea as completed:

```
chorus_update_idea_status({ ideaUuid: "<idea-uuid>", status: "completed" })
```

### Step 9: Manage Task Dependencies (Optional)

After tasks are created, you can manage dependencies:

**Batch create tasks with intra-batch dependencies:**

```
chorus_pm_create_tasks({
  projectUuid: "<project-uuid>",
  tasks: [
    { draftUuid: "draft-db", title: "Create database schema", priority: "high", storyPoints: 2 },
    { draftUuid: "draft-api", title: "Implement API endpoints", priority: "high", storyPoints: 4, dependsOnDraftUuids: ["draft-db"] },
    { title: "Write integration tests", priority: "medium", storyPoints: 2, dependsOnDraftUuids: ["draft-api"] }
  ]
})
```

**Add/remove dependencies on existing tasks:**

```
chorus_add_task_dependency({ taskUuid: "<task-B-uuid>", dependsOnTaskUuid: "<task-A-uuid>" })
chorus_remove_task_dependency({ taskUuid: "<task-B-uuid>", dependsOnTaskUuid: "<task-A-uuid>" })
```

Dependencies are validated: same project, no self-dependency, no cycles (DFS detection).

### Step 10: Assign Tasks to Developer Agents (Optional)

```
chorus_pm_assign_task({ taskUuid: "<task-uuid>", agentUuid: "<developer-agent-uuid>" })
```

- Task must be `open` or `assigned`
- Target agent must have `developer` or `developer_agent` role

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

### Non-Functional Requirements
- NFR-1: ...

## User Stories
- As a <role>, I want <action>, so that <benefit>

## Out of Scope
What is NOT included.
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
- **Atomic** — One clear deliverable per task
- **Testable** — Clear acceptance criteria
- **Sized** — 1-8 story points (hours of agent work)
- **Ordered** — Use `dependsOnDraftUuids` / `dependsOnTaskUuids` to express execution order
- **Descriptive** — Include enough context for a developer agent to start without questions

---

## Tips

- Keep PRD focused on *what* and *why*; tech design focused on *how*
- Break large features into multiple smaller tasks rather than one monolithic task
- Add `storyPoints` to help prioritize and estimate effort
- Use `acceptanceCriteria` with checkboxes for clear verification
- Always set up task dependency DAG — tasks without dependencies are assumed parallelizable
- When combining multiple ideas, explain how they relate in the proposal description

---

## Next

- After submission, an Admin will review using `/review`
- After approval, Developers claim tasks using `/develop`
- For Idea elaboration, see `/idea`
- For platform overview, see `/chorus`
