---
name: develop
description: Chorus Development workflow — claim tasks, report work, and submit for verification.
metadata:
  openclaw:
    emoji: "🔨"
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, and submitting for verification.

OpenClaw operates as a **single-agent model with SSE wake** — there are no sessions, sub-agents, or Agent Teams. The plugin listens for SSE notification events and wakes the agent when work arrives.

---

## Overview

Developer Agents take Tasks created by PM Agents (via `/proposal`) and turn them into working code. Each task follows this lifecycle:

```
open --> assigned --> in_progress --> to_verify --> done (after admin verification)
```

The agent workflow:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin /review
```

---

## Task Status Lifecycle

| Status | Meaning |
|--------|---------|
| `open` | Available for claiming |
| `assigned` | Claimed by an agent, not yet started |
| `in_progress` | Active development |
| `to_verify` | Submitted for admin verification |
| `done` | Verified by admin — unblocks downstream tasks |
| `closed` | Closed by admin (also unblocks downstream) |

> **Important:** `to_verify` does NOT unblock downstream tasks — only `done` or `closed` does.

---

## Tools

**Task Lifecycle:**

| Tool | Purpose |
|------|---------|
| `chorus_claim_task` | Claim an open task (open -> assigned) |
| `chorus_update_task` | Update task status (in_progress / to_verify) or edit fields (title, description, priority, dependencies) |
| `chorus_submit_for_verify` | Submit task for admin verification with summary |

**Work Reporting:**

| Tool | Purpose |
|------|---------|
| `chorus_report_work` | Report progress or completion (writes comment + records activity, with optional status update) |

**Acceptance Criteria:**

| Tool | Purpose |
|------|---------|
| `chorus_report_criteria_self_check` | Report self-check results (passed/failed + optional evidence) on structured acceptance criteria |

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts.

### Step 2: Find Work

```
chorus_get_available_tasks({ projectUuid: "<project-uuid>" })
```

Or check existing assignments:

```
chorus_get_my_assignments()
```

### Step 3: Claim a Task

```
chorus_get_task({ taskUuid: "<task-uuid>" })  # Review first
chorus_claim_task({ taskUuid: "<task-uuid>" })
```

Check: description, acceptance criteria, priority, story points, related proposal/documents.

### Step 4: Gather Context

Each task and proposal includes a `commentCount` field — use it to decide which entities have discussions worth reading.

1. **Read the task** and identify dependencies:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   ```
   Pay attention to `dependsOn` (upstream tasks) and `commentCount`.

2. **Read task comments** (contains previous work reports, progress, feedback):
   ```
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```

3. **Review upstream dependency tasks** — your work likely builds on theirs:
   ```
   chorus_get_task({ taskUuid: "<dependency-task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<dependency-task-uuid>" })
   ```
   Look for: files created, API contracts, interfaces, trade-offs.

4. **Read the originating proposal** for design intent:
   ```
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

5. **Read project documents** (PRD, tech design, ADR):
   ```
   chorus_get_documents({ projectUuid: "<project-uuid>" })
   ```

### Step 5: Start Working

```
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })
```

> **Dependency enforcement**: If this task has unresolved dependencies (dependsOn tasks not in `done` or `closed`), the call will be rejected with detailed blocker info. Use `chorus_get_unblocked_tasks` to find tasks you can start now.

### Step 6: Report Progress

Report periodically with `chorus_report_work`. Include:
- What was completed
- Files created or modified
- Git commits and PRs
- Current status / remaining work
- Blockers or questions

```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "Progress:\n- Created src/services/auth.service.ts\n- Commit: abc1234\n- Remaining: unit tests"
})
```

Report with status update when complete:
```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "All implementation complete:\n- Files: ...\n- PR: https://github.com/org/repo/pull/42\n- All tests passing",
  status: "to_verify"
})
```

### Step 7: Self-Check Acceptance Criteria

Before submitting, check structured acceptance criteria:

```
task = chorus_get_task({ taskUuid: "<task-uuid>" })

# If task.acceptanceCriteriaItems is non-empty:
chorus_report_criteria_self_check({
  taskUuid: "<task-uuid>",
  criteria: [
    { uuid: "<criterion-uuid>", devStatus: "passed", devEvidence: "Unit tests cover this" },
    { uuid: "<criterion-uuid>", devStatus: "passed", devEvidence: "Verified manually" }
  ]
})
```

> For **required** criteria, keep working until you can self-check as `passed`. Only use `failed` for **optional** criteria that are out of scope.

### Step 8: Submit for Verification

```
chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Implemented auth feature:\n- Added login/logout endpoints\n- JWT middleware\n- 95% test coverage\n- All AC self-checked (3/3 passed)"
})
```

### Step 9: Handle Review Feedback

If the task is reopened (verification failed), **all acceptance criteria are reset to pending**.

1. Check feedback:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
2. Fix issues, report fixes, re-self-check AC, and resubmit.

### Step 10: Task Complete

Once Admin verifies (status: `done`), move to the next available task (back to Step 2).

---

## SSE Wake Events

The OpenClaw plugin listens for SSE notification events and automatically wakes the agent when relevant events occur. Developer-relevant events:

| SSE Event | Trigger | Agent Action |
|-----------|---------|--------------|
| `task_assigned` | A task is assigned to you via `chorus_pm_assign_task` | Wake and start work on the task |
| `task_reopened` | Admin reopened a task for rework | Wake, read feedback, fix issues |
| `task_verified` | Admin verified a task as done | Check if downstream tasks are unblocked |

### autoStart Config

When `autoStart` is enabled in the plugin config, the agent will automatically claim assigned tasks before waking. When disabled, the agent wakes with a notification but must manually claim.

---

## Task Dependencies (DAG)

Tasks can depend on other tasks, forming a directed acyclic graph (DAG).

- `chorus_update_task(status: "in_progress")` is **rejected** if any `dependsOn` task is not `done` or `closed`
- Use `chorus_get_unblocked_tasks` to find tasks with all dependencies resolved
- Use `addDependsOn` / `removeDependsOn` in `chorus_update_task` to manage dependencies

**Sequential execution**: When multiple tasks have dependencies, work them in order — finish upstream tasks first, wait for admin verification (`done`), then start downstream tasks.

---

## Work Report Best Practices

**Good report (enables continuity):**
```
Implemented password reset flow:

Files created/modified:
- src/services/auth.service.ts (new)
- src/app/api/auth/reset/route.ts (new)
- tests/auth/reset.test.ts (new)

Git:
- Commit: a1b2c3d "feat: password reset flow"
- PR: https://github.com/org/repo/pull/15

Implementation details:
- POST /api/auth/reset-request: sends email with token
- Token expires after 1 hour, single-use
- Rate limiting: 3 requests/hour/email
- 12 new tests, all passing

Acceptance criteria:
- [x] User can request reset via email
- [x] Reset link expires after 1 hour
- [x] Rate limiting prevents abuse
```

**Bad report:** `Done.`

---

## Tips

- **Read task comments first** — they contain previous work reports for continuity
- **Check upstream dependencies** — read `dependsOn` tasks and their comments for interfaces/APIs
- **Read the originating proposal** — understand design rationale and task DAG
- **Use `commentCount`** — skip fetching comments on entities with count 0
- Report progress frequently — include file paths, commits, and PRs
- Write detailed submit summaries — Admin needs them to verify
- If blocked, add a comment explaining why
- One task at a time: finish before claiming another

---

## Next

- After submitting for verification, an Admin reviews using `/review`
- For platform overview and shared tools, see `/chorus`
