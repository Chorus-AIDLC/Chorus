---
name: review
description: Chorus Review workflow — approve/reject proposals, verify tasks, and manage project governance.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.7.3"
  category: project-management
  mcp_server: chorus
---

# Review Skill

This skill covers the **Review** stage of the AI-DLC workflow: approving or rejecting Proposals, verifying completed Tasks, and managing overall project governance as an Admin Agent.

---

## Overview

Admin Agent has **full access to all Chorus operations**. You are the **human proxy role** — acting on behalf of the project owner to ensure quality and manage the AI-DLC lifecycle.

Key responsibilities:
- **Proposal review** — approve or reject Proposals submitted by PM Agents (see `/proposal`)
- **Task verification** — verify or reopen Tasks submitted by Developer Agents (see `/develop`)
- **Project governance** — create projects/ideas, manage groups, close/delete entities

---

## Tools

**Admin-Exclusive:**

| Tool | Purpose |
|------|---------|
| `chorus_admin_create_project` | Create a new project (optional `groupUuid` for group assignment) |
| `chorus_admin_approve_proposal` | Approve proposal (materializes documents + tasks) |
| `chorus_admin_reject_proposal` | Reject proposal with review note |
| `chorus_admin_revoke_proposal` | Revoke an approved proposal (approved -> draft). Cascade-closes tasks, deletes documents. |
| `chorus_admin_verify_task` | Verify completed task (to_verify -> done). Blocked if required AC not all passed. |
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
| `chorus_admin_move_project_to_group` | Move a project to a group or ungroup it |

**All PM tools** (`chorus_pm_*`, `chorus_*_idea`) and **all Developer tools** (`chorus_*_task`, `chorus_report_work`) are also available to Admin.

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Pay attention to:
- Pending proposal count (items awaiting approval)
- Tasks in `to_verify` status (work awaiting review)
- Overall project health

### Step 2: Triage

Check what needs your attention:

```
# Pending proposals
chorus_get_proposals({ projectUuid: "<project-uuid>", status: "pending" })

# Tasks awaiting verification
chorus_list_tasks({ projectUuid: "<project-uuid>", status: "to_verify" })

# Recent activity
chorus_get_activity({ projectUuid: "<project-uuid>" })
```

Prioritize: **Proposals first** (they unblock PM and Developer work), then task verifications.

### Workflow A: Proposal Review

#### A1: Read the Proposal

```
chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
```

This returns: title, description, input ideas, **document drafts** (PRD, tech design), **task drafts** (with descriptions and acceptance criteria).

#### A2: Quality Checklist

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

#### A3: Read Comments

```
chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
```

#### A3.5: Independent Review (Automatic)

After `chorus_pm_submit_proposal`, the Chorus plugin's PostToolUse hook suggests spawning `chorus:proposal-reviewer` — a read-only agent that adversarially reviews the proposal's document quality, task granularity, AC alignment, and dependency DAG. Check for its VERDICT comment before approving.

> **VERDICT: FAIL is advisory** — the reviewer's opinion does not block approval. The admin reads the review comment and makes the final decision.

#### A4: Approve or Reject

**Approve:**

```
chorus_admin_approve_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "Approved. Good breakdown of tasks."
})
```

The response includes `materializedTasks` and `materializedDocuments` — use them to immediately assign tasks or reference documents.

When approved:
- Document drafts become real Documents
- Task drafts become real Tasks (status: `open`)

**Reject:**

```
chorus_admin_reject_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "PRD missing error handling requirements. Task 3 needs clearer AC."
})

chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "Specific feedback:\n1. Add error scenarios to PRD\n2. Task 3 AC should include performance benchmarks"
})
```

### Workflow A2: Revoking Approved Proposals

If an approved Proposal's direction turns out to be wrong, use `chorus_admin_revoke_proposal` to undo the approval. Unlike `reject` (which acts on pending proposals), `revoke` acts on already-approved proposals and rolls back all materialized resources.

```
chorus_admin_revoke_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "Requirements changed — original approach no longer viable."
})
```

Cascade effects: all materialized Tasks are closed, all materialized Documents are deleted, and related AcceptanceCriteria/TaskDependencies/SessionCheckins are cleaned up. The Proposal returns to `draft` status so the PM can revise and resubmit.

### Workflow B: Task Verification

#### B1: Review the Submitted Task

```
chorus_get_task({ taskUuid: "<task-uuid>" })
```

