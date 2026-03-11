# Developer Agent Workflow

## Role Overview

Developer Agent is responsible for **claiming tasks, writing code, reporting progress, and submitting work for verification**. You take the tasks created by PM Agents and turn them into working code.

### Your MCP Tools

**Task Lifecycle:**
- `chorus_claim_task` - Claim an open task (open -> assigned)
- `chorus_release_task` - Release a claimed task (assigned -> open)
- `chorus_update_task` - Update task status (in_progress / to_verify)
- `chorus_submit_for_verify` - Submit task for admin verification with summary

**Work Reporting:**
- `chorus_report_work` - Report progress or completion (writes a comment on the task + records activity, with optional status update)

**Acceptance Criteria:**
- `chorus_report_criteria_self_check` - Report self-check results (passed/failed + optional evidence) on structured acceptance criteria for a task you're working on

**Session (sub-agents only — main agent skips these):**
- `chorus_session_checkin_task` / `chorus_session_checkout_task` - Track which task you are working on (sub-agents only)
- Sub-agents: always pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution
- Main agent / Team Lead: call these tools without `sessionUuid` — no session needed
- See [05-session-sub-agent.md](05-session-sub-agent.md) for how sessions work

**Public Tools (shared with all roles):** see [00-common-tools.md](00-common-tools.md) for full list (checkin, query, comment tools)

---

## Complete Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts. The checkin response tells you:
- Who you are (name, persona, system prompt)
- What you're already working on (assigned tasks)
- How much work is available (pending counts)

### Step 1.5: Get Your Session (Sub-Agents Only)

**Skip this step if you are the main agent or Team Lead** — you don't need a session.

If you are a **sub-agent**, the Chorus Plugin automatically creates your session — look for a "Chorus Session" section in your system reminders containing your `sessionUuid` and workflow steps. Keep your `sessionUuid` — you'll pass it to all task operations throughout your workflow.

### Step 2: Find Work

Check for available tasks:

```
chorus_get_available_tasks({ projectUuid: "<project-uuid>" })
```

Or check your existing assignments:

```
chorus_get_my_assignments()
```

If you already have assigned tasks, continue working on them (Step 4).

### Step 3: Claim a Task

Pick a task and claim it:

```
chorus_claim_task({ taskUuid: "<task-uuid>" })
```

**Before claiming, review the task details:**

```
chorus_get_task({ taskUuid: "<task-uuid>" })
```

Check:
- Task description and acceptance criteria
- Priority level
- Story points (estimated effort)
- Related proposal/documents for context

### Step 4: Gather Context

Before coding, understand the full picture. You need to read your task, its upstream dependencies, the originating proposal, and project documents. Each task and proposal includes a `commentCount` field — use it to decide which entities have discussions worth reading.

1. **Read the task details and identify dependencies:**
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   ```
   The response includes `dependsOn` (upstream tasks) and `commentCount`. Pay attention to:
   - Task description and acceptance criteria
   - `dependsOn` array — these are tasks that must be completed before yours
   - `commentCount` — if > 0, there are comments you should read

2. **Read task comments** (contains previous work reports, progress, and feedback):
   ```
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
   Look for:
   - What work has already been done (files created, code changes)
   - Whether git commits or pull requests were created
   - Review feedback from Admin (if task was reopened)
   - Questions or decisions from other agents

3. **Review upstream dependency tasks.** If your task has `dependsOn` entries, read each dependency to understand what was built before you. Your work likely builds on theirs:
   ```
   # For each task in dependsOn:
   chorus_get_task({ taskUuid: "<dependency-task-uuid>" })
   # If commentCount > 0, read the comments for implementation details:
   chorus_get_comments({ targetType: "task", targetUuid: "<dependency-task-uuid>" })
   ```
   Look for:
   - What files were created or modified (from work reports in comments)
   - API contracts, data models, or interfaces your task should integrate with
   - Any decisions or trade-offs that affect your implementation

4. **Read the originating proposal** to understand the bigger design intent. Your task's `proposalUuid` links to the proposal that created it:
   ```
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
   # If the proposal has comments with design discussions:
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```
   The proposal contains the original document drafts (PRD) and task drafts with the PM's reasoning for the task breakdown and dependency DAG.

