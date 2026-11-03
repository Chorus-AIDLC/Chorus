---
name: review
description: Chorus Review workflow — approve/reject proposals, verify tasks, and manage project governance.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.23.3"
  category: project-management
  mcp_server: chorus
---

# Review Skill

This skill covers the **Review** stage of the AI-DLC workflow: approving or rejecting Proposals, verifying completed Tasks, and managing overall project governance as an Admin Agent.

---

## Session scope for CLI daemon wakes

These rules apply only to wakes handled by an updated Chorus CLI daemon that honors the server-delivered SSE `sessionId`. They do not upgrade OpenClaw, Hermes, or dsh-native session routing; those native runtimes retain their existing behavior. Older daemons may fall back to legacy entity/Idea routing, so do not assume task/review isolation there.

- **Task work:** `task:<uuid>` is a task-scoped session with no Idea-session memory. Fetch the current task, its proposal and documents, and its direct Idea from Chorus before starting work; do not rely on the orchestrator's conversation. Sibling tasks of the same Idea can run concurrently for one agent and may share the working directory. Before editing when siblings share the cwd, work in your own git worktree; the daemon does not create one for you.
- **Review work:** a Team review request uses `review:<type>:<uuid>`, where type is `proposal`, `task`, or `idea` (a code review targets the Idea). It is a read-only review-scoped session with no development-session memory. Fetch the target and current reviewer protocol/context before reviewing; do not implement fixes or perform lifecycle writes. A re-review by the same reviewer of the same target resumes the same review session, preserving review history rather than development memory.
- **Orchestration:** elaboration, proposal work, Start Development, Yolo, and orchestration stay in the bare direct-Idea UUID session (`<directIdeaUuid>`, not `idea:<uuid>`). An orchestrator also assigned a task uses `task:<uuid>` for task-start/reopen work, but orchestration replies and handoffs stay in the Idea session.

These are backend conversation and wake-queue anchors, not the Chorus Agent Session `sessionUuid` used by session check-in tools. Session separation does not isolate files or change the host's existing session check-in lifecycle.

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

## Team-managed review (check first)

Resolve the entity's source Ideas, including proposal/document ancestry, and read each `chorus_get_idea_team_context` before reviewing or acting. For active managed work, follow [Team review routing](../orchestrate/SKILL.md#team-review-routing): only the current orchestrator dispatches through `role: "review"`; a woken Team reviewer posts the routed VERDICT and makes no lifecycle writes. Task verification and human-YOLO proposal approval require current-round PASS / PASS WITH NOTES plus existing authority. Non-YOLO proposal PASS requires one human-owner approval-request comment, not agent approval. Start whole-Idea review when all source-proposal tasks reach `to_verify` / `done` / `closed`, in parallel with task reviews; it gates report/PR only. Stop on paused or unresolved context. The legacy strategy and workflow below apply to **unmanaged** work; generic spawn/approve/reopen instructions do not override the Team protocol.

**Direct Team review requests:** send the complete request envelope required by Team review routing: `Team review request — <kind>, round N`, target UUID, matching local reviewer protocol location, exactly one reviewer @mention, and expected PASS/FAIL recipient names/UUIDs (not mentions). A request must never start a line with `VERDICT:`.

Before reviewing a Team request, you MUST load the current matching proposal/task/code reviewer instructions from the local protocol location, even when reviewing directly in your own session, not only when delegated to a separate reviewer. A wake or mention is not a substitute for loading those instructions. If kind, round, target UUID, protocol location or expected PASS/FAIL recipients are absent, fetch the full request and current entity/Team context; recover only unambiguous values or ask the current orchestrator for a corrected request. Do not guess or emit a verdict until the metadata is resolved and the matching instructions are loaded.

The actual verdict MUST be exactly one plain unformatted line starting at column 1: `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`. No bold, backticks, bullets, quotes, fences or extra verdict line in the posted result; the backticks here only delimit documentation examples. Place exactly one actionable routed @mention before that final line, using the recipient table, and re-read current entity/Team context before posting. Remain read-only; no lifecycle writes.

## Review Strategy

When reviewing proposals, tasks, or an Idea's final aggregate code change, prefer spawning an independent reviewer sub-agent over reviewing manually:

1. **Try the reviewer first.** Spawn `chorus-proposal-reviewer` (for proposals), `chorus-task-reviewer` (for tasks), or `chorus-code-reviewer` (the final ship-time gateway over an Idea's aggregate code change, after its last task is verified — pass the `ideaUuid`; it posts its VERDICT on the **idea**) as a read-only sub-agent. **Spawn it with the `subagent` tool and wait for its VERDICT** — you must wait before proceeding. The verdict is the VERDICT comment it posts on the entity, not the call's return value, so read the comment (step 2). It posts a VERDICT comment with detailed findings.
2. **Read the VERDICT.** After the reviewer completes, call `chorus_get_comments` and find THIS round's `VERDICT:` comment — the one posted after your dispatch, not an older round's. There are exactly three possible outcomes:
   - **VERDICT: PASS** — No issues found. Approve (proposals) or mark AC passed and verify (tasks).
   - **VERDICT: PASS WITH NOTES** — Minor non-blocking notes. Still approve/verify. Notes are informational.
   - **VERDICT: FAIL** — BLOCKERs found. Reject (proposals) or reopen (tasks). Fix the specific BLOCKERs listed in the comment before resubmitting.
3. **No new VERDICT comment?** Check what the reviewer *did* post. A comment reporting that the round limit was reached, or any other explicit refusal to review, is a deliberate escalation to a human: STOP — do not respawn, do not self-review, do not post a VERDICT of your own. If it posted nothing at all, respawn it ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you review the item yourself as a read-only pass using the checklists below and POST the VERDICT — **absence is never a PASS**.
4. **Track rounds.** Count existing VERDICT comments before spawning. After 3 rounds of FAIL on the same item, stop the loop and escalate to human review: post a comment saying the round limit was reached and a human decision is needed, and post no VERDICT. Nobody — including you on a later turn — may replace that escalation with a self-reviewed VERDICT.
5. **Fallback.** If the reviewer is unavailable (e.g., agent type not registered, sub-agent spawn fails), review the item yourself using the quality checklists in the workflows below.

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

**Managed work:** use [Team review routing](../orchestrate/SKILL.md#team-review-routing) instead of the unmanaged dispatch/timing below.

Spawn `chorus-proposal-reviewer` per the [Review Strategy](#review-strategy) above — spawn it with the `subagent` tool and wait for its VERDICT. Read its VERDICT comment before proceeding.

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

**Managed work:** use [Team review routing](../orchestrate/SKILL.md#team-review-routing) instead of the unmanaged dispatch/timing below.

Spawn `chorus-task-reviewer` per the [Review Strategy](#review-strategy) above — spawn it with the `subagent` tool and wait for its VERDICT. After it completes, read its VERDICT:

- **VERDICT: PASS** or **PASS WITH NOTES** → proceed to B3 (mark AC) and B4 (verify).
- **VERDICT: FAIL** → skip to B4 and **reopen** the task. Do NOT mark AC as passed.

#### B2.6: Final Code-Review Gateway (after an Idea's LAST task is verified)

**Managed work:** use [Team review routing](../orchestrate/SKILL.md#team-review-routing) instead of the unmanaged dispatch/timing below.

When the task you just verified is the **last** task of its idea-rooted proposal, run the ship-time code-review gateway before the Idea's code is considered shipped. The the extension injects a reminder to spawn `chorus-code-reviewer` (gated by `enableCodeReviewer`, default on). Spawn it per the [Review Strategy](#review-strategy) — with the `subagent` tool, passing the `ideaUuid` + round number. It reviews the Idea's **aggregate** code change across all its tasks — cross-task integration, architecture/convention consistency, security, regression/performance, feature-level test coverage — dimensions a single-task review cannot see — and posts one `VERDICT` comment on the **idea**.

- **VERDICT: PASS** / **PASS WITH NOTES** → the feature may ship.
- **VERDICT: FAIL** → do not reopen the verified tasks; instead add new fix tasks to the approved proposal via `/skill:quick-dev` (`chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it). Group related small BLOCKERs by default; split only materially large or independently testable fixes. Require AC self-check, independent task review, and admin verification for every fix task. Re-run aggregate review only after every fix is successfully `done`; a failed or cancelled fix stops the loop and escalates. Bounded by `CHORUS_MAX_CODE_REVIEW_ROUNDS` (env, default 3; 0 = unlimited).

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
- **Verify between waves** — In wave mode, verify tasks to `done` between waves to unblock downstream dependencies; each worker's dispatch/run owns its own lifecycle, so there is no handle to close

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