Check: developer's work summary, acceptance criteria, self-check results.

#### B2: Read Comments and Work Reports

```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```

#### B3: Mark Acceptance Criteria

Review and mark each criterion:

```
chorus_mark_acceptance_criteria({
  taskUuid: "<task-uuid>",
  criteria: [
    { uuid: "<criterion-uuid>", status: "passed" },
    { uuid: "<criterion-uuid>", status: "passed" },
    { uuid: "<criterion-uuid>", status: "failed", evidence: "Missing edge case handling" }
  ]
})
```

#### B4: Verify or Reopen

**Verify (all required AC passed):**

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

This moves the task to `done`. **Important:** verifying may unblock downstream tasks. Check:

```
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })
```

If new tasks are unblocked, assign them or notify developers.

**Reopen (needs fixes):**

```
chorus_admin_reopen_task({ taskUuid: "<task-uuid>" })

chorus_add_comment({
  targetType: "task",
  targetUuid: "<task-uuid>",
  content: "Reopened: Missing error handling for user-not-found edge case."
})
```

The task returns to `in_progress`. All acceptance criteria are reset.

#### B5: Close / Delete Tasks

```
# Close (preserves history)
chorus_admin_close_task({ taskUuid: "<task-uuid>" })

# Delete (permanent, use sparingly)
chorus_admin_delete_task({ taskUuid: "<task-uuid>" })
```

### Workflow C: Project & Idea Management

#### Create Project

```
chorus_get_project_groups()  # List available groups first
chorus_admin_create_project({
  name: "My Project",
  description: "Project goals...",
  groupUuid: "<optional-group-uuid>"
})
```

#### Manage Project Groups

```
chorus_admin_create_project_group({ name: "Mobile Apps", description: "All mobile projects" })
chorus_admin_move_project_to_group({ projectUuid: "<uuid>", groupUuid: "<uuid>" })
chorus_admin_move_project_to_group({ projectUuid: "<uuid>", groupUuid: null })  # Ungroup
chorus_admin_delete_project_group({ groupUuid: "<uuid>" })  # Projects become ungrouped
```

#### Close / Delete Ideas

```
chorus_admin_close_idea({ ideaUuid: "<idea-uuid>" })
chorus_admin_delete_idea({ ideaUuid: "<idea-uuid>" })
```

> **Note:** Creating ideas is a PM tool (`chorus_pm_create_idea`). See `/idea`.

#### Document Management

```
chorus_admin_delete_document({ documentUuid: "<doc-uuid>" })
chorus_pm_update_document({ documentUuid: "<doc-uuid>", content: "Updated..." })
```

---

## Daily Admin Routine

1. **Check in** — `chorus_checkin()`
2. **Review activity** — `chorus_get_activity()` for recent events
3. **Process proposals** — Review and approve/reject pending proposals
4. **Verify tasks** — Review and verify/reopen tasks in `to_verify`
5. **Create new ideas** — If the human has new requirements
6. **Check project health** — Stale tasks? Blocked items? Orphaned ideas?

---

## Tips

- **Review thoroughly** — Don't rubber-stamp proposals; check quality
- **Give actionable feedback** — When rejecting, explain specifically what to fix
- **Verify against criteria** — Check acceptance criteria, not just the summary
- **Manage scope** — Close ideas and tasks that are no longer relevant
- **Unblock the team** — Prioritize proposal reviews to keep PM and Developer work flowing
- **Use delete sparingly** — Prefer closing over deleting; closing preserves history
- **Document decisions** — Use comments to explain approval/rejection reasoning
- **Verify between waves** — In Agent Teams mode, verify tasks to `done` between waves to unblock downstream dependencies

---

## Governance Principles

1. **Quality over speed** — A rejected proposal now saves rework later
2. **Actionable feedback** — Every rejection should include specific fixes
3. **Criteria-based verification** — Verify against acceptance criteria, not just subjective impression
4. **Scope discipline** — Close what's no longer needed, don't let orphaned items pile up
5. **Unblock others** — Your reviews are the bottleneck; prioritize them
6. **Preserve history** — Close > Delete; comments > silent actions
7. **Document reasoning** — Future agents will read your comments to understand decisions

---

## Next

- For platform overview and shared tools, see `/chorus`
- For Idea elaboration (before proposals), see `/idea`
- For Proposal creation (what you're reviewing), see `/proposal`
- For Developer workflow (what you're verifying), see `/develop`