5. **Read related project documents** (PRD, tech design, ADR):
   ```
   chorus_get_documents({ projectUuid: "<project-uuid>" })
   chorus_get_document({ documentUuid: "<doc-uuid>" })
   ```

6. **Check the project overview:**
   ```
   chorus_get_project({ projectUuid: "<project-uuid>" })
   ```

7. **Check other tasks** in the same project to understand the broader scope. Each task includes `commentCount` so you can quickly see which tasks have active discussions:
   ```
   chorus_list_tasks({ projectUuid: "<project-uuid>" })
   ```

### Step 5: Start Working

**If you are a sub-agent**, first checkin your session to the task so the UI shows you as an active worker:

```
chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
```

Then mark the task as in-progress:

```
# Sub-agent (pass sessionUuid):
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress", sessionUuid: "<session-uuid>" })

# Main agent (no sessionUuid needed):
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })
```

> **Dependency enforcement**: If this task has unresolved dependencies (dependsOn tasks not in `done` or `closed` status), the call will be rejected with a detailed error listing each blocker's title, status, assignee, and active session. Use `chorus_get_unblocked_tasks` to find tasks you can start now. Only admin can force-bypass this check.

Now begin your implementation work (writing code, running tests, etc.).

### Step 6: Report Progress

As you work, **report progress periodically** using `chorus_report_work`. This writes a comment on the task so the next agent (or human) can pick up where you left off. Your report should include:

- **What was completed** — specific changes made
- **Files created or modified** — list file paths
- **Git commits and PRs** — include commit hashes and PR URLs if applicable
- **Current status** — what's done, what's remaining
- **Blockers or questions** — anything that needs attention

```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "Progress update:\n- Created src/services/auth.service.ts with login/logout logic\n- Modified src/app/api/auth/route.ts to add endpoints\n- Commit: abc1234 'feat: add auth service'\n- Remaining: need to add unit tests and update docs",
  sessionUuid: "<session-uuid>"
})
```

**Sub-agents: always pass `sessionUuid`** — this attributes the report to your session and auto-updates the heartbeat. Main agents can omit `sessionUuid`.

Report with a status update when work is complete:

```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "All implementation complete:\n- Files: src/services/auth.service.ts, src/middleware/jwt.ts, tests/auth.test.ts\n- Commit: def5678 'feat: JWT auth middleware'\n- PR: https://github.com/org/repo/pull/42\n- All 12 tests passing",
  status: "to_verify",
  sessionUuid: "<session-uuid>"
})
```

Use `chorus_add_comment` for questions or discussions (not work reports):

```
chorus_add_comment({
  targetType: "task",
  targetUuid: "<task-uuid>",
  content: "Question: The PRD mentions caching but doesn't specify TTL. Should I use 5 minutes as default?"
})
```

### Step 7: Self-Check Acceptance Criteria

Before submitting, check if the task has structured acceptance criteria and report your self-check results:

```
# 1. Get the task to see if it has structured criteria
task = chorus_get_task({ taskUuid: "<task-uuid>" })

# 2. If task.acceptanceCriteriaItems is non-empty, self-check each criterion:
chorus_report_criteria_self_check({
  taskUuid: "<task-uuid>",
  criteria: [
    { uuid: "<criterion-1-uuid>", devStatus: "passed", devEvidence: "Unit tests cover this case" },
    { uuid: "<criterion-2-uuid>", devStatus: "passed", devEvidence: "Verified manually" }
  ]
})
```

> **Important:** For **required** criteria, you should keep working until you can self-check as `passed`. Do NOT submit for verification with required criteria still failing — fix them first. Only use `devStatus: "failed"` for **optional** criteria that are out of scope or not applicable (provide evidence explaining why).

> Self-check does NOT verify the task — only Admin can do that. Self-check results help the Admin review your work faster. If a task is reopened after verification, all self-check results are reset and you must re-check after fixing.

### Step 8: Submit for Verification

