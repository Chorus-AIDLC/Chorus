---
name: develop
description: Chorus Development workflow — claim tasks, report work, manage sessions, and run parallel workers with Hermes delegate_task.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.22.0"
  category: project-management
  mcp_server: chorus
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, submitting for verification, and managing sessions for worker observability.

---

## Overview

Developer Agents take Tasks created by PM Agents (via the proposal skill, `skill_view("chorus:proposal")`) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin review
```

For multi-agent parallel execution, the main agent runs Chorus workers as Hermes `delegate_task` children, with one Chorus session per worker for observability.

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

**Session (workers check in/out; the Team Lead creates and closes):**

| Tool | Purpose |
|------|---------|
| `chorus_create_session` | Team Lead: create one session per worker before delegating |
| `chorus_list_sessions` / `chorus_reopen_session` | Team Lead: reuse a closed session with the same worker name instead of creating a duplicate |
| `chorus_session_checkin_task` | Worker: checkin to a task before starting work |
| `chorus_session_checkout_task` | Worker: checkout from a task when work is done |
| `chorus_close_session` | Team Lead: close each worker session after `delegate_task` returns |

Workers: always pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution.
Main agent / Team Lead working a task itself: call these tools without `sessionUuid` — the main agent uses no session.

**Shared tools** (checkin, query, comment, search, notifications): see the chorus overview skill (`skill_view("chorus:chorus")`)

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Review your persona, current assignments, and pending work counts. In a Hermes session the Chorus Hermes plugin already ran this on the first turn (its `pre_llm_call` hook injects `## Checkin`, `## Spec Mode`, and `## Quick Reference`); call it again only if you need fresh data.

### Step 1.5: Get Your Session (Workers Only)

**Skip if you are the main agent or Team Lead.**

If you are a **worker** (a `delegate_task` child), Chorus sessions are NOT auto-created on Hermes. The Team Lead created one for you and put its UUID in your `context` (look for a `Chorus session UUID:` line). Keep it for all task operations. If your context has no session UUID, work without one — do not create a session yourself.

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

> **Document update flow (OpenSpec mode):** if the originating proposal `description` contains a line `OpenSpec change slug: <slug>`, the project's PRD / tech_design / spec Documents are **mirrors** of files under `openspec/changes/<slug>/`. To update such a Document (e.g. clarify an AC, fix a spec scenario before resubmitting), load the openspec-aware skill (`skill_view("chorus:openspec-aware")`) and follow §3.8: edit the local `.md` file first, then mirror it — prefer `chorus mcp call … --arg-file content=<file>` via `terminal` (see `skill_view("chorus:chorus-cli")`); when `chorus` is not on `PATH`, call the native MCP tool (`mcp__chorus__chorus_pm_update_document`) directly with `content` read from the file via `read_file`. Halt on any error.
>
> **⛔ Do not** call `chorus_pm_update_document` with a hand-typed `content` field in OpenSpec mode. The local file is the source of truth; agent-typed content drifts and burns tokens (`openspec-aware` §2 Rule 1).
>
> When the LAST task of an OpenSpec idea is verified, the Chorus Hermes plugin appends an archive reminder to the `chorus_admin_verify_task` result (`openspec-aware` §3.9) — run `openspec archive <slug> --yes`, then mirror each emitted `openspec/specs/<capability>/spec.md` back via §3.8.
>
> **Document update flow (spec-lite mode):** if the proposal `description` contains a line `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`, the project's PRD / tech_design / … Documents are **mirrors** of the files in that dated folder. To update such a Document, load the spec-lite skill (`skill_view("chorus:spec-lite")`) and follow its Mirror section: edit the local `<type>.md` file first, then mirror it via `chorus mcp call chorus_pm_update_document "{\"documentUuid\":\"<uuid>\"}" --arg-file content=<file>` (recorded `documentUuid` from the file's frontmatter); when `chorus` is not on `PATH`, call `mcp__chorus__chorus_pm_update_document` directly with `content` read from the file via `read_file`. Halt on error. Same **⛔ do-not-hand-type-`content`** rule as OpenSpec. The durable `.chorus/specs/<slug>/spec.md` is edited in place too but is **never mirrored** (git history is its record). No archive flow — spec-lite has no CLI/validate/archive; on delivery just set `spec.md` `status: done`.
>
> In the no-OpenSpec, no-spec-lite fallback (free-form: no locator line), edit the Document content directly via the existing MCP tool, with no local file step.

