---
name: develop
description: Chorus Development workflow — claim tasks, report work, manage sessions, and run wave-based execution on OpenClaw.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.10.0"
  category: project-management
  mcp_server: chorus
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, submitting for verification, and managing sessions for sub-agent observability.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_claim_task`). Bare names are used below for readability — prepend `chorus__` when invoking. See `/chorus` for the full rule.

---

## Overview

Developer Agents take Tasks created by PM Agents (via `/proposal`) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> reviewer --> Admin /review
```

For multi-task execution, OpenClaw runs **sequential waves** (the main agent works tasks in dependency order) — see [Wave-Based Execution](#wave-based-execution-on-openclaw) below.

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
| `chorus_create_session` | Create a session for a sub-agent (manual on OpenClaw — see below) |
| `chorus_session_checkin_task` | Checkin to a task before starting work |
| `chorus_session_checkout_task` | Checkout from a task when work is done |
| `chorus_close_session` | Close the session when the sub-agent finishes |

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

### Step 1.5: Manage Your Session (Sub-Agents Only)

**Skip if you are the main agent.**

> **OpenClaw difference:** the Claude Code plugin auto-creates and auto-injects a sub-agent's session via a SubagentStart hook. **OpenClaw does not run that hook.** Session handling is **manual**: if you are a sub-agent and the host did not hand you a `sessionUuid`, create one yourself once at the start, keep it for all task operations, and close it when you finish.

```
# Create your own session (only if no sessionUuid was provided to you)
chorus_create_session({ name: "<descriptive-worker-name>" })
# -> keep the returned sessionUuid for every task call below
```

If the OpenClaw host *did* inject a `sessionUuid` into your prompt (some hosts forward parent context), reuse it instead of creating a new one. When in doubt, create one — duplicate idle sessions are harmless and auto-go-inactive after 1h.

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

> **Document update flow (OpenSpec mode):** if the originating proposal `description` contains a line `OpenSpec change slug: <slug>`, the project's PRD / tech_design / spec Documents are **mirrors** of files under `openspec/changes/<slug>/`. To update such a Document (e.g. clarify an AC, fix a spec scenario before resubmitting), load the `openspec-aware` skill and follow §3.8: edit the local `.md` file first, then mirror through the `chorus-api.sh` wrapper with `json_encode_file` and `chorus_check_response`. (OpenClaw runs `openspec-aware`'s detection inline — there is no SessionStart hook; see `openspec-aware` §1.)
>
> **⛔ Do not** call `chorus_pm_update_document` directly from the MCP harness with a hand-typed `content` field in OpenSpec mode. The local file is the source of truth; agent-typed content drifts and burns tokens (`openspec-aware` §2 Rule 1).
>
> When the LAST task of an OpenSpec idea is verified, run the archive flow yourself (`openspec-aware` §3.9): run `openspec archive <slug> --yes`, then mirror each emitted `openspec/specs/<capability>/spec.md` back via §3.8. **OpenClaw has no PostToolUse hook to remind you** — check after each verify whether the just-verified task was the last of its idea, and if so trigger the archive flow yourself.
>
> In the no-OpenSpec fallback (no slug line, or no `openspec` CLI), edit the Document content directly via the existing MCP tool with no wrapper, no local file step.

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

### Step 8.5: Run the Task Reviewer (inline — no hook on OpenClaw)

> **OpenClaw difference:** the Claude Code plugin relies on a PostToolUse hook to inject a "spawn the reviewer" reminder after `chorus_submit_for_verify`. **OpenClaw has no such hook.** Run the reviewer step **inline**, right here, immediately after submitting. Do not wait for an injected reminder.

Obtain an independent VERDICT before the task is verified:

1. **Preferred — spawn a reviewer sub-agent.** Use the OpenClaw `sessions_spawn` tool to spawn a sub-agent whose `task` tells it to **invoke the `/task-reviewer` skill** (bundled with this plugin) against the task, then wait for it (poll the `subagents` tool or use `sessions_yield` — do NOT detach; you need the VERDICT before proceeding). The sub-agent inherits the plugin skills, so `/task-reviewer` is available to it; that skill is read-only (read-only bash for tests/build allowed) and posts a `VERDICT:` comment on the task. Example task prompt:
   > `Run the /task-reviewer skill to verify taskUuid <uuid>. Read the task, its AC, the proposal documents, and the code; run the project's tests; verify each AC independently; post your VERDICT comment on the task when done.`

