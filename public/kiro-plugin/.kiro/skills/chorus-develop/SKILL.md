---
name: chorus-develop
description: Chorus Development workflow — claim tasks, report work, manage sessions, and run parallel task execution with Kiro subagents.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.16.0"
  category: project-management
  mcp_server: chorus
---

# Chorus Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, submitting for verification, and managing sessions for subagent observability.

---

## Overview

Developer Agents take Tasks created by PM Agents (via `/chorus-proposal`) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin /chorus-review
```

For multi-agent parallel execution, the `chorus` main agent spawns Kiro subagents (up to 4 concurrent) with full session-based observability.

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

**Session (subagents only — main agent skips these):**

| Tool | Purpose |
|------|---------|
| `chorus_session_checkin_task` | Checkin to a task before starting work |
| `chorus_session_checkout_task` | Checkout from a task when work is done |

Subagents: always pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution.
Main agent: call these tools without `sessionUuid` — no session needed.

**Shared tools** (checkin, query, comment, search, notifications): see the `chorus` steering doc.

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts. (On the `chorus` main agent, the `agentSpawn` hook has already run checkin into your startup context.)

### Step 1.5: Get Your Session (Subagents Only)

**Skip if you are the main agent.**

If you are a **subagent** picking up a task, create/attach a session for observability. When the main agent spawns you it passes your `sessionUuid` in the prompt — keep it for all task operations. If you were spawned without one, create a session for yourself and use its uuid.

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
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "documents" })
   ```
   (`chorus_get_proposal` defaults to `section: "basic"` — just metadata + a draft index. Pass `section: "documents"` for the design docs, or `section: "full"` for docs + task drafts.)

5. **Read project documents** (PRD, tech design, ADR):
   ```
   chorus_get_documents({ projectUuid: "<project-uuid>" })
   ```

> **Document update flow (OpenSpec mode):** if the originating proposal `description` contains a line `OpenSpec change slug: <slug>`, the project's PRD / tech_design / spec Documents are **mirrors** of files under `openspec/changes/<slug>/`. To update such a Document (e.g. clarify an AC, fix a spec scenario before resubmitting), load the `/chorus-openspec-aware` skill and follow §3.8: edit the local `.md` file first, then mirror through the `chorus-api.sh` wrapper with `json_encode_file` and `chorus_check_response`.
>
> **⛔ Do not** call `chorus_pm_update_document` directly from the MCP harness with a hand-typed `content` field in OpenSpec mode. The local file is the source of truth; agent-typed content drifts and burns tokens (`/chorus-openspec-aware` §2 Rule 1).
>
> When the LAST task of an OpenSpec idea is verified, run the archive flow (`/chorus-openspec-aware` §3.9) — `openspec archive <slug> --yes`, then mirror each emitted `openspec/specs/<capability>/spec.md` back via §3.8.
>
> In the no-OpenSpec fallback (no slug line, or no `openspec` CLI), edit the Document content directly via the existing MCP tool with no wrapper, no local file step.

### Step 5: Start Working

**Subagent**: checkin to the task first:
```
chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
```

Then mark as in-progress:
```
# Subagent:
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

**Subagents** — checkout first:
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

> **Review Subagent:** After `chorus_submit_for_verify`, the `chorus` main agent's `postToolUse` hook injects a nudge instructing you to spawn the `chorus-task-reviewer` — an independent, read-only review subagent (`tools: ["read", "@chorus"]`). You MUST spawn it yourself (it is NOT auto-launched). **Run it in the foreground** — wait for the VERDICT before proceeding. The reviewer posts a VERDICT comment on the task.

After the reviewer completes, read its VERDICT:
```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```
Find the most recent comment containing `VERDICT:` and act on it:

- **VERDICT: PASS** — All AC verified, no issues. Proceed to admin verification.
- **VERDICT: PASS WITH NOTES** — All AC verified, minor notes. Proceed to admin verification (notes are non-blocking).
- **VERDICT: FAIL** — BLOCKERs found. Do NOT verify. Fix the BLOCKERs listed in the reviewer's comment, then resubmit.

If no new `VERDICT:` comment appears after the reviewer returns, it exhausted its turn budget before posting. Respawn it ONCE with a concise-budget hint in the prompt: *"Stay within turn budget. Skip deep verification. Fetch task/proposal/comments, demand the developer's run evidence, and post your VERDICT comment within the first 12 turns."* If the second attempt still produces no VERDICT, review manually using the checklist and proceed.

> **Final code-review gateway (after the Idea's LAST task is verified):** when the task you just verified is the **last** task of its idea-rooted proposal, the feature is about to ship — the `postToolUse` hook injects a reminder to spawn the `chorus-code-reviewer` subagent. Spawn it yourself in the **foreground**, passing the `ideaUuid` + round number; it reviews the Idea's **aggregate** code change across all its tasks (cross-task integration, architecture, security, regression, feature-level coverage) and posts one `VERDICT` comment on the **idea**. `PASS` / `PASS WITH NOTES` → ship; `FAIL` → fix via `/chorus-quick-dev` (`chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it — do NOT reopen the verified tasks). Group related small BLOCKERs by default; split only materially large or independently testable fixes. Require AC self-check, independent task review, and admin verification for every fix task. Re-run aggregate review only after every fix is successfully `done`; a failed or cancelled fix stops the loop and escalates. Advisory/behavioral, like the other reviewers. Run it **before** any idea-completion report.

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