### Step 5: Start Working

**Worker**: checkin to the task first:
```
chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
```

Then mark as in-progress:
```
# Worker:
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

**Workers** — checkout first:
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

> **Review Agent:** After `chorus_submit_for_verify`, the Chorus Hermes plugin appends a reminder to the tool result telling you to run the `chorus-task-reviewer` — an independent, read-only reviewer. You MUST run it yourself (it is NOT auto-launched). Workers skip this: the Team Lead reviews after the worker batch returns. The reviewer runs as a `delegate_task` child under the read-only guard, so it cannot run `terminal`; build the evidence bundle first, then delegate. `delegate_task` blocks until the reviewer finishes. The verdict is the comment the reviewer posts on the task, not the call's return value.

**Build the evidence bundle** (parent, via `terminal`; `<base>` is the branch point, e.g. `main`):

```
mkdir -p /tmp/chorus-review/<task-uuid>
git diff <base>...HEAD > /tmp/chorus-review/<task-uuid>/diff.patch
git log --oneline <base>..HEAD > /tmp/chorus-review/<task-uuid>/log.txt
<project test/build command> > /tmp/chorus-review/<task-uuid>/tests.txt 2>&1
```

**Run the task reviewer:**

```
delegate_task(
  goal="[chorus-reviewer:task] Review Chorus task <task-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:task]\nFirst call skill_view(\"chorus:chorus-task-reviewer\") and follow it.\nTask UUID: <task-uuid>\nProject UUID: <project-uuid>\nMax review rounds: 3\nRepo: <abs repo path>\nEvidence: /tmp/chorus-review/<task-uuid>/diff.patch, /tmp/chorus-review/<task-uuid>/log.txt, /tmp/chorus-review/<task-uuid>/tests.txt",
)
```

The `[chorus-reviewer:task]` marker MUST be the first line of `context` (and should also be in `goal`) — the plugin uses it to put the child in read-only mode. The proposal and code reviewer examples are in the review skill (`skill_view("chorus:review")`, Review Strategy).

After the reviewer completes, read its VERDICT:
```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```
Find THIS round's `VERDICT:` comment — the one posted after your dispatch, not an older round's — and act on it:

- **VERDICT: PASS** — All AC verified, no issues. Proceed to admin verification.
- **VERDICT: PASS WITH NOTES** — All AC verified, minor notes. Proceed to admin verification (notes are non-blocking).
- **VERDICT: FAIL** — BLOCKERs found. Do NOT verify. Fix the BLOCKERs listed in the reviewer's comment, then resubmit.

If no new `VERDICT:` comment appears after the reviewer returns, check what it *did* post. A comment reporting that the round limit was reached, or any other explicit refusal to review, is a deliberate escalation to a human: STOP — do not respawn, do not self-review, do not post a VERDICT of your own. If it posted nothing at all, respawn it ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you review the task yourself as a read-only pass using the checklist and POST the VERDICT comment. **Absence is never a PASS.**

> **Final code-review gateway (after the Idea's LAST task is verified):** when the task you just verified is the **last** task of its idea-rooted proposal, the feature is about to ship — the Chorus Hermes plugin appends a reminder to the `chorus_admin_verify_task` result to run `chorus-code-reviewer` (gated by `CHORUS_ENABLE_CODE_REVIEWER`, default on). Run it yourself as a `delegate_task` child with the `[chorus-reviewer:code]` marker (full example in `skill_view("chorus:review")`), passing the `ideaUuid` + round number and an evidence bundle covering the whole feature (aggregate diff, log, and test output across all of the idea's tasks). It reviews the Idea's **aggregate** code change across all its tasks (cross-task integration, architecture, security, regression, feature-level coverage) and posts one `VERDICT` comment on the **idea**. `PASS` / `PASS WITH NOTES` → ship; `FAIL` → fix via the quick-dev skill (`skill_view("chorus:quick-dev")`): `chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it — do NOT reopen the verified tasks. Group related small BLOCKERs by default; split only materially large or independently testable fixes. Require AC self-check, independent task review, and admin verification for every fix task. Re-run aggregate review only after every fix is successfully `done`; a failed or cancelled fix stops the loop and escalates, bounded by `CHORUS_MAX_CODE_REVIEW_ROUNDS` (env, default 3; 0 = unlimited). Advisory/behavioral, like the other reviewers. Run it **before** any idea-completion report.

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

