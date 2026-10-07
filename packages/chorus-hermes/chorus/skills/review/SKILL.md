---
name: review
description: Chorus Review workflow — approve/reject proposals, verify tasks, run read-only reviewers via Hermes delegate_task, and manage project governance.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.21.1"
  category: project-management
  mcp_server: chorus
---

# Review Skill

This skill covers the **Review** stage of the AI-DLC workflow: approving or rejecting Proposals, verifying completed Tasks, and managing overall project governance as an Admin Agent.

---

## Overview

Admin Agent has **full access to all Chorus operations**. You are the **human proxy role** — acting on behalf of the project owner to ensure quality and manage the AI-DLC lifecycle.

Key responsibilities:
- **Proposal review** — approve or reject Proposals submitted by PM Agents (see `skill_view("chorus:proposal")`)
- **Task verification** — verify or reopen Tasks submitted by Developer Agents (see `skill_view("chorus:develop")`)
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

**Shared tools** (checkin, query, comment, search, notifications): see `skill_view("chorus:chorus")`

---

## Review Strategy

When reviewing proposals, tasks, or an Idea's final aggregate code change, prefer running an independent reviewer over reviewing manually:

1. **Try the reviewer first.** Run `chorus-proposal-reviewer` (for proposals), `chorus-task-reviewer` (for tasks), or `chorus-code-reviewer` (the final ship-time gateway over an Idea's aggregate code change, after its last task is verified — pass the `ideaUuid`; it posts its VERDICT on the **idea**) as a read-only `delegate_task` child (examples below). `delegate_task` **blocks** until the reviewer finishes, so you always wait before proceeding. The verdict is the VERDICT comment it posts on the entity, not the call's return value, so read the comment (step 2). It posts a VERDICT comment with detailed findings.
2. **Read the VERDICT.** After the reviewer completes, call `chorus_get_comments` and find THIS round's `VERDICT:` comment — the one posted after your dispatch, not an older round's. There are exactly three possible outcomes:
   - **VERDICT: PASS** — No issues found. Approve (proposals) or mark AC passed and verify (tasks).
   - **VERDICT: PASS WITH NOTES** — Minor non-blocking notes. Still approve/verify. Notes are informational.
   - **VERDICT: FAIL** — BLOCKERs found. Reject (proposals) or reopen (tasks). For a **code-review gateway** FAIL, do not reopen the verified tasks — instead fix via the quick-dev skill (`skill_view("chorus:quick-dev")`): `chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it (see B2.6). Fix the specific BLOCKERs listed in the comment before resubmitting.
3. **No new VERDICT comment?** Check what the reviewer *did* post. A comment reporting that the round limit was reached, or any other explicit refusal to review, is a deliberate escalation to a human: STOP — do not respawn, do not self-review, do not post a VERDICT of your own. If it posted nothing at all, respawn it ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you review the item yourself as a read-only pass using the checklists below and POST the VERDICT — **absence is never a PASS**.
4. **Track rounds.** Count existing VERDICT comments before spawning. After 3 rounds of FAIL on the same item, stop the loop and escalate to human review: post a comment saying the round limit was reached and a human decision is needed, and post no VERDICT. Nobody — including you on a later turn — may replace that escalation with a self-reviewed VERDICT.
5. **Fallback.** If the reviewer is unavailable (e.g., the reviewer skill is not registered, or `delegate_task` fails), review the item yourself using the quality checklists in the workflows below.

### Running a reviewer with `delegate_task`

The three reviewers are read-only skills of the Chorus Hermes plugin: `chorus:chorus-proposal-reviewer`, `chorus:chorus-task-reviewer`, and `chorus:chorus-code-reviewer`. Each runs as a `delegate_task` child:

- **Marker.** The `context` MUST start with `[chorus-reviewer:<kind>]` (kind = `proposal` | `task` | `code`), and the `goal` should contain it too. The plugin uses the marker to put the child in read-only mode: Chorus write tools other than `chorus_add_comment` are blocked, and so are `write_file`, `patch`, `terminal`, `execute_code`, and `delegate_task`.
- **Isolated context.** The child knows nothing of your conversation. Put every UUID, the repo path, the round cap, and the evidence paths in `context`, along with the instruction to `skill_view` its reviewer skill first. A reviewer gets no Chorus session.
- **Evidence bundle.** Because the reviewer cannot run commands, YOU build the evidence before delegating a task or code review: write the diff, the commit log, and the project's test/build output to files (e.g. under `/tmp/chorus-review/<uuid>/`) with `terminal`, and pass the absolute paths. The reviewer reads them with `read_file`. A proposal review needs no bundle (everything is in Chorus), but you may pass the repo path for convention checks.
- **Blocking.** `delegate_task` returns when the reviewer finishes. Nothing needs tracking or closing. Then read the VERDICT comment with `chorus_get_comments`.

**Proposal reviewer** (after `chorus_pm_submit_proposal`; VERDICT on the proposal):

```
delegate_task(
  goal="[chorus-reviewer:proposal] Review Chorus proposal <proposal-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:proposal]\nFirst call skill_view(\"chorus:chorus-proposal-reviewer\") and follow it.\nProposal UUID: <proposal-uuid>\nProject UUID: <project-uuid>\nMax review rounds: 3 (read existing comments first to determine the round number)\nRepo: <abs repo path>",
)
```

**Task reviewer** (after `chorus_submit_for_verify`; VERDICT on the task):

```
# Evidence bundle first (parent, via terminal; <base> = branch point, e.g. main)
mkdir -p /tmp/chorus-review/<task-uuid>
git diff <base>...HEAD > /tmp/chorus-review/<task-uuid>/diff.patch
git log --oneline <base>..HEAD > /tmp/chorus-review/<task-uuid>/log.txt
<project test/build command> > /tmp/chorus-review/<task-uuid>/tests.txt 2>&1

delegate_task(
  goal="[chorus-reviewer:task] Review Chorus task <task-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:task]\nFirst call skill_view(\"chorus:chorus-task-reviewer\") and follow it.\nTask UUID: <task-uuid>\nProject UUID: <project-uuid>\nMax review rounds: 3\nRepo: <abs repo path>\nEvidence: /tmp/chorus-review/<task-uuid>/diff.patch, /tmp/chorus-review/<task-uuid>/log.txt, /tmp/chorus-review/<task-uuid>/tests.txt",
)
```

**Code reviewer** (after the Idea's last task is verified; VERDICT on the idea):

```
# Aggregate evidence for the whole feature (<base> = commit before the idea's first task)
mkdir -p /tmp/chorus-review/<idea-uuid>
git diff <base>...HEAD > /tmp/chorus-review/<idea-uuid>/diff.patch
git log --oneline <base>..HEAD > /tmp/chorus-review/<idea-uuid>/log.txt
<project test/build command> > /tmp/chorus-review/<idea-uuid>/tests.txt 2>&1

delegate_task(
  goal="[chorus-reviewer:code] Review aggregate code for Chorus idea <idea-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:code]\nFirst call skill_view(\"chorus:chorus-code-reviewer\") and follow it.\nIdea UUID: <idea-uuid>\nProposal UUID: <proposal-uuid>\nRound: <N> (count prior code-review VERDICT comments on the idea)\nMax review rounds: CHORUS_MAX_CODE_REVIEW_ROUNDS (default 3; 0 = unlimited)\nRepo: <abs repo path>\nEvidence: /tmp/chorus-review/<idea-uuid>/diff.patch, /tmp/chorus-review/<idea-uuid>/log.txt, /tmp/chorus-review/<idea-uuid>/tests.txt",
)
```

The Chorus Hermes plugin's `transform_tool_result` hook appends a reminder with this same shape to the results of `chorus_pm_submit_proposal` (proposal reviewer), `chorus_submit_for_verify` (task reviewer), and `chorus_admin_verify_task` (code reviewer, when the idea's last task is done). The reminder never launches the reviewer for you.

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

Run `chorus-proposal-reviewer` per the [Review Strategy](#review-strategy) above — a `delegate_task` child with the `[chorus-reviewer:proposal]` marker (see the proposal reviewer example). The call blocks until it finishes. Read its VERDICT comment before proceeding.

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

Build the evidence bundle, then run `chorus-task-reviewer` per the [Review Strategy](#review-strategy) above — a `delegate_task` child with the `[chorus-reviewer:task]` marker (see the task reviewer example). The call blocks until it finishes. After it completes, read its VERDICT:

- **VERDICT: PASS** or **PASS WITH NOTES** → proceed to B3 (mark AC) and B4 (verify).
- **VERDICT: FAIL** → skip to B4 and **reopen** the task. Do NOT mark AC as passed.

#### B2.6: Final Code-Review Gateway (after an Idea's LAST task is verified)

When the task you just verified is the **last** task of its idea-rooted proposal, run the ship-time code-review gateway before the Idea's code is considered shipped. The Chorus Hermes plugin appends a reminder to the `chorus_admin_verify_task` result to run `chorus-code-reviewer` (gated by `CHORUS_ENABLE_CODE_REVIEWER`, default on). Build the aggregate evidence bundle and run it per the [Review Strategy](#review-strategy) — a `delegate_task` child with the `[chorus-reviewer:code]` marker (see the code reviewer example), passing the `ideaUuid` + round number. It reviews the Idea's **aggregate** code change across all its tasks — cross-task integration, architecture/convention consistency, security, regression/performance, feature-level test coverage — dimensions a single-task review cannot see — and posts one `VERDICT` comment on the **idea**.

- **VERDICT: PASS** / **PASS WITH NOTES** → the feature may ship.
- **VERDICT: FAIL** → do not reopen the verified tasks; instead add new fix tasks to the approved proposal via the quick-dev skill (`skill_view("chorus:quick-dev")`) (`chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it). Group related small BLOCKERs by default; split only materially large or independently testable fixes. Require AC self-check, independent task review, and admin verification for every fix task. Re-run aggregate review only after every fix is successfully `done`; a failed or cancelled fix stops the loop and escalates. Bounded by `CHORUS_MAX_CODE_REVIEW_ROUNDS` (env, default 3; 0 = unlimited).

> **Advisory / behavioral** — the gateway does not change the Idea's stored status; the admin honors its verdict. Run it **before** writing any idea-completion report (the report must not be written while a `FAIL` is outstanding).

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

> **Note:** Creating ideas is a PM tool (`chorus_pm_create_idea`). See `skill_view("chorus:idea")`.

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
- **Verify between waves** — In wave mode, verify tasks to `done` between waves to unblock downstream dependencies; `delegate_task` blocks until the wave's workers return, so verify after it returns and close each worker's Chorus session

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

- For platform overview and shared tools, see `skill_view("chorus:chorus")`
- For Idea elaboration (before proposals), see `skill_view("chorus:idea")`
- For Proposal creation (what you're reviewing), see `skill_view("chorus:proposal")`
- For Developer workflow (what you're verifying), see `skill_view("chorus:develop")`
