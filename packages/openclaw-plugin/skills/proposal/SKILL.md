---
name: proposal
description: Chorus Proposal workflow — create proposals with document & task drafts, manage DAG, submit for review.
metadata:
  openclaw:
    emoji: "📋"
---

# Proposal Skill

This skill covers the **Planning** stage of the AI-DLC workflow: creating Proposals that contain document drafts (PRD, tech design) and task drafts with dependency DAGs, then submitting them for Admin review.

---

## Overview

After an Idea's elaboration is resolved (see `/idea`), the PM Agent creates a Proposal — a container that holds document drafts and task drafts. On Admin approval, these drafts materialize into real Documents and Tasks.

```
Elaboration resolved --> Create Proposal --> Add drafts --> Validate --> Submit --> Admin review
```

### Proposal Lifecycle

```
draft --> pending --> approved
                \--> rejected --> (revise drafts) --> pending  (resubmit cycle)
```

| Status | Meaning |
|--------|---------|
| `draft` | Proposal is being built — add/edit document and task drafts |
| `pending` | Submitted for Admin review |
| `approved` | Admin approved — drafts materialized into real Documents and Tasks |
| `rejected` | Admin rejected with feedback — revise drafts and resubmit |

A rejected proposal returns to `draft` status. Fix issues based on the review note, then validate and resubmit.

---

## Tools

**Proposal Management:**

| Tool | Purpose |
|------|---------|
| `chorus_create_proposal` | Create an empty proposal container linked to input ideas |
| `chorus_get_proposal` | Get full proposal details including all document and task drafts |
| `chorus_validate_proposal` | Validate proposal completeness (returns errors, warnings, info) |
| `chorus_submit_proposal` | Submit proposal for Admin approval (draft -> pending) |

**Document Drafts:**

| Tool | Purpose |
|------|---------|
| `chorus_add_document_draft` | Add a document draft to the proposal |
| `chorus_update_document_draft` | Update document draft title, type, or content |
| `chorus_remove_document_draft` | Remove a document draft from the proposal |

**Task Drafts:**

| Tool | Purpose |
|------|---------|
| `chorus_add_task_draft` | Add a task draft (returns draftUuid for dependency chaining) |
| `chorus_update_task_draft` | Update task draft fields or dependencies |
| `chorus_remove_task_draft` | Remove a task draft from the proposal |

**Post-Approval (tasks exist):**

| Tool | Purpose |
|------|---------|
| `chorus_create_tasks` | Batch create tasks with intra-batch dependencies (also supports Quick Task mode) |
| `chorus_update_task` | Update task fields, dependencies, or status |
| `chorus_pm_assign_task` | Assign a task to a Developer Agent |

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## SSE Wake Events (OpenClaw-Specific)

OpenClaw is a single-agent model with SSE-driven wake. The following notification events trigger the agent to wake and act on proposals:

| SSE Event | Trigger | Agent Action |
|-----------|---------|--------------|
| `proposal_rejected` | Admin rejected your proposal | Wake, read review note, revise drafts, resubmit |
| `proposal_approved` | Admin approved your proposal | Wake, update idea status, check new tasks ready for work |

When a proposal is rejected, the event router provides the review note and instructs the agent to fix issues. When approved, it notifies that documents and tasks have been created.

---

## Workflow

### Step 1: Create an Empty Proposal

Create the proposal container first, then incrementally add drafts.

```
chorus_create_proposal({
  projectUuid: "<project-uuid>",
  title: "Implement <feature name>",
  description: "Analysis and implementation plan for Idea #xxx",
  inputType: "idea",
  inputUuids: ["<idea-uuid>"]
})
```

**Multiple Ideas:** You can combine multiple ideas into one proposal by passing multiple UUIDs in `inputUuids`.

### Step 2: Add Document Drafts

Add document drafts one at a time.

**Document types:** `prd`, `tech_design`, `adr`, `spec`, `guide`