If the task you just self-verified was the LAST one of its Idea (every Task across every approved Proposal is now `done`/`closed`) and you have `document:write`, offer to call `chorus_create_report`. In an interactive session, ask the human in chat (yes/no). In a gateway (Chorus-woken) session or with no human in chat, post a `chorus_add_comment` on the Idea that @mentions the owner (`@[Name](user:<ownerUuid>)` from `chorus_checkin`) asking whether to write the report, then end the turn and act on the reply when woken. The call requires `title` (a short report title) plus `content`; `content`'s parameter description carries the three-section template (`## Summary` / `## Decisions` / `## Follow-ups`). Skip on decline — the plugin will remind on the next run.

---

## Session (Workers Only)

On Hermes, Chorus sessions for workers are **not** created automatically. The Team Lead owns the session lifecycle:

1. **Before delegating**, for each worker: `chorus_list_sessions()` and reopen a closed session with the same worker name (`chorus_reopen_session({ sessionUuid })`), or else `chorus_create_session({ name: "<worker-name>" })`.
2. **Pass the `sessionUuid`** in that worker's `context`.
3. **After `delegate_task` returns**, call `chorus_close_session({ sessionUuid })` for every worker session in the batch.

Workers only do 3 things with the session:

1. `chorus_session_checkin_task({ sessionUuid, taskUuid })` — before starting work
2. `chorus_session_checkout_task({ sessionUuid, taskUuid })` — when done, before `chorus_submit_for_verify`
3. Pass `sessionUuid` to `chorus_update_task` and `chorus_report_work` for attribution

Workers never call `chorus_create_session` or `chorus_close_session`.

**Main agent / Team Lead**: no session for itself — call tools without `sessionUuid`.

---

## Parallel Workers with `delegate_task`

Use Hermes `delegate_task` to run multiple Chorus workers in parallel; Chorus provides full work observability through the per-worker sessions.

Key semantics:

- **Batch form.** `delegate_task(tasks=[{"goal": "...", "context": "..."}, ...])` runs one child per entry in parallel. `delegate_task(goal="...", context="...")` runs a single child. The batch size is capped by `delegation.max_concurrent_children` in `~/.hermes/config.yaml`; if a wave has more ready tasks than that, split it into several consecutive calls.
- **Blocking.** The call BLOCKS until every child in the batch finishes, then returns each child's final summary. There is no handle to track and nothing to close on the Hermes side.
- **Isolated context.** Each child starts with a fresh context and knows nothing of the parent conversation. It inherits the parent's toolsets, including the Chorus MCP server. Put everything the worker needs in `context`: task UUID(s), project UUID, repo path, Chorus session UUID, the instruction to load this skill first, and any decision from the conversation that is not recorded in Chorus.

### Two-Layer Architecture

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Hermes `delegate_task` (single or `tasks=[...]` batch) | Running workers as isolated child agents and collecting their summaries |
| **Work Tracking** | Chorus | Task lifecycle, session observability, activity stream |

