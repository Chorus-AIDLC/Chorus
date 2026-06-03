---
name: proposal
description: Chorus Proposal workflow — create proposals with document and task drafts, manage dependency DAG, validate and submit for review.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.3"
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
| `chorus_create_tasks` | Batch create tasks (supports intra-batch dependencies via draftUuid) |
| `chorus_pm_assign_task` | Assign a task to a Developer Agent |
| `chorus_pm_create_document` | Create standalone document |
| `chorus_pm_update_document` | Update document content (increments version) |
| `chorus_update_task` (with `addDependsOn` / `removeDependsOn`) | Add or remove dependencies on existing tasks (with cycle detection) |

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

### Step 1.5: Detect OpenSpec mode

Before authoring document drafts, **load the `openspec-aware` skill at `~/.codex/skills/openspec-aware/SKILL.md`** and run its §1 detection contract. Branch on the result:

- **`CHORUS_OPENSPEC_ACTIVE=1`** → follow `openspec-aware` §3. Pick `$SLUG`, scaffold `openspec/changes/<slug>/`, author `proposal.md` / `design.md` / `specs/<capability>/spec.md` locally, then create the proposal container (Step 1 above) with the literal line `OpenSpec change slug: <slug>` in `description`, and mirror each local file into a document draft.

  > **⛔ Mandatory in OpenSpec mode:** mirror calls go through the `chorus-mcp-call.sh` wrapper with `content` produced by `json_encode_file` — see `openspec-aware` §3.6. Do **not** call `chorus_pm_add_document_draft` directly from Codex's MCP harness with a hand-typed `content` field. Re-typing thousands of lines through the model burns 20k+ content tokens per proposal and breaks byte-equality with the local source of truth (`openspec-aware` §2 Rule 1 explains the full reasoning). Skip Step 2 below when in OpenSpec mode — the wrapper-based flow in `openspec-aware` §3.6 replaces it for documents.

- **`CHORUS_OPENSPEC_ACTIVE=0`** (CLI absent or `CHORUS_OPENSPEC_MODE=off`) → proceed with Step 2 unchanged. Author drafts inline as free-form Markdown via direct MCP `chorus_pm_add_document_draft`.

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

**`acceptanceCriteriaItems` is required** — every task draft must include at least one item with a non-blank `description`, or the call is rejected. Use the structured `acceptanceCriteriaItems` array (the legacy `acceptanceCriteria` Markdown string does not satisfy the requirement).

```
# First task -> response includes { draftUuid, draftTitle }
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Implement <component>",
  description: "Detailed description of what to build...",
  priority: "high",
  storyPoints: 3,
  acceptanceCriteriaItems: [
    { description: "Criteria 1", required: true },
    { description: "Criteria 2", required: true }
  ]
})

# Second task — depends on first
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Write tests for <component>",
  description: "Unit and integration tests...",
  priority: "medium",
  storyPoints: 2,
  acceptanceCriteriaItems: [
    { description: "Test coverage > 80%", required: true }
  ],
  dependsOnDraftUuids: ["<draftUuid-from-first-task>"]
})
```

> To edit a draft's criteria later via `chorus_pm_update_task_draft`, pass a non-empty `acceptanceCriteriaItems` to replace them; omit the field to leave them unchanged. The field cannot be used to clear criteria.

**Task priority:** `low`, `medium`, `high`

### Step 4: Review and Refine Drafts

```
# Review current state. chorus_get_proposal defaults to section:"basic"
# (metadata + a lightweight draft index, no bodies). Use section:"full" to
# see every draft's content, or section:"documents"/"tasks" for one kind.
chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "full" })

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

### Step 6: Handle Feedback

After submission, a `chorus-proposal-reviewer` may run and post a VERDICT comment. If the VERDICT is **FAIL**, or an Admin rejects the proposal, you need to revise and resubmit.

**IMPORTANT:** A proposal in `pending` status cannot be edited. You **must** reject it first to return it to `draft` status before editing any drafts.

1. **Read feedback:**
   ```
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "full" })
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```
   Identify BLOCKERs from the reviewer VERDICT or rejection note.

2. **Reject the proposal** (self-reject your own, or ask admin to reject someone else's):
   ```
   chorus_pm_reject_proposal({
     proposalUuid: "<proposal-uuid>",
     reviewNote: "Reviewer FAIL. Fixing BLOCKERs: <list>"
   })
   ```
   This returns the proposal to `draft` status. PM agents can only reject their own proposals; admin agents can reject any proposal.

3. **Revise the drafts:**
   ```
   chorus_pm_update_document_draft({ proposalUuid: "<proposal-uuid>", draftUuid: "<uuid>", content: "..." })
   chorus_pm_update_task_draft({ proposalUuid: "<proposal-uuid>", draftUuid: "<uuid>", ... })
   ```

4. **Resubmit:**
   ```
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

### Step 7: Post-Approval

When the Admin approves:
- Document drafts become real Documents
- Task drafts become real Tasks (status: `open`, ready for developers)
- The Idea's displayed status is automatically derived from Proposal and Task progress -- no manual update needed

### Step 8: Manage Task Dependencies (Optional)

After tasks are created, you can manage dependencies:

**Batch create tasks with intra-batch dependencies:**

```
chorus_create_tasks({
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
chorus_update_task({ taskUuid: "<task-B-uuid>", addDependsOn: ["<task-A-uuid>"] })
chorus_update_task({ taskUuid: "<task-B-uuid>", removeDependsOn: ["<task-A-uuid>"] })
```

Dependencies are validated: same project, no self-dependency, no cycles (DFS detection).

### Step 9: Assign Tasks to Developer Agents (Optional)

```
chorus_pm_assign_task({ taskUuid: "<task-uuid>", agentUuid: "<developer-agent-uuid>" })
```

- Task must be `open` or `assigned`
- Target agent must have `task: ["write"]` permission

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
- **Testable** — Clear, cohesive acceptance criteria are **required** on every task (at least one non-blank item; max 6; group related checks into one criterion but list key coverage, e.g. "All tests pass: service layer unit tests, API integration tests, edge case handling")
- **Sized** — 1-8 story points (hours of agent work)
- **Ordered** — Use `dependsOnDraftUuids` / `dependsOnTaskUuids` to express execution order
- **Descriptive** — Include enough context for a developer agent to start without questions. For tasks with cross-module dependencies, reference the tech design's Module Contracts in the AC
- **Integration checkpoints** — For DAGs with 4+ tasks, include at least one integration checkpoint task at a convergence point whose AC requires end-to-end execution of preceding modules together
- **Hallucination-aware** — When tasks involve external dependencies, note in the task description that developers should verify specifics (API signatures, CLI flags, config keys, model IDs, etc.) against official docs rather than relying on LLM memory

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
- Always set up task dependency DAG — tasks without dependencies are assumed parallelizable
- When multiple tasks share data formats or call each other, define contracts in the tech design before writing task AC
- When combining multiple ideas, explain how they relate in the proposal description

---

## Next

- After submission, an Admin will review using `/review`
- After approval, Developers claim tasks using `/develop`
- For Idea elaboration, see `/idea`
- For platform overview, see `/chorus`