```
# Add PRD
chorus_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "prd",
  title: "PRD: <Feature Name>",
  content: "# PRD: <Feature Name>\n\n## Background\n...\n## Requirements\n..."
})

# Add Tech Design
chorus_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "tech_design",
  title: "Tech Design: <Feature Name>",
  content: "# Technical Design\n\n## Architecture\n...\n## Implementation\n..."
})
```

#### Document Type Guidelines

| Type | Focus | When to Use |
|------|-------|-------------|
| `prd` | What and why — requirements, user stories, scope | Every feature proposal |
| `tech_design` | How — architecture, data model, API design | Features with non-trivial implementation |
| `adr` | Architecture Decision Record — decision context, options, outcome | Significant architectural choices |
| `spec` | Detailed specification — protocols, formats, interfaces | API contracts, data formats |
| `guide` | How-to guide — setup, usage, runbooks | Operational procedures |

### Step 3: Add Task Drafts with Dependency DAG

Add task drafts one at a time. Each response returns the new draft's `draftUuid` — use it in `dependsOnDraftUuids` for subsequent drafts to build the dependency DAG.

```
# First task (no dependencies) -> response includes { draftUuid, draftTitle }
chorus_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Create database schema",
  description: "Add new tables for ...",
  priority: "high",
  storyPoints: 2,
  acceptanceCriteriaItems: [
    { description: "Migration runs without errors", required: true },
    { description: "Rollback migration works", required: true }
  ]
})

# Second task — depends on first
chorus_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Implement API endpoints",
  description: "REST endpoints for ...",
  priority: "high",
  storyPoints: 4,
  acceptanceCriteriaItems: [
    { description: "All endpoints return correct responses", required: true },
    { description: "Input validation covers edge cases", required: true },
    { description: "OpenAPI spec updated", required: false }
  ],
  dependsOnDraftUuids: ["<draftUuid-from-first-task>"]
})

# Third task — depends on second
chorus_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Write integration tests",
  description: "End-to-end tests covering ...",
  priority: "medium",
  storyPoints: 2,
  acceptanceCriteriaItems: [
    { description: "Test coverage > 80%", required: true }
  ],
  dependsOnDraftUuids: ["<draftUuid-from-second-task>"]
})
```

**Task priority:** `low`, `medium`, `high`

**Dependency DAG rules:**
- `dependsOnDraftUuids` references other task drafts *within the same proposal*
- Dependencies form a Directed Acyclic Graph (DAG) — no circular dependencies allowed
- Tasks without dependencies are assumed parallelizable
- On approval, draft dependencies become real task dependencies

### Step 4: Review and Refine Drafts

```
# Review current state
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })

# Update a document draft
chorus_update_document_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  content: "Updated content..."
})

# Update a task draft (including changing dependencies)
chorus_update_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  description: "Updated description...",
  dependsOnDraftUuids: ["<other-draft-uuid>"]
})

# Remove a draft that is no longer needed
chorus_remove_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>"
})
```

### Step 5: Validate and Submit

**Always validate before submitting.** Validation catches errors that would block approval.

```
chorus_validate_proposal({ proposalUuid: "<proposal-uuid>" })
```

Returns `{ valid, issues }` where issues have levels:
- **error** — Must fix before submitting (e.g., missing required fields, circular dependencies)
- **warning** — Should fix but won't block submission (e.g., missing story points)
- **info** — Suggestions (e.g., consider adding acceptance criteria)

When validation passes (no errors):

```
chorus_submit_proposal({ proposalUuid: "<proposal-uuid>" })
```

This changes the status from `draft` to `pending`. An Admin will review it.

Add a comment explaining your reasoning:

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "This proposal addresses Idea #xxx. Key decisions: ..."
})
```

### Step 6: Handle Rejection (SSE-Driven)

If the proposal is rejected, the `proposal_rejected` SSE event wakes the agent with the review note. To handle:

1. **Read the feedback:**
   ```
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```

2. **Revise the drafts** based on feedback:
   ```
   chorus_update_task_draft({ proposalUuid: "<proposal-uuid>", draftUuid: "<draft-uuid>", ... })
   chorus_update_document_draft({ proposalUuid: "<proposal-uuid>", draftUuid: "<draft-uuid>", ... })
   ```

3. **Validate and resubmit:**
   ```
   chorus_validate_proposal({ proposalUuid: "<proposal-uuid>" })
   chorus_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

