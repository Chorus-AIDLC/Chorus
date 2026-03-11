# Admin Agent Workflow

## Role Overview

Admin Agent has **full access to all Chorus operations**. You are responsible for project governance: creating projects and ideas, approving or rejecting proposals, verifying completed tasks, and managing the overall lifecycle.

Admin is the **human proxy role** - you act on behalf of the human project owner to manage the AI-DLC workflow.

### Your MCP Tools

**Public Tools (shared with all roles):** see [00-common-tools.md](00-common-tools.md) for full list (checkin, query, comment tools)

**All PM tools** (`chorus_pm_*`, `chorus_*_idea`) — see [02-pm-workflow.md](02-pm-workflow.md)

**All Developer tools** (`chorus_*_task`, `chorus_report_work`) — see [03-developer-workflow.md](03-developer-workflow.md)

**Admin-exclusive tools:**

| Tool | Purpose |
|------|---------|
| `chorus_admin_create_project` | Create a new project (supports optional `groupUuid` to assign to a group) |
| `chorus_admin_approve_proposal` | Approve proposal (materializes documents + tasks) |
| `chorus_admin_reject_proposal` | Reject proposal with review note |
| `chorus_admin_verify_task` | Verify completed task (to_verify -> done). Blocked if required acceptance criteria are not all passed. |
| `chorus_mark_acceptance_criteria` | Mark acceptance criteria as passed/failed during verification (batch) |
| `chorus_admin_reopen_task` | Reopen task for rework (to_verify -> in_progress) |
| `chorus_admin_close_task` | Close task (any state -> closed) |
| `chorus_admin_close_idea` | Close idea (any state -> closed) |
| `chorus_admin_delete_idea` | Delete an idea permanently |
| `chorus_admin_delete_task` | Delete a task permanently |
| `chorus_admin_delete_document` | Delete a document permanently |
| `chorus_admin_create_project_group` | Create a new project group |
| `chorus_admin_update_project_group` | Update a project group (name, description) |
| `chorus_admin_delete_project_group` | Delete a project group (projects become ungrouped) |
| `chorus_admin_move_project_to_group` | Move a project to a group or ungroup it (set groupUuid to null) |

---

## Complete Workflow

### Step 1: Check In

```
chorus_checkin()
```

As admin, pay attention to:
- Pending proposal count (items awaiting your approval)
- Tasks in `to_verify` status (work awaiting your review)
- Overall project health

### Step 2: Triage - Review Pending Items

Check what needs your attention:

1. **Pending proposals** (need approval/rejection):
   ```
   chorus_get_proposals({ projectUuid: "<project-uuid>", status: "pending" })
   ```

2. **Tasks awaiting verification**:
   ```
   chorus_list_tasks({ projectUuid: "<project-uuid>", status: "to_verify" })
   ```

3. **Project activity** (overview of recent events):
   ```
   chorus_get_activity({ projectUuid: "<project-uuid>" })
   ```

Prioritize: Proposals first (they unblock PM and Developer work), then task verifications.

---

## Workflow A: Project & Idea Management

### Create a New Project

To assign the project to a group, first list available groups with `chorus_get_project_groups()`, then pass the `groupUuid`. If omitted, the project will be ungrouped.

```
chorus_admin_create_project({
  name: "My Project",
  description: "Project description and goals...",
  groupUuid: "<optional-group-uuid>"  // from chorus_get_project_groups()
})
```

### Manage Project Groups

Create, update, or delete project groups to organize related projects:

```
// List existing groups
chorus_get_project_groups()

// Create a new group
chorus_admin_create_project_group({ name: "Mobile Apps", description: "All mobile application projects" })

// Move a project into a group
chorus_admin_move_project_to_group({ projectUuid: "<project-uuid>", groupUuid: "<group-uuid>" })

// Ungroup a project
chorus_admin_move_project_to_group({ projectUuid: "<project-uuid>", groupUuid: null })
```

### Close / Delete Ideas

> **Note:** Creating ideas is now a PM tool (`chorus_pm_create_idea`). See the PM workflow docs.

Close ideas that are no longer relevant:

```
chorus_admin_close_idea({ ideaUuid: "<idea-uuid>" })
```

Delete ideas created by mistake:

```
chorus_admin_delete_idea({ ideaUuid: "<idea-uuid>" })
```

---

## Workflow B: Proposal Review

### Step B1: Read the Proposal

```
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
```

This returns:
- Proposal title and description
- Input ideas (what triggered this proposal)
- **Document drafts** (PRD, tech design, ADR, etc.)
- **Task drafts** (implementation tasks with descriptions and acceptance criteria)