2. **Fallback — review it yourself.** If `sessions_spawn` is unavailable on your host (spawning disabled by policy), perform the review yourself as a **focused, read-only pass** following the `/task-reviewer` skill's procedure: read `chorus_get_task`, `chorus_get_comments`, the originating proposal and its documents; read the code that implements each AC (do not trust the developer summary); run the project's test/build commands; verify each acceptance criterion independently. Then record the result yourself via `chorus_add_comment` ending with a `VERDICT:` line (PASS / PASS WITH NOTES / FAIL). Do NOT modify project files during this pass — it is review-only (read-only bash for tests/build is fine). Use the same BLOCKER vs NOTE classification the `/task-reviewer` skill defines.

3. **Read the VERDICT and act:**
   ```
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
   Find the most recent comment containing `VERDICT:`:
   - **VERDICT: PASS** — All AC verified, no issues. Proceed to admin verification.
   - **VERDICT: PASS WITH NOTES** — All AC verified, minor notes. Proceed to admin verification (notes are non-blocking).
   - **VERDICT: FAIL** — BLOCKERs found. Do NOT verify. Fix the BLOCKERs listed in the reviewer's comment, then resubmit (Step 9).

If you spawned a sub-agent and no new `VERDICT:` comment appears after it returns, it exhausted its turn budget. Respawn it ONCE with a concise-budget hint: *"Stay within turn budget. Skip deep verification. Fetch task/proposal/comments, run only the core tests, and post your VERDICT within the first 12 turns."* If the second attempt still produces no VERDICT, fall back to reviewing manually (Step 8.5 fallback) and post the VERDICT yourself.

### Step 9: Handle Review Feedback

If the reviewer returns **FAIL**, or the task is reopened after verification:

**All acceptance criteria are reset to pending** when a task is reopened.

1. Check feedback:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
2. Fix every BLOCKER listed in the reviewer's FAIL comment.
3. Checkin again (sub-agent), fix issues, report fixes, resubmit, and re-run the reviewer (Step 8.5).

### Step 10: Task Complete

Once Admin verifies (status: `done`), move to the next available task (back to Step 2).

### Step 11: Idea Completion Report (advisory)

If the task you just self-verified was the LAST one of its Idea (every Task across every approved Proposal is now `done`/`closed`) and you have `document:write`, offer to call `chorus_create_report`. On OpenClaw, ask the user as a plain-text prompt (e.g. "This was the last task of the idea. Want me to write a completion report? Reply yes/no.") — there is no `AskUserQuestion` primitive. The tool description carries the section template. Skip on decline.

---

## Session (Sub-Agents Only)

> **OpenClaw difference:** session lifecycle is **manual** on OpenClaw. The Claude Code plugin automates creation, heartbeat, and cleanup via hooks; OpenClaw does not run those hooks. A sub-agent therefore manages its own session:

1. `chorus_create_session({ name })` — once at the start, unless the host already gave you a `sessionUuid`
2. `chorus_session_checkin_task({ sessionUuid, taskUuid })` — before starting work on each task
3. Pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution
4. `chorus_session_checkout_task({ sessionUuid, taskUuid })` — when done with each task
5. `chorus_close_session({ sessionUuid })` — when the sub-agent finishes (no hook closes it for you)

To keep a long-running session visible/active, send `chorus_session_heartbeat({ sessionUuid })` periodically (any session-touching tool also refreshes it).

**Main agent / Team Lead**: no session needed — call tools without `sessionUuid`.

---

## Wave-Based Execution on OpenClaw

> **OpenClaw difference:** OpenClaw has **no Agent Teams / `TeamCreate` primitive**. The Claude Code plugin can spawn a parallel team per wave; on OpenClaw you (the main agent) execute tasks **sequentially** in dependency order. This is slower than parallel teams but completes the same pipeline.

### Sequential wave loop

```
loop:
  # 1. Find ready tasks (all dependencies done/closed)
  unblocked = chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

  if no unblocked tasks and all tasks done/closed:
    break  # All complete

  if no unblocked tasks but some remain (not done):
    break with escalation note  # stuck — likely a failed review blocking the DAG

  # 2. Work each unblocked task yourself, in order:
  for each task in unblocked:
    chorus_claim_task({ taskUuid: task.uuid })
    chorus_update_task({ taskUuid: task.uuid, status: "in_progress" })
    # ... read context, implement, run tests (Steps 4-7) ...
    chorus_report_work({ taskUuid: task.uuid, report: "...", status: "to_verify" })
    chorus_report_criteria_self_check({ taskUuid: task.uuid, criteria: [...] })
    chorus_submit_for_verify({ taskUuid: task.uuid, summary: "..." })
    # Step 8.5: run the task-reviewer inline; act on its VERDICT
    # If you have task:admin, verify the task to "done" (this unblocks dependents)

  # 3. Loop — chorus_get_unblocked_tasks now returns the next wave
