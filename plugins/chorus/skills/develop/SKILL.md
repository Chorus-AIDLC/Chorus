---
name: develop
description: Chorus Development workflow — claim tasks, report work, and spawn sub-agent workers for parallel execution. (Codex port)
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.7.5"
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

For multi-agent parallel execution, the main agent uses Codex's `spawn_agent` tool to launch worker sub-agents. Sessions are optional in the Codex port — multi-agent observability requires the main agent to create sessions manually and pass `sessionUuid` to workers.

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

**Session (optional, main agent manages):**

| Tool | Purpose |
|------|---------|
| `chorus_session_checkin_task` | Checkin to a task before starting work |
| `chorus_session_checkout_task` | Checkout from a task when work is done |

Main agent (when coordinating workers for observability): call `chorus_create_session` before spawning workers, pass the returned `sessionUuid` to the worker via `spawn_agent` message, and call `chorus_session_checkout_task` + `chorus_close_session` after the worker finishes.
Workers: receive `sessionUuid` in their initial prompt and pass it to `chorus_update_task` and `chorus_report_work` for attribution.
No session needed: everything still works — task status, reports, comments — you just lose per-worker attribution in the UI.

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts.

### Step 1.5: Get Your Session (Codex port: main agent explicit)

**Codex port does not auto-create sessions.** Two scenarios:

- **Single-agent work (main agent)**: skip session entirely. Call task tools without `sessionUuid`.
- **Multi-agent work (worker spawned via `spawn_agent`)**: the main agent should have created a session and passed `sessionUuid` in your initial prompt. Use it for every `chorus_update_task`, `chorus_report_work`, `chorus_session_checkin_task`, `chorus_session_checkout_task` call. If the main agent forgot to pass one and you still need observability, you MAY call `chorus_create_session` yourself — but coordinate with the main agent to avoid duplicates.

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

**With session (optional)**: checkin to the task first, then mark in-progress:
```
chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress", sessionUuid: "<session-uuid>" })
```

**Without session (single-agent / main agent)**:
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

> **Review Agent:** After `chorus_submit_for_verify`, the Chorus plugin's PostToolUse hook injects context instructing you to spawn the `chorus-task-reviewer` sub-agent. You MUST spawn it yourself (it is NOT auto-launched). Spawn it by mounting this plugin's `chorus-task-reviewer` skill into a default sub-agent:
>
> ```
> spawn_agent(
>   agent_type="default",
>   items=[
>     { type: "skill", name: "Chorus Task Reviewer", path: "chorus:chorus-task-reviewer" },
>     { type: "text",  text: "Review Chorus task <task-uuid>. Post VERDICT comment." }
>   ]
> )
> wait_agent([reviewer_id]); close_agent(reviewer_id)
> ```
>
> Why not `agent_type="chorus-task-reviewer"`? Codex 0.125 only has three built-in roles (default / explorer / worker); custom review personas are loaded by mounting the skill. The reviewer posts a `VERDICT:` comment on the task.

After the reviewer completes, read its VERDICT:
```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```
Find the most recent comment containing `VERDICT:` and act on it:

- **VERDICT: PASS** — All AC verified, no issues. Proceed to admin verification.
- **VERDICT: PASS WITH NOTES** — All AC verified, minor notes. Proceed to admin verification (notes are non-blocking).
- **VERDICT: FAIL** — BLOCKERs found. Do NOT verify. Fix the BLOCKERs listed in the reviewer's comment, then resubmit.

If no new `VERDICT:` comment appears after the reviewer returns, it exhausted its `maxTurns` budget before posting. Respawn it ONCE with a concise-budget hint in the prompt: *"Stay within turn budget. Skip deep verification. Fetch task/proposal/comments, run only the core tests, and post your VERDICT comment within the first 12 turns."* If the second attempt still produces no VERDICT, review manually using the checklist and proceed.

### Step 9: Handle Review Feedback

If the reviewer returns **FAIL**, or the task is reopened after verification:

**All acceptance criteria are reset to pending** when a task is reopened.

1. Check feedback:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
2. Fix every BLOCKER listed in the reviewer's FAIL comment.
3. Checkin again, fix issues, report fixes, resubmit.

### Step 10: Task Complete

Once Admin verifies (status: `done`), move to the next available task (back to Step 2).

---

## Session (Optional, Codex Port)

The Codex port is **intentionally stateless** — no hook auto-creates, heartbeats, or closes Chorus sessions (Codex has no `SubagentStart`/`SubagentStop` event). Treat `sessionUuid` as optional per-worker observability, not a requirement:

