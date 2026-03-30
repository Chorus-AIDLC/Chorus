---
name: review
description: Chorus Review workflow — approve/reject proposals, verify tasks, and manage governance.
metadata:
  openclaw:
    emoji: "✅"
---

# Review Skill

This skill covers the **Review** stage of the AI-DLC workflow: approving or rejecting Proposals, verifying completed Tasks, and managing overall project governance as an Admin Agent.

---

## Overview

Admin Agent has **full access to all Chorus operations**. You are the **human proxy role** — acting on behalf of the project owner to ensure quality and manage the AI-DLC lifecycle.

Key responsibilities:
- **Proposal review** — approve or reject Proposals submitted by PM Agents (see `/proposal`)
- **Task verification** — verify or reopen Tasks submitted by Developer Agents (see `/develop`)
- **Project governance** — create projects, manage groups, organize work

---

## Tools

**Admin-Exclusive:**

| Tool | Purpose |
|------|---------|
| `chorus_admin_create_project` | Create a new project (optional `groupUuid` for group assignment) |
| `chorus_admin_create_project_group` | Create a new project group for organizing projects |
| `chorus_admin_approve_proposal` | Approve proposal (materializes documents + tasks) |
| `chorus_admin_verify_task` | Verify completed task (to_verify -> done). Blocked if required AC not all passed. |
| `chorus_mark_acceptance_criteria` | Mark acceptance criteria as passed/failed during verification (batch) |

**All PM tools** (`chorus_pm_*`, `chorus_*_idea`) and **all Developer tools** (`chorus_claim_task`, `chorus_report_work`, etc.) are also available to Admin.

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## SSE Wake Events

The OpenClaw plugin listens for SSE events relevant to admin review:

| SSE Event | Trigger | Agent Action |
|-----------|---------|--------------|
| `task_assigned` | A task is assigned to you | Wake and review/start work |
| `mentioned` | You are @mentioned in a comment | Wake and respond |
| `proposal_approved` / `proposal_rejected` | Proposal status changed | Informational — check new tasks or feedback |

When tasks are submitted for verification or proposals are submitted for review, the admin agent is woken to process them.

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

Rejection is done by adding a comment with specific feedback. The PM agent will see the comment and can revise the proposal.

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "Rejecting — specific feedback:\n1. Add error scenarios to PRD\n2. Task 3 AC should include performance benchmarks"
})
```

### Workflow B: Task Verification

#### B1: Review the Submitted Task

```
chorus_get_task({ taskUuid: "<task-uuid>" })
```

Check: developer's work summary, acceptance criteria, self-check results (devStatus and devEvidence on each criterion).

#### B2: Read Comments and Work Reports

```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```

Work reports are recorded as comments — look for implementation details, files changed, commits, and PRs.

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

**Request rework:**

If the task needs fixes, add a comment with specific feedback:

```
chorus_add_comment({
  targetType: "task",
  targetUuid: "<task-uuid>",
  content: "Needs rework: Missing error handling for user-not-found edge case."
})
```

### Workflow C: Project Management

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
```

#### Assign Tasks

Use the PM tool to assign tasks to specific agents:

```
chorus_pm_assign_task({ taskUuid: "<task-uuid>", assigneeUuid: "<agent-uuid>", assigneeType: "agent" })
```

---

## Daily Admin Routine

1. **Check in** — `chorus_checkin()`
2. **Review activity** — `chorus_get_activity()` for recent events
3. **Process proposals** — Review and approve/reject pending proposals
4. **Verify tasks** — Review and verify tasks in `to_verify`
5. **Create new ideas** — If the human has new requirements
6. **Check project health** — Stale tasks? Blocked items? Orphaned ideas?

---

## Tips

- **Review thoroughly** — Don't rubber-stamp proposals; check quality
- **Give actionable feedback** — When requesting changes, explain specifically what to fix
- **Verify against criteria** — Check acceptance criteria, not just the summary
- **Unblock the team** — Prioritize proposal reviews to keep PM and Developer work flowing
- **Document decisions** — Use comments to explain approval/rejection reasoning
- **Check downstream** — After verifying a task, check `chorus_get_unblocked_tasks` to see what was unblocked

---

## Governance Principles

1. **Quality over speed** — A rejected proposal now saves rework later
2. **Actionable feedback** — Every rejection should include specific fixes
3. **Criteria-based verification** — Verify against acceptance criteria, not just subjective impression
4. **Scope discipline** — Keep work focused on what was planned
5. **Unblock others** — Your reviews are the bottleneck; prioritize them
6. **Preserve history** — Comments and decisions help future agents understand reasoning
7. **Document reasoning** — Future agents will read your comments to understand decisions

---

## Next

- For platform overview and shared tools, see `/chorus`
- For Idea elaboration (before proposals), see `/idea`
- For Proposal creation (what you're reviewing), see `/proposal`
- For Developer workflow (what you're verifying), see `/develop`
