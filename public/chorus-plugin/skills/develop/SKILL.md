---
name: develop
description: Chorus Development workflow — claim tasks, report work, manage sessions, and integrate with Claude Code Agent Teams.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: project-management
  mcp_server: chorus
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, submitting for verification, and managing sessions for sub-agent observability.

---

## Overview

Developer Agents take Tasks created by PM Agents (via `/proposal`) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin /review
```

For multi-agent parallel execution, Chorus integrates with Claude Code Agent Teams (swarm mode) with full session-based observability.

---

## Tools

**Task Lifecycle:**

| Tool | Purpose |
|------|---------|
| `chorus_claim_task` | Claim an open task (open -> assigned) |
| `chorus_release_task` | Release a claimed task (assigned -> open) |
| `chorus_update_task` | Update task status (in_progress / to_verify) |
| `chorus_submit_for_verify` | Submit task for admin verification with summary |

**Work Reporting:**

| Tool | Purpose |
|------|---------|
| `chorus_report_work` | Report progress or completion (writes comment + records activity, with optional status update) |

**Acceptance Criteria:**

| Tool | Purpose |
|------|---------|
| `chorus_report_criteria_self_check` | Report self-check results (passed/failed + optional evidence) on structured acceptance criteria |

**Session (sub-agents only — main agent skips these):**

| Tool | Purpose |
|------|---------|
| `chorus_session_checkin_task` | Checkin to a task before starting work |
| `chorus_session_checkout_task` | Checkout from a task when work is done |

Sub-agents: always pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution.
Main agent / Team Lead: call these tools without `sessionUuid` — no session needed.

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts.

### Step 1.5: Get Your Session (Sub-Agents Only)

**Skip if you are the main agent or Team Lead.**

If you are a **sub-agent**, the Chorus Plugin automatically creates your session — look for a "Chorus Session" section in your system reminders containing your `sessionUuid`. Keep it for all task operations.

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

**Sub-agent**: checkin to the task first:
```
chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
```

Then mark as in-progress:
```
# Sub-agent:
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress", sessionUuid: "<session-uuid>" })

# Main agent:
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
  report: "Progress:\n- Created src/services/auth.service.ts\n- Commit: abc1234\n- Remaining: unit tests",
  sessionUuid: "<session-uuid>"
})
```

Report with status update when complete:
```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "All implementation complete:\n- Files: ...\n- PR: https://github.com/org/repo/pull/42\n- All tests passing",
  status: "to_verify",
  sessionUuid: "<session-uuid>"
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

**Sub-agents** — checkout first:
```
chorus_session_checkout_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
```

Then submit:
```
chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Implemented auth feature:\n- Added login/logout endpoints\n- JWT middleware\n- 95% test coverage\n- All AC self-checked (3/3 passed)"
})
```

> `to_verify` does NOT unblock downstream tasks — only `done` (after admin verification) does.

> **Review Agent:** After `chorus_submit_for_verify`, the Chorus plugin's PostToolUse hook will suggest spawning `chorus:task-reviewer` — an independent, read-only review agent. Follow the suggestion to get an adversarial review before admin verification. The reviewer posts a VERDICT comment on the task. Its result is advisory (does not block verification).

### Step 9: Handle Review Feedback

If reopened (verification failed), **all acceptance criteria are reset to pending**.

1. Check feedback:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
2. Checkin again, fix issues, report fixes, resubmit.

### Step 10: Task Complete

Once Admin verifies (status: `done`), move to the next available task (back to Step 2).

---

## Session (Sub-Agents Only)

The Chorus Plugin **fully automates** session lifecycle — creation, heartbeat, and cleanup are all handled by hooks. Sub-agents only do 3 things manually:

1. `chorus_session_checkin_task({ sessionUuid, taskUuid })` — before starting work
2. `chorus_session_checkout_task({ sessionUuid, taskUuid })` — when done (recommended; plugin also auto-checkouts on exit)
3. Pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution

**Main agent / Team Lead**: no session needed — call tools without `sessionUuid`.

---

## Claude Code Agent Teams Integration

When using Claude Code's Agent Teams to run multiple sub-agents in parallel, Chorus provides full work observability.

### Two-Layer Architecture

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Claude Code Agent Teams | Spawning sub-agents, task dispatch, inter-agent messaging |
| **Work Tracking** | Chorus | Task lifecycle, session observability, activity stream |

### Team Lead Workflow