- **Single-agent developer work**: skip session tools entirely. `chorus_update_task` / `chorus_report_work` / `chorus_submit_for_verify` all work without a `sessionUuid`.
- **Team Lead orchestrating workers via `spawn_agent`**: manually call `chorus_create_session` before spawning, pass `sessionUuid` into each worker's initial message, and `chorus_close_session` after `wait_agent` returns. See the Multi-Agent Workers section below.

---

## Multi-Agent Workers (Codex `spawn_agent`)

When running multiple sub-agents in parallel on a proposal's tasks, the main agent plays Team Lead. The Codex port does **not** auto-manage sessions — the Team Lead is responsible for session lifecycle if per-worker observability is needed.

### Two-Layer Architecture

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Codex `spawn_agent` | Spawning sub-agents, passing task assignments |
| **Work Tracking** | Chorus MCP | Task lifecycle, work reports, (optional) session observability |

### Team Lead Workflow (with sessions)

```
# 1. Check in and plan
chorus_checkin()
chorus_list_tasks({ projectUuid: "<project-uuid>" })
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

# 2. For each worker you intend to spawn, create a Chorus session
session_a = chorus_create_session({ name: "frontend-worker", roles: ["developer_agent"] })
session_b = chorus_create_session({ name: "backend-worker", roles: ["developer_agent"] })

# 3. Spawn workers, pass sessionUuid + taskUuid(s) in the message
spawn_agent(
  agent_type="worker",
  message=f'''You are a Chorus developer worker. Follow the $develop skill.

Your sessionUuid: {session_a.uuid}
Your task(s): <task-uuid-1>, <task-uuid-2>
Project UUID: <project-uuid>

Procedure: for each task — chorus_session_checkin_task → chorus_update_task in_progress → implement → chorus_report_work → self-check AC → chorus_session_checkout_task → chorus_submit_for_verify. Report completion in your final message so the main agent can close your session.''',
)
```

### Team Lead Workflow (without sessions — simpler)

If per-worker observability is not required, skip sessions entirely:

```
spawn_agent(
  agent_type="worker",
  message='''Follow $develop skill. Your task: <task-uuid>. Do NOT call chorus_create_session or chorus_session_*. Just claim/update/report/submit.''',
)
```

Task status, work reports, comments, AC self-checks all still function — you only lose "which worker did what" attribution in the UI.

### Session Cleanup (Team Lead responsibility)

Because Codex has no `SubagentStop` event, the Team Lead must close sessions after workers finish:

```
# After worker_a's spawn_agent returns:
chorus_session_checkout_task({ sessionUuid: session_a.uuid, taskUuid: "..." })   # if worker forgot
chorus_close_session({ sessionUuid: session_a.uuid })
```

Alternatively, rely on Chorus backend session TTL to auto-expire idle sessions. This is acceptable for most cases.

### Wave-Based Execution

> **Server-side enforcement**: `chorus_update_task(status: "in_progress")` rejects if any `dependsOn` task is not `done` or `closed`.

1. `chorus_get_unblocked_tasks` — find ready tasks
2. Spawn workers for Wave 1
3. After each worker returns, verify its task (`chorus_admin_verify_task` → `done`)
4. `chorus_get_unblocked_tasks` again — find newly unblocked tasks (Wave 2)
5. Repeat until all tasks done

> **Critical:** `to_verify` does NOT resolve dependencies — only `done` or `closed` does. The Team Lead must verify tasks between waves.

### Multiple Tasks Per Worker

A single worker can work on multiple tasks sequentially — write them in its `spawn_agent` message in dependency order, and have the worker loop over them.

### MCP Access for Workers

Sub-agents spawned via `spawn_agent` inherit the parent's MCP configuration. Ensure the `chorus` MCP server is declared in `~/.codex/config.toml` or the repo `.codex/config.toml` with `CHORUS_URL` / `CHORUS_API_KEY` set.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Worker can't access Chorus MCP tools | Verify MCP is configured and `CHORUS_API_KEY` has `developer_agent` role |
| UI doesn't show active worker | Worker forgot `chorus_session_checkin_task`, or main agent didn't create a session. Sessions are optional — it's fine to not have one |
| Session shows "inactive" (yellow) | No heartbeat — backend session TTL will clean it up, or call `chorus_close_session` explicitly |
| Task stuck in wrong status | Use `chorus_update_task` to reset status manually |
| Duplicate sessions | Main agent created session AND worker also called `chorus_create_session`. Pick one owner (prefer main agent) |
| Worker didn't close its session | Main agent calls `chorus_close_session({sessionUuid})` after `spawn_agent` returns |

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