### Team Lead Workflow

```
# 1. Check in and plan
chorus_checkin()
chorus_list_tasks({ projectUuid: "<project-uuid>" })
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

# 2. One Chorus session per worker (reopen by name if one exists)
chorus_list_sessions()
s1 = chorus_create_session({ name: "worker-auth-api" })   # or chorus_reopen_session
s2 = chorus_create_session({ name: "worker-auth-ui" })

# 3. Delegate the whole wave in ONE batch call (split if above max_concurrent_children)
delegate_task(tasks=[
  { "goal": "Implement Chorus task <task-uuid-1> and submit it for verification.",
    "context": "<worker context, see template below, with task-uuid-1 and s1.uuid>" },
  { "goal": "Implement Chorus task <task-uuid-2> and submit it for verification.",
    "context": "<worker context, see template below, with task-uuid-2 and s2.uuid>" },
])
# Blocks until both workers finish; returns each worker's final summary.

# 4. Close every worker session from this batch
chorus_close_session({ sessionUuid: s1.uuid })
chorus_close_session({ sessionUuid: s2.uuid })

# 5. Review + verify each task (task reviewer, then chorus_admin_verify_task), then next wave
```

**What the worker context needs:**
- Task UUID(s) + Project UUID + absolute repo path
- The Chorus session UUID created for this worker
- The instruction to call `skill_view("chorus:develop")` first
- The worker loop (below) and the rule to stop after `chorus_submit_for_verify`
- Any conversation decisions the worker cannot fetch from Chorus

### Worker Context Template

```
You are a Chorus worker. Your job is one Chorus task; the Chorus server is the source of truth.

First call skill_view("chorus:develop") and follow its worker steps.

Chorus task UUID: <task-uuid>
Project UUID: <project-uuid>
Repo: <abs repo path>
Chorus session UUID: <session-uuid>

Worker loop (pass sessionUuid to every call that accepts it):
1. chorus_session_checkin_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
2. chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress", sessionUuid: "<session-uuid>" })
3. Gather context (task, comments, upstream tasks, proposal documents), then implement, test, commit.
4. chorus_report_work({ taskUuid: "<task-uuid>", report: "<files, commits, tests>", sessionUuid: "<session-uuid>" })
5. chorus_report_criteria_self_check for every acceptance criterion.
6. chorus_session_checkout_task({ sessionUuid: "<session-uuid>", taskUuid: "<task-uuid>" })
7. chorus_submit_for_verify({ taskUuid: "<task-uuid>", summary: "..." })

Rules:
- Do NOT call chorus_create_session or chorus_close_session; the Team Lead owns the session.
- Do NOT run the task reviewer and do NOT verify; the Team Lead does both after you return.
- Notes from the Team Lead: <decisions from the conversation, constraints, files to avoid>.
- Your final message is returned to the Team Lead: list files changed, commits, test results, and AC status.
```

### Worker Workflow

The worker reads `Chorus session UUID:` from its context and runs the loop:

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