```

> **Critical:** `to_verify` does NOT resolve dependencies — only `done` or `closed` does. A task must be **verified to `done`** (by an Admin, or by you if you hold `task:admin`) before its dependents become unblocked. If you lack `task:admin`, submit each task for verify and ask the project's admin to verify between waves, then re-run `chorus_get_unblocked_tasks`.

> **Claude-Code-only optimization (degrades to sequential here):** under the Claude Code plugin, each wave can be dispatched in parallel via `TeamCreate` + per-task sub-agents. OpenClaw has no such primitive, so the loop above runs serially. Do NOT attempt to call `TeamCreate` on OpenClaw — it does not exist.

### Optional: sub-agent dispatch

If your OpenClaw host *does* support spawning worker sub-agents (not Agent Teams, just generic sub-agents), you may hand each a task. Because there is no SubagentStart hook, the worker prompt **must** include the manual session instructions explicitly:

```
Your Chorus task UUID: <task-uuid>
Project UUID: <project-uuid>

Session handling is MANUAL on OpenClaw:
1. chorus_create_session({ name: "<worker-name>" }) -> keep the sessionUuid
2. chorus_session_checkin_task({ sessionUuid, taskUuid })
3. chorus_update_task({ taskUuid, status: "in_progress", sessionUuid })
4. implement, then chorus_report_work({ ..., sessionUuid })
5. chorus_report_criteria_self_check({ taskUuid, criteria: [...] })
6. chorus_session_checkout_task({ sessionUuid, taskUuid })
7. chorus_submit_for_verify({ taskUuid, summary })
8. chorus_close_session({ sessionUuid })
```

The main agent still owns review + verification between waves.

### MCP Access for Sub-Agents

If you dispatch sub-agents, ensure they can reach the Chorus MCP server — the plugin config (and therefore the `chorus__*` tools) must be available in the sub-agent's environment, and the API key must carry the needed permissions.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Sub-agent can't access Chorus MCP tools | Verify the Chorus MCP server is registered/connected for the sub-agent and the API key has developer permissions |
| UI doesn't show active workers | Sub-agent forgot `chorus_session_checkin_task`, or never created a session. Check `chorus_get_session` / `chorus_list_sessions` |
| Session disappears from Settings | No activity for 1h (default lists hide stale sessions). The session row still exists — reachable via `chorus_list_sessions` / `chorus_get_session`. Send `chorus_session_heartbeat` (or any session-touching tool) to make it visible again |
| Task stuck in wrong status | Use `chorus_update_task` to reset, or have the worker re-checkin |
| Duplicate sessions | On OpenClaw the sub-agent creates its own session — if it created several, close extras via `chorus_close_session` or the Settings page |

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
- Always run the reviewer inline after submit (Step 8.5) — OpenClaw has no hook to remind you
- Sessions are manual on OpenClaw — create, checkin/checkout, and close your own session as a sub-agent
- If blocked, add a comment and consider releasing the task
- One task at a time: finish or release before claiming another

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