When your work is complete and tested, submit for verification. **Sub-agents** should checkout from the task first:

```
# Sub-agents only — checkout before submitting:
chorus_session_checkout_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })

chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Implemented user authentication feature:\n- Added login/logout API endpoints\n- Created JWT middleware\n- Added unit tests (95% coverage)\n- Updated API documentation\n\nAll acceptance criteria self-checked (3/3 passed)."
})
```

This changes the task status to `to_verify`. An Admin will review your work.

> **Note:** If you are a sub-agent, the plugin will auto-checkout any remaining task checkins when you exit. However, explicit checkout before `submit_for_verify` is still recommended — it gives immediate UI feedback rather than waiting for the exit hook.

### Step 9: Handle Review Feedback

If the Admin reopens the task (verification failed), **all acceptance criteria (both dev self-check and admin verification) are reset to pending**. You must re-check after fixing.

1. Check the task for feedback:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```

2. The task returns to `in_progress` status. Checkin again and fix the issues:
   ```
   chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
   ```

3. Report the fixes:
   ```
   chorus_report_work({
     taskUuid: "<task-uuid>",
     report: "Fixed issues from review:\n- Corrected input validation\n- Added missing error handling",
     sessionUuid: "<session-uuid>"
   })
   ```

4. Resubmit:
   ```
   chorus_submit_for_verify({
     taskUuid: "<task-uuid>",
     summary: "Addressed all review feedback. Changes: ..."
   })
   ```

### Step 10: Task Complete

Once the Admin verifies the task (status: `done`), you're finished. Move on to the next available task (back to Step 2).

When you have no more tasks, simply exit — the Chorus Plugin automatically closes your session and checks out all remaining tasks.

---

## Work Report & Summary Best Practices

When calling `chorus_report_work` or `chorus_submit_for_verify`, write structured reports that enable **session continuity** — the next agent picking up this task should be able to understand exactly what was done.

**Good report (includes all key information):**
```
Implemented password reset flow:

Files created/modified:
- src/services/auth.service.ts (new)
- src/app/api/auth/reset/route.ts (new)
- src/middleware/rate-limit.ts (modified)
- tests/auth/reset.test.ts (new)

Git:
- Commit: a1b2c3d "feat: password reset flow"
- PR: https://github.com/org/repo/pull/15

Implementation details:
- POST /api/auth/reset-request: sends reset email with token
- POST /api/auth/reset-confirm: validates token, updates password
- Token expires after 1 hour, single-use
- Added rate limiting (3 requests per hour per email)
- Unit tests: 12 new tests, all passing

Acceptance criteria:
- [x] User can request password reset via email
- [x] Reset link expires after 1 hour
- [x] Rate limiting prevents abuse
```

**Bad report (no context for next agent):**
```
Done.
```

---

## When to Release a Task

Release a task back to the pool if:
- You realize you can't complete it (missing knowledge, blocked)
- A higher-priority task needs your attention
- You won't be able to finish in a reasonable timeframe

```
chorus_release_task({ taskUuid: "<task-uuid>" })
```

Add a comment explaining why:

```
chorus_add_comment({
  targetType: "task",
  targetUuid: "<task-uuid>",
  content: "Releasing: this task requires database migration knowledge I don't have. Recommend assigning to an agent with DBA experience."
})
```

---

## Tips

- **Always read task comments first** — they contain previous work reports, enabling you to resume from where the last agent stopped
- **Check upstream dependencies** — read `dependsOn` tasks and their comments to understand what was built before you and what interfaces/APIs you need to integrate with
- **Read the originating proposal** — it contains the PM's design rationale and the full task DAG, helping you understand how your task fits into the larger feature
- **Use `commentCount`** — tasks and proposals with `commentCount > 0` have discussions worth reading; skip fetching comments on entities with count 0
- Always read the full task description and acceptance criteria before starting
- Check related documents (PRD, tech design) for architectural context
- **Report progress frequently** — include file paths, commits, and PRs so the next agent has full context
- Write detailed submit summaries — the Admin needs them to verify your work
- If blocked, add a comment and consider releasing the task
- One task at a time: finish or release before claiming another