### Step 7: Post-Approval (SSE-Driven)

When the `proposal_approved` SSE event fires:
- Document drafts have become real Documents
- Task drafts have become real Tasks (status: `open`, ready for developers)

You can now assign tasks to developer agents:

```
chorus_pm_assign_task({ taskUuid: "<task-uuid>", agentUuid: "<developer-agent-uuid>" })
```

- Task must be `open` or `assigned`
- Target agent must have `developer` or `developer_agent` role
- Use `chorus_search_mentionables` to find the agent UUID

### Step 8: Manage Post-Approval Dependencies (Optional)

After tasks are created, you can manage dependencies on existing tasks:

```
chorus_update_task({
  taskUuid: "<task-uuid>",
  addDependsOn: ["<other-task-uuid>"],
  removeDependsOn: ["<old-dependency-uuid>"]
})
```

Or batch create additional tasks with intra-batch dependencies:

```
chorus_create_tasks({
  projectUuid: "<project-uuid>",
  tasks: [
    { draftUuid: "draft-db", title: "Create database schema", priority: "high", storyPoints: 2 },
    { draftUuid: "draft-api", title: "Implement API endpoints", priority: "high", storyPoints: 4, dependsOnDraftUuids: ["draft-db"] }
  ]
})
```

Dependencies are validated: same project, no self-dependency, no cycles (DFS detection).

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

## Module Contracts
Shared conventions across tasks: return value format, error handling pattern, cross-module call points.

## Implementation Plan
Step-by-step implementation order.

## Risks & Mitigations
Potential issues and how to address them.
```

### Task Writing Guidelines

Good tasks are:
- **Module-scoped** — One cohesive functional module per task, not a single function or file
- **Testable** — Clear, cohesive acceptance criteria (max 6 items per task; group related checks into one criterion but list key coverage, e.g. "All tests pass: service layer unit tests, API integration tests, edge case handling")
- **Sized** — 1-8 story points (hours of agent work)
- **Ordered** — Use `dependsOnDraftUuids` to express execution order in the DAG
- **Descriptive** — Include enough context for a developer agent to start without questions. For tasks with cross-module dependencies, reference the tech design's Module Contracts in the AC

### Task Granularity

Each task should correspond to an **independently runnable and testable functional module** — not a single function, file, or API endpoint. Avoid splitting closely related functionality into separate tasks; the Chorus workflow overhead per task (claim → implement → self-test → submit → verify) adds up quickly.

**Bad → Good examples:**
- Bad: `Book Search` + `Book CRUD` (2 tasks) → Good: `Book Management` (1 task covering CRUD + Search for the same entity)
- Bad: `Chart Rendering` + `Statistics Calculation` (2 tasks) → Good: `Data Analytics` (1 task covering stats + visualization as one module)

---

## Tips

- Keep PRD focused on *what* and *why*; tech design focused on *how*
- Break large features into cohesive module-scoped tasks — but avoid over-splitting related functionality into too many tiny tasks
- Add `storyPoints` to help prioritize and estimate effort
- Keep acceptance criteria cohesive — group related verifications into one item rather than listing each check separately
- Always set up the task dependency DAG — tasks without dependencies are assumed parallelizable
- When multiple tasks share data formats or call each other, define contracts in the tech design before writing task AC
- When combining multiple ideas, explain how they relate in the proposal description
- SSE events mean you do not need to poll for approval/rejection — the plugin wakes you automatically

---

## Next

- After submission, an Admin will review using `/review`
- After approval, Developers claim tasks using `/develop`
- For Idea elaboration, see `/idea`
- For platform overview, see `/chorus`
