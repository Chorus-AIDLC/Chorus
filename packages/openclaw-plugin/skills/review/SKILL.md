---
name: review
description: Chorus Review workflow — approve/reject proposals, verify tasks, and manage project governance.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.2"
  category: project-management
  mcp_server: chorus
---

# Review Skill

This skill covers the **Review** stage of the AI-DLC workflow: approving or rejecting Proposals, verifying completed Tasks, and managing overall project governance as an Admin Agent.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_admin_verify_task`). Bare names are used below for readability — prepend `chorus__` when invoking. See `/chorus` for the full rule.

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

**PM + Admin (proposal reject/revoke):**

| Tool | Purpose |
|------|---------|
| `chorus_pm_reject_proposal` | Reject a pending proposal (pending -> draft). PM: own proposals only. Admin: any proposal. |
| `chorus_pm_revoke_proposal` | Revoke an approved proposal (approved -> draft). Cascade-closes tasks, deletes documents. PM: own only. Admin: any. |

**All PM tools** (`chorus_pm_*`, `chorus_*_idea`) and **all Developer tools** (`chorus_*_task`, `chorus_report_work`) are also available to Admin.

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Review Strategy

When reviewing proposals or tasks, get an independent VERDICT before approving/verifying. On OpenClaw there is **no PostToolUse hook** to remind you — invoke the review yourself, inline.

1. **Preferred — spawn a reviewer sub-agent.** Use the OpenClaw `sessions_spawn` tool to spawn a sub-agent whose `task` tells it to **invoke the `/proposal-reviewer` skill** (for proposals) or the `/task-reviewer` skill (for tasks) — both bundled with this plugin — against the entity. Wait for it (poll the `subagents` tool or use `sessions_yield` — do NOT detach; you must have the VERDICT before proceeding). The sub-agent inherits the plugin skills, so the reviewer skill is available to it; it posts a VERDICT comment with detailed findings. Example task prompt: `Run the /proposal-reviewer skill to review proposalUuid <uuid>; post your VERDICT comment when done.`
2. **Read the VERDICT.** After the reviewer completes, call `chorus_get_comments` and find the most recent comment containing `VERDICT:`. There are exactly three possible outcomes:
   - **VERDICT: PASS** — No issues found. Approve (proposals) or mark AC passed and verify (tasks).
   - **VERDICT: PASS WITH NOTES** — Minor non-blocking notes. Still approve/verify. Notes are informational.
   - **VERDICT: FAIL** — BLOCKERs found. Reject (proposals) or reopen (tasks). Fix the specific BLOCKERs listed in the comment before resubmitting.
3. **No new VERDICT comment?** The sub-agent exhausted its turn budget before posting. Respawn it ONCE with an explicit prompt like: *"Stay within your turn budget. Skip deep source verification — batch all MCP fetches up front, skim for obvious BLOCKERs only, and reserve your last few turns to post the VERDICT comment."* If the second attempt also fails to post, review manually (step 5).
4. **Track rounds.** Count existing VERDICT comments before spawning. After 3 rounds of FAIL on the same item, stop the loop and escalate to human review.
5. **Fallback — review it yourself (no `sessions_spawn` on the host).** If spawning is unavailable (disabled by policy, or the spawn fails), perform the review yourself as a **focused, read-only pass** using the quality checklists in the workflows below: read the entity, its comments, and the relevant documents/code, run read-only test/build commands where applicable, and do NOT modify anything. Then record your VERDICT via `chorus_add_comment` ending with a `VERDICT:` line (PASS / PASS WITH NOTES / FAIL), classifying every finding as BLOCKER or NOTE. The `/proposal-reviewer` and `/task-reviewer` skills are the authoritative checklists for this manual pass — read them and follow their procedure.

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
chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "full" })
```

`chorus_get_proposal` defaults to `section: "basic"` — proposal metadata plus a lightweight index of the drafts (uuid, type/title, contentLength, AC count, dependency edges) with **no** document content or full task descriptions. For a review you need the bodies, so pass `section: "full"` to get everything at once (or `section: "documents"` / `section: "tasks"` to read one kind at a time).

The `full` view returns: title, description, input ideas, **document drafts** (PRD, tech design), **task drafts** (with descriptions and acceptance criteria).

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

#### A3.5: Independent Review

Get a VERDICT per the [Review Strategy](#review-strategy) above — spawn a sub-agent via `sessions_spawn` and have it run the `/proposal-reviewer` skill (wait for it), otherwise review yourself as a read-only pass and post the VERDICT. Read its VERDICT comment before proceeding.

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
chorus_pm_reject_proposal({
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

If an approved Proposal's direction turns out to be wrong, use `chorus_pm_revoke_proposal` to undo the approval. Unlike `reject` (which acts on pending proposals), `revoke` acts on already-approved proposals and rolls back all materialized resources.

```
chorus_pm_revoke_proposal({
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

#### B2.5: Independent Review

Get a VERDICT per the [Review Strategy](#review-strategy) above — spawn a sub-agent via `sessions_spawn` and have it run the `/task-reviewer` skill (wait for it), otherwise review yourself as a read-only pass and post the VERDICT. After it completes, read its VERDICT:

- **VERDICT: PASS** or **PASS WITH NOTES** → proceed to B3 (mark AC) and B4 (verify).
- **VERDICT: FAIL** → skip to B4 and **reopen** the task. Do NOT mark AC as passed.

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
- **Verify between waves** — In sequential wave execution, verify tasks to `done` between waves to unblock downstream dependencies

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
