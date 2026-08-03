---
name: develop
description: Chorus Development workflow — claim tasks, report work, and spawn sub-agent workers for parallel execution. (Codex port)
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.15.0"
  category: project-management
  mcp_server: chorus
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, and submitting for verification.

---

## Overview

Developer Agents take Tasks created by PM Agents (via `/proposal`) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin /review
```

For multi-agent parallel execution, the main agent uses Codex's `spawn_agent` tool to launch worker sub-agents.

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
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "documents" })
   ```
   (`chorus_get_proposal` defaults to `section: "basic"` — just metadata + a draft index. Pass `section: "documents"` for the design docs, or `section: "full"` for docs + task drafts.)

5. **Read project documents** (PRD, tech design, ADR):
   ```
   chorus_get_documents({ projectUuid: "<project-uuid>" })
   ```

> **Document update flow (OpenSpec mode):** if the originating proposal `description` contains a line `OpenSpec change slug: <slug>`, the project's PRD / tech_design / spec Documents are **mirrors** of files under `openspec/changes/<slug>/`. To update such a Document (e.g. clarify an AC, fix a spec scenario before resubmitting), load the `openspec-aware` skill at `~/.codex/skills/openspec-aware/SKILL.md` and follow §3.8: edit the local `.md` file first, then mirror through the `chorus-mcp-call.sh` wrapper with `json_encode_file` and `chorus_check_response`.
>
> **⛔ Do not** call `chorus_pm_update_document` directly from Codex's MCP harness with a hand-typed `content` field in OpenSpec mode. The local file is the source of truth; agent-typed content drifts and burns tokens (`openspec-aware` §2 Rule 1).
>
> When the LAST task of an OpenSpec idea is verified, the plugin's PostToolUse hook injects an archive reminder (`openspec-aware` §3.9) — run `openspec archive <slug> --yes`, then mirror each emitted `openspec/specs/<capability>/spec.md` back via §3.8.
>
> In the no-OpenSpec fallback (no slug line, or no `openspec` CLI), edit the Document content directly via the existing MCP tool with no wrapper, no local file step.

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

Submit:
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

> **Final code-review gateway (after the Idea's LAST task is verified):** when the task you just verified is the **last** task of its idea-rooted proposal, the feature is about to ship — the PostToolUse hook injects a reminder to run the ship-time code-review gateway. Spawn it the same way, mounting `chorus:chorus-code-reviewer` and passing the `ideaUuid` + round number; it reviews the Idea's **aggregate** code change (cross-task integration, architecture, security, regression, feature-level coverage) and posts one `VERDICT:` comment on the **idea**. `PASS` / `PASS WITH NOTES` → ship; `FAIL` → fix via the **quick-dev** workflow (`$quick-dev`): `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** so the fix tasks attach to it (do not reopen old tasks). Group related small BLOCKERs into one cohesive task by default; split only materially large or independently testable fixes. Each fix task must self-check its acceptance criteria and pass independent task review plus admin verification. Re-run the gateway only after every fix task is successfully `done`; if there is a failed or cancelled fix task, stop and escalate instead. Advisory/behavioral, same as the other reviewers. Run it **before** any idea-completion report.

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

### Step 11: Idea Completion Report (advisory)

If the task you just self-verified was the LAST one of its Idea (every Task across every approved Proposal is now `done`/`closed`) and you have `document:write`, prompt the user and call `chorus_create_report` on accept. The `content` parameter's description carries the section template. Skip on decline — the PostToolUse hook will remind on the next run.

---

## Multi-Agent Workers (Codex `spawn_agent`)

When running multiple sub-agents in parallel on a proposal's tasks, the main agent plays Team Lead.

### Two-Layer Architecture

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Codex `spawn_agent` | Spawning sub-agents, passing task assignments |
| **Work Tracking** | Chorus MCP | Task lifecycle and work reports |

### Team Lead Workflow

```
# 1. Check in and plan
chorus_checkin()
chorus_list_tasks({ projectUuid: "<project-uuid>" })
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

# 2. Spawn workers and pass task UUIDs in the message
spawn_agent(
  agent_type="worker",
  message='''You are a Chorus developer worker. Follow the $develop skill.
Your task(s): <task-uuid-1>, <task-uuid-2>
Project UUID: <project-uuid>

Procedure: for each task — claim → mark in_progress → implement → report work → self-check AC → submit for verification.''',
)
```

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
| Worker can't access Chorus MCP tools | Verify MCP is configured and `CHORUS_API_KEY` has `task: ["write"]` permission |
| Task stuck in wrong status | Use `chorus_update_task` to reset status manually |

---

## Work Report Best Practices

**Good report:**
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

- **Read task comments first** — they contain previous work reports and decisions
- **Check upstream dependencies** — read `dependsOn` tasks and their comments for interfaces/APIs
- **Read the originating proposal** — understand design rationale and task DAG
- **Use `commentCount`** — skip fetching comments on entities with count 0
- Report progress frequently — include file paths, commits, and PRs
- Write detailed submit summaries — Admin needs them to verify
- If blocked, add a comment and consider releasing the task
- One task at a time: finish or release before claiming another
- Use meaningful sub-agent names so parallel work is easy to follow

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
- **Human "Yolo" wake:** a `yolo_requested` wake (the human clicked **Yolo** on the idea-detail panel) means: drive the WHOLE idea to done via the yolo skill (the full-auto AI-DLC pipeline), not just the execute stage — read the idea's current state and resume from whatever phase it is in. It is stage-adaptive, and it must never merge or push a PR without explicit human approval.
- For platform overview and shared tools, see `/chorus`