# The worker's final message is returned to the Team Lead as its delegate_task summary.
# DO NOT call chorus_close_session — the Team Lead closes it after delegate_task returns.
```

### Handling Task Dependencies (DAG)

> **Server-side enforcement**: `chorus_update_task(status: "in_progress")` rejects if any `dependsOn` task is not `done` or `closed`.

**Wave-based execution (recommended):**
1. `chorus_get_unblocked_tasks` — find ready tasks
2. Create (or reopen) one Chorus session per ready task, then run the wave as one `delegate_task(tasks=[...])` batch (split into several calls above `delegation.max_concurrent_children`). The call returns when every worker has finished (each task at `to_verify`).
3. Close each worker session (`chorus_close_session`).
4. **Verify each task** — build its evidence bundle, run `chorus-task-reviewer` (Step 8), act on its VERDICT, then `chorus_admin_verify_task` → `done`.
5. `chorus_get_unblocked_tasks` — find newly unblocked tasks (Wave 2)
6. Repeat until all tasks done

> **Critical:** `to_verify` does NOT resolve dependencies — only `done` or `closed` does. The Team Lead must verify tasks between waves.

### Multiple Tasks Per Worker

A single worker can handle several tasks sequentially — one `delegate_task` child with an ordered list:

```
delegate_task(
  goal="Implement Chorus tasks <task-schema-uuid> then <task-api-uuid>, in order.",
  context="You are a Chorus worker.\nFirst call skill_view(\"chorus:develop\") and follow its worker steps.\nYour Chorus tasks (work in order):\n1. <task-schema-uuid>\n2. <task-api-uuid> (depends on #1)\nProject UUID: <project-uuid>\nRepo: <abs repo path>\nChorus session UUID: <session-uuid>\n\nFor EACH task: checkin -> in_progress -> work -> report -> checkout -> submit_for_verify",
)
```

Note that task #2 cannot move to `in_progress` until task #1 is `done`, which needs the Team Lead's verification. Only chain dependent tasks in one worker when the Team Lead verifies in between, or split them into separate waves.

### MCP Access for Workers

`delegate_task` children inherit the parent's toolsets, so they get the same `chorus` MCP server as the parent. If the parent has no Chorus tools, fix the MCP setup first: install the `chorus-mcp` package (loopback `http://localhost:8637/api/mcp`, header `Authorization: Bearer ${CHORUS_API_KEY}`), or for any other deployment run `chorus agents add --agents hermes` or set `mcp_servers.chorus.url` / `mcp_servers.chorus.headers.Authorization` with `hermes config set`. Credentials come from `CHORUS_URL` / `CHORUS_API_KEY` or `~/.hermes/.env`. Restart Hermes after configuration.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Worker can't access Chorus MCP tools | Verify the `chorus` MCP server is configured (`hermes mcp list`) and the API key has developer permissions (`task:write`) |
| UI doesn't show active workers | The worker skipped `chorus_session_checkin_task`, or the Team Lead did not pass a session UUID. Check: `chorus_get_session` |
| Session disappears from Settings | No activity for 1h (default lists hide stale sessions). The session row still exists — it's reachable via MCP `chorus_list_sessions` / `chorus_get_session`. Send a heartbeat (`chorus_session_heartbeat`) to make it visible again, or check whether the worker crashed |
| Task stuck in wrong status | Reopen the worker's session by name and delegate a new worker with the same task, or use `chorus_update_task` to reset |
| Duplicate sessions | Reuse by name (`chorus_list_sessions` + `chorus_reopen_session`) before creating; close extras with `chorus_close_session` or via the Settings page |
| Worker session left open | The Team Lead skipped the close step — call `chorus_close_session` for each worker session after `delegate_task` returns |
| Batch rejected or truncated | More entries than `delegation.max_concurrent_children` — split the wave into several `delegate_task` calls |
| Worker did the wrong thing / lacked context | The child has no parent context — put every UUID, path, and decision in `context` |

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
- Use meaningful worker names — they become Chorus session names

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

- After submitting for verification, an Admin reviews using the review skill (`skill_view("chorus:review")`)
- **Human "Start Development" wake:** a `start_development` wake (the human clicked **Start Development** on the idea-detail panel) means: claim and execute ALL remaining tasks of the idea's approved proposal in dependency order — loop this workflow until no claimable task remains, leaving `to_verify` and other-session tasks untouched.
- **Human "Yolo" wake:** a `yolo_requested` wake (the human clicked **Yolo** on the idea-detail panel) means: drive the WHOLE idea to done via the yolo skill (`skill_view("chorus:yolo")`, the full-auto AI-DLC pipeline), not just the execute stage — read the idea's current state and resume from whatever phase it is in. Unlike `start_development` it is stage-adaptive, and it must never merge or push a PR without explicit human approval.
- For platform overview and shared tools, see `skill_view("chorus:chorus")`