### Step 11: Idea Completion Report (advisory)

If the task you just self-verified was the LAST one of its Idea (every Task across every approved Proposal is now `done`/`closed`) and you have `document:write`, offer to call `chorus_create_report` (ask the user first with a clear interactive question). The `content` parameter's description carries the section template. Skip on decline.

---

## Session (Subagents Only)

The `chorus` main agent's lifecycle hooks automate the main agent's own session (checkin on `agentSpawn`, heartbeat/checkout on `stop`). A **subagent** that picks up a task does three things manually:

1. `chorus_session_checkin_task({ sessionUuid, taskUuid })` — before starting work
2. `chorus_session_checkout_task({ sessionUuid, taskUuid })` — when done
3. Pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution

**Main agent**: no session needed — call tools without `sessionUuid`.

---

## Kiro Subagents Integration (parallel execution)

When you (the `chorus` main agent) want to run multiple tasks in parallel, spawn Kiro subagents — up to 4 concurrent. Chorus provides full work observability across them.

### Two-Layer Architecture

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Kiro subagents | Spawning subagents, task dispatch |
| **Work Tracking** | Chorus | Task lifecycle, session observability, activity stream |

### Orchestrator (main agent) Workflow

```
# 1. Check in and plan
chorus_checkin()
chorus_list_tasks({ projectUuid: "<project-uuid>" })

# 2. Spawn a subagent per ready task (up to 4 concurrent). You have `subagent`
#    in your tools, so you can dispatch by name/description. Give each subagent:
#      - its Chorus task UUID + the project UUID
#      - a fresh sessionUuid to pass to its task operations (for attribution)
#      - the instruction to follow the /chorus-develop workflow
```

**What the orchestrator prompt for each subagent needs:**
- Task UUID(s) + Project UUID
- A sessionUuid for that subagent to use on `chorus_update_task` / `chorus_report_work`
- The instruction: follow `/chorus-develop` (claim -> in_progress -> develop -> report -> self-check AC -> checkout -> submit_for_verify)

### Subagent Workflow

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

# 6. Report back to the orchestrator (Kiro subagents return a summary to the spawner)
```

### Handling Task Dependencies (DAG)

> **Server-side enforcement**: `chorus_update_task(status: "in_progress")` rejects if any `dependsOn` task is not `done` or `closed`.

**Wave-based execution (recommended):**
1. `chorus_get_unblocked_tasks` — find ready tasks
2. Spawn subagents for Wave 1 (max 4 concurrent)
3. Wait for `to_verify`, then **verify each task** (`chorus_admin_verify_task` → `done`)
4. `chorus_get_unblocked_tasks` — find newly unblocked tasks (Wave 2)
5. Repeat until all tasks done

> **Critical:** `to_verify` does NOT resolve dependencies — only `done` or `closed` does. The orchestrator must verify tasks between waves.

### MCP Access for Subagents

The `chorus` MCP server is pulled in via `includeMcpJson: true` on the `chorus` main agent. A dispatched subagent needs the `@chorus` server in its own tool scope too (either it is a `chorus*` agent that includes the server, or you pass the MCP config it needs). Ensure `CHORUS_URL` + `CHORUS_API_KEY` are exported in the environment Kiro was launched from.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Subagent can't access Chorus MCP tools | Verify the subagent's tools include `@chorus`, the API key has developer role, and `CHORUS_URL`/`CHORUS_API_KEY` are exported |
| UI doesn't show active workers | Subagent forgot `chorus_session_checkin_task`. Check: `chorus_get_session` |
| Session disappears from Settings | No activity for 1h (default lists hide stale sessions). The session row still exists — reachable via MCP `chorus_list_sessions` / `chorus_get_session`. Send a heartbeat (or any session-touching tool) to make it visible again |
| Task stuck in wrong status | Use `chorus_update_task` to reset, or reopen via admin |

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
- One task at a time (per subagent): finish or release before claiming another
- Use meaningful subagent names — they become Chorus session names

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

- After submitting for verification, an Admin reviews using `/chorus-review`
- **Human "Start Development" wake:** a `start_development` wake (the human clicked **Start Development** on the idea-detail panel) means: claim and execute ALL remaining tasks of the idea's approved proposal in dependency order — loop this workflow until no claimable task remains, leaving `to_verify` and other-session tasks untouched.
- **Human "Yolo" wake:** a `yolo_requested` wake (the human clicked **Yolo** on the idea-detail panel) means: drive the WHOLE idea to done via the `/chorus-yolo` skill (the full-auto AI-DLC pipeline), not just the execute stage — read the idea's current state and resume from whatever phase it is in. Unlike `start_development` it is stage-adaptive, and it must never merge or push a PR without explicit human approval.
- For platform overview and shared tools, see the `chorus` steering doc.