```
# 1. Check in and plan
chorus_checkin()
chorus_list_tasks({ projectUuid: "<project-uuid>" })

# 2. Create Claude Code team and spawn sub-agents
TeamCreate({ team_name: "feature-x" })

# Pass only task UUIDs — plugin auto-injects session workflow
Task({
  name: "frontend-worker",
  prompt: "Your Chorus task UUID: <task-uuid>\nProject UUID: <project-uuid>\n\nImplement..."
})
```

**What the Team Lead prompt needs:**
- Task UUID(s)
- NO session UUID, NO workflow boilerplate — plugin auto-injects everything

### Sub-Agent Workflow

The plugin injects session UUID and workflow into the sub-agent's context automatically.

```
# 1. Checkin to task
chorus_session_checkin_task({ sessionUuid: "<my-session-uuid>", taskUuid: "<my-task-uuid>" })

# 2. Move to in_progress
chorus_update_task({ taskUuid: "<my-task-uuid>", status: "in_progress", sessionUuid: "<my-session-uuid>" })

# 3. Do work... code, test, commit...

# 4. Report progress
chorus_report_work({ taskUuid: "<my-task-uuid>", report: "...", sessionUuid: "<my-session-uuid>" })

# 5. Checkout and submit
chorus_session_checkout_task({ sessionUuid: "<my-session-uuid>", taskUuid: "<my-task-uuid>" })
chorus_submit_for_verify({ taskUuid: "<my-task-uuid>", summary: "..." })

# 6. Notify team lead
SendMessage({ type: "message", recipient: "team-lead", content: "Task complete" })

# DO NOT close session — plugin closes it automatically on exit
```

### Handling Task Dependencies (DAG)

> **Server-side enforcement**: `chorus_update_task(status: "in_progress")` rejects if any `dependsOn` task is not `done` or `closed`.

**Wave-based execution (recommended):**
1. `chorus_get_unblocked_tasks` — find ready tasks
2. Spawn sub-agents for Wave 1
3. Wait for `to_verify`, then **verify each task** (`chorus_admin_verify_task` → `done`)
4. `chorus_get_unblocked_tasks` — find newly unblocked tasks (Wave 2)
5. Repeat until all tasks done

> **Critical:** `to_verify` does NOT resolve dependencies — only `done` or `closed` does. The Team Lead must verify tasks between waves.

### Multiple Tasks Per Sub-Agent

A single sub-agent can work on multiple tasks sequentially:

```
Task({
  name: "full-stack-worker",
  prompt: "Your Chorus tasks (work in order):\n1. task-schema-uuid\n2. task-api-uuid (depends on #1)\n\nFor EACH task: checkin -> in_progress -> work -> report -> checkout -> submit_for_verify"
})
```

### MCP Access for Sub-Agents

Sub-agents need MCP configured at **project level** (`.mcp.json` or `.claude/settings.json`). User-level config may not be accessible to sub-agents.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Sub-agent can't access Chorus MCP tools | Verify MCP is configured at project level, API key has developer role |
| UI doesn't show active workers | Sub-agent forgot `chorus_session_checkin_task`. Check: `chorus_get_session` |
| Session shows "inactive" (yellow) | No heartbeat in 1h. TeammateIdle hook should auto-send. Agent may have crashed |
| Task stuck in wrong status | Spawn new sub-agent with same name (plugin auto-reopens session), or use `chorus_update_task` to reset |
| Duplicate sessions | Never call `chorus_create_session` — plugin handles all session creation. Close extras via Settings page |
| Sub-agent didn't receive session | Check plugin is loaded (`/plugin list`) and `CHORUS_URL` is set. Ensure `name` parameter is set |

---

## Work Report Best Practices

**Good report (enables session continuity):**
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

- **Read task comments first** — they contain previous work reports for session continuity
- **Check upstream dependencies** — read `dependsOn` tasks and their comments for interfaces/APIs
- **Read the originating proposal** — understand design rationale and task DAG
- **Use `commentCount`** — skip fetching comments on entities with count 0
- Report progress frequently — include file paths, commits, and PRs
- Write detailed submit summaries — Admin needs them to verify
- If blocked, add a comment and consider releasing the task
- One task at a time: finish or release before claiming another
- Use meaningful sub-agent names — they become Chorus session names

---

## When to Release a Task

Release if:
- You can't complete it (missing knowledge, blocked)
- A higher-priority task needs attention
- You won't finish in a reasonable timeframe

```
chorus_release_task({ taskUuid: "<task-uuid>" })
chorus_add_comment({ targetType: "task", targetUuid: "<task-uuid>", content: "Releasing: reason..." })
```

---

## Next

- After submitting for verification, an Admin reviews using `/review`
- For platform overview and shared tools, see `/chorus`