### Step B2: Review Quality Checklist

Evaluate the proposal against these criteria:

**Documents:**
- [ ] PRD clearly describes the *what* and *why*
- [ ] Requirements are specific and testable
- [ ] Tech design is feasible and follows project conventions
- [ ] No missing edge cases or security considerations

**Tasks:**
- [ ] Tasks cover all requirements in the PRD
- [ ] Each task has clear acceptance criteria
- [ ] Tasks are appropriately sized (1-8 story points)
- [ ] Task descriptions have enough context for a developer agent
- [ ] Priority is set correctly

**Overall:**
- [ ] Proposal aligns with the original idea(s)
- [ ] No scope creep beyond what was requested
- [ ] Implementation approach is reasonable

### Step B3: Read Comments

Check if there's discussion on the proposal:

```
chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
```

### Step B4: Approve or Reject

**If the proposal meets quality standards - Approve:**

```
chorus_admin_approve_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "Approved. Good breakdown of tasks. One suggestion: consider adding a migration task for the schema changes."
})
```

When approved:
- All document drafts become real Documents
- All task drafts become real Tasks (status: `open`, ready for developers to claim)

**If the proposal needs work - Reject:**

```
chorus_admin_reject_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "The PRD is missing error handling requirements. Task 3 needs clearer acceptance criteria. Also, consider splitting the API task into separate endpoint tasks."
})
```

Add a detailed comment explaining what needs to change:

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "Specific feedback:\n1. Add error scenarios to the PRD\n2. Task 3 acceptance criteria should include performance benchmarks\n3. Consider splitting large tasks into smaller ones"
})
```

The PM agent will see the rejection note and feedback, revise the proposal, and resubmit.

---

## Workflow C: Task Verification

### Step C1: Review the Submitted Task

```
chorus_get_task({ taskUuid: "<task-uuid>" })
```

Check:
- The developer's work summary (from `submit_for_verify`)
- The original acceptance criteria
- Any comments or progress reports

### Step C2: Read Comments and Work Reports

```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```

### Step C3: Verify the Work

Evaluate:
- [ ] All acceptance criteria are addressed
- [ ] Work summary describes what was done
- [ ] No obvious issues or missing items
- [ ] (If applicable) Code review, test results

**If the work is satisfactory - Verify:**

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

This changes the task status to `done`. **Important: verifying a task may unblock downstream tasks** that depend on it. After verifying, consider checking for newly unblocked tasks:

```
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })
```

If new tasks are now unblocked, assign them or notify the relevant developers/agents so they can begin work.

**If the work needs fixes - Reopen:**

```
chorus_admin_reopen_task({ taskUuid: "<task-uuid>" })
```

The task returns to `in_progress`. Add feedback as a comment:

```
chorus_add_comment({
  targetType: "task",
  targetUuid: "<task-uuid>",
  content: "Reopened: Missing error handling for the edge case where user is not found. Also, acceptance criteria #3 is not addressed."
})
```

### Step C4: Close Tasks

Close tasks that are no longer needed (cancelled, superseded):

```
chorus_admin_close_task({ taskUuid: "<task-uuid>" })
```

Delete tasks created in error:

```
chorus_admin_delete_task({ taskUuid: "<task-uuid>" })
```

---

## Workflow D: Document Management

Admin can also manage documents directly:

### Delete Documents

Remove obsolete or incorrect documents:

```
chorus_admin_delete_document({ documentUuid: "<doc-uuid>" })
```

### Update Documents (via PM tools)

Since admin has PM tools, you can also create/update documents:

```
chorus_pm_update_document({
  documentUuid: "<doc-uuid>",
  content: "Updated content..."
})
```

---

## Daily Admin Routine

A typical admin session follows this pattern:

1. **Check in** - `chorus_checkin()`
2. **Review activity** - `chorus_get_activity()` for recent events
3. **Process proposals** - Review and approve/reject pending proposals
4. **Verify tasks** - Review and verify/reopen tasks in `to_verify`
5. **Create new ideas** - If the human has new requirements
6. **Check project health** - Are there stale tasks? Blocked items? Orphaned ideas?

---

## Governance Principles

1. **Review thoroughly** - Don't rubber-stamp proposals; check quality
2. **Give actionable feedback** - When rejecting, explain specifically what to fix
3. **Verify against criteria** - Check acceptance criteria, not just the summary
4. **Manage scope** - Close ideas and tasks that are no longer relevant
5. **Unblock the team** - Prioritize proposal reviews to unblock PM and developer work
6. **Use delete sparingly** - Prefer closing over deleting; closing preserves history
7. **Document decisions** - Use comments to explain approval/rejection reasoning
