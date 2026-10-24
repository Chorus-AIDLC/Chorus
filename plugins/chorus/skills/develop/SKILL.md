---
name: develop
description: Chorus Development workflow — claim tasks, report work, and spawn sub-agent workers for parallel execution. (Codex port)
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.23.2"
  category: project-management
  mcp_server: chorus
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, writing code, reporting progress, and submitting for verification.

---

## Authoritative Idea Team Routing

**Apply this gate before the workflow below, including any claim, assignment, approval, verification or YOLO instructions.** Resolve the event's root Idea via Idea/Task/Proposal/Document reads (including every source Idea in proposal input ancestry); fetch `chorus_get_idea_team_context({ideaUuid})` for each and re-read before mutations. Session anchors, wake messages and `chorus_get_project_team` snapshots are context, not authorization. Missing/ambiguous ancestry or tool failure is a stop, not evidence of unmanaged work.

- **Current assignee, not fixed Team lead:** each Idea's current explicitly human-assigned agent is its orchestrator. New enrollment requires the receiving agent owner's consent, a bound private Team, project editor access and `idea:write`, not Team lead membership or a full admin permission bundle. The optional default lead is a suggestion, never the Idea owner. Runtime “Team Lead” wording describes local worker coordination, not a required project Team role. Unassigned Ideas stay unassigned; assigned-but-not-authorized is not “no owner.” Bare creation, agent self-claim, template changes, presence, upgrades and instance repinning do not start automation. Explicit human selection in conversational creation DOES start it; derived children inherit no authority.
- **Verified agent-mediated start:** ask the receiving owner to use the human confirmation control, or post the exact standalone HUMAN comment `chorus:assign <agent-uuid>` on that Idea. For the comment path call `chorus_prepare_idea_assignment({ideaUuid, agentUuid, commentUuid})`, then pass the returned `uuid` as `humanAuthorizationUuid` to `chorus_pm_assign_idea` with the matching Idea and agent. Both tools require `idea:admin`; confirmation controls are authenticated human actions, not agent tools. Proof is company/project/Idea/target/owner/generation-bound, private, single-use and expires after 24 hours. Never invent consent, post the command as an agent, fake human headers, or reuse stale/edited/deleted/replayed proof. Prose and mentions are not proof. Without proof, permitted agent assignment cannot activate or repair automation; cross-owner assignment needs the receiving owner's consent. Use the same operation key only to retry the identical committed assignment, never to authorize a new one.
- **Delegate without taking ownership:** only the current active orchestrator routes managed work. Use `chorus_recommend_team_agent({ideaUuid, role: "product"})` or `chorus_recommend_team_agent({ideaUuid, role: "development", taskUuid})`. Product delegation uses `chorus_delegate_team_product({ideaUuid, agentUuid})`, never Idea assignment; development uses task assignment after checking eligibility. The orchestrator stays the sole assignee. Product delegates may elaborate and create/submit proposals, but must not claim/release/reassign the Idea, resolve elaboration, approve proposals or verify tasks. Re-delegation invalidates the old turn and creates fresh product AND orchestrator turns, even for the same agent: stop the obsolete run, do not continue with refreshed guesses.
- **Respect recommendations:** `recommended` selects a candidate; the compatibility value `lead_decision` leaves a tie for the current orchestrator; `manual` requires manual handling; `paused` stops automation. Empty/all-ineligible roles mean manual handling, not orchestrator fallback. Only eligible-but-all-offline roles may fall back to an eligible online current orchestrator returned by the tool. Development reopens prefer the eligible online original assignee; otherwise minimize live activeCount, with dependency-chain affinity only as a load-tie breaker. Never invent candidates or silently break ties. Membership grants no permissions/access; recommendations neither assign, reserve load nor wake agents.
- **Stop at server gates:** non-YOLO proposal approval is human-only. Server-confirmed human `yolo_requested` belongs to the exact Idea and survives reassignment; only its current active orchestrator with `proposal:admin` may approve. Task verification does NOT require YOLO, but requires the current active orchestrator, `task:admin`, valid task state and passed required acceptance criteria; delegates/workers cannot verify. Missing only an action permission blocks that action, not enrollment. Local YOLO mode or wake wording grants nothing. Intersect all source Idea gates and retain authorized human control; never retry a denial through another tool.
- **Fence every directed turn:** runtimes must support `ideaTeamProtocol=1` AND `wakeRecoveryProtocol=1`. Carry actual admitted `X-Chorus-Turn-Uuid` / `X-Chorus-Admission-Uuid` headers; for multi-source actions, supplemental `X-Chorus-Idea-Team-Turns` is a JSON array of at most 16 `{turnUuid, admissionUuid}` pairs, requiring the primary pair. Use server-provided primary `ideaTeam` plus `ideaTeams` source snapshots; never invent or reuse stale admission proofs. Scheduling, admission, resume, recovery and mutation recheck recipient, owner, active state and generation. A→B→A does not revive A's old turn; broadcasts cannot bypass fencing. Stop obsolete runs; old clients need an upgrade, not an unfenced fallback. Already executing tasks are not killed, but later mutations must pass current gates.
- **Privacy, repair and review:** shared viewers get only safe gate responsibility, never private rosters/delegation/proofs. Context and recommendations require `idea:read` and project access; recommendations are owner-private. Delegation requires `idea:write`, current active orchestrator authority and live eligibility. Paused enrollment needs explicit human repair; report the reason and end the turn rather than polling. Legacy managed work keeps legacy guards until an authorized transition; unmanaged Ideas and standalone Quick Tasks keep their existing flows. Existing independent reviewer/human gates remain mandatory; review grants no approval/verification authority, no independent Reviewer auto-wake is added, and there is no automatic merge.

## Overview

Developer Agents take Tasks created by PM Agents (via `$proposal`) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin /review
```

For multi-agent parallel execution, the main agent uses Codex's `spawn_agent` tool to launch worker sub-agents. (TRAE CLI: use its `Agent` tool instead of `spawn_agent`; the other steps are the same.)

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

**Shared tools** (checkin, query, comment, search, notifications): see `$chorus`

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

> **Document update flow (OpenSpec mode):** if the originating proposal `description` contains a line `OpenSpec change slug: <slug>`, the project's PRD / tech_design / spec Documents are **mirrors** of files under `openspec/changes/<slug>/`. To update such a Document (e.g. clarify an AC, fix a spec scenario before resubmitting), load the `openspec-aware` skill at `~/.codex/skills/openspec-aware/SKILL.md` and follow §3.8: edit the local `.md` file first, then mirror it — prefer `chorus mcp call … --arg-file content=<file>`, falling back to the `chorus-mcp-call.sh` wrapper with `json_encode_file` when `chorus` is not on `PATH` — with `chorus_check_response` halting on error.
>
> **⛔ Do not** call `chorus_pm_update_document` directly from Codex's MCP harness with a hand-typed `content` field in OpenSpec mode. The local file is the source of truth; agent-typed content drifts and burns tokens (`openspec-aware` §2 Rule 1).
>
> When the LAST task of an OpenSpec idea is verified, the plugin's PostToolUse hook injects an archive reminder (`openspec-aware` §3.9) — run `openspec archive <slug> --yes`, then mirror each emitted `openspec/specs/<capability>/spec.md` back via §3.8.
>
> In the no-OpenSpec fallback (no slug line, or no `openspec` CLI), edit the Document content directly via the existing MCP tool with no wrapper, no local file step.

> **Document update flow (spec-lite mode):** if the originating proposal `description` contains a locator line `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`, the `prd` / `tech_design` / … Documents are **persistent mirrors** of the Chorus-typed docs in that **dated change folder**. Load the `spec-lite` skill (`~/.codex/skills/spec-lite/SKILL.md`). Locate the dated folder from the locator line (not by title/type). Edit those `<type>.md` files in place and update the capability's durable `.chorus/specs/<slug>/spec.md` in place too — but **`spec.md` is never mirrored** (local only, no ids). Tick `- [ ]` acceptance points, then re-mirror each edited dated-folder file via `chorus mcp call chorus_pm_update_document … --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/<type>.md` against its `documentUuid` (each update auto-increments the Document version = its modification history; `chorus-mcp-call.sh` fallback when `chorus` not on `PATH`). **Git history is the audit trail** (`git log -- .chorus/specs/<slug>/`; `git log --follow -- <file>` for a single renamed file) — no changelog section.

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

Report completion without changing the status:
```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "All implementation complete:\n- Files: ...\n- PR: https://github.com/org/repo/pull/42\n- All tests passing"
})
```

> Do **not** pass `status: "to_verify"` here. `chorus_submit_for_verify` (Step 8) is the
> `in_progress -> to_verify` transition; reporting `to_verify` first makes that submit fail
> with `Can only submit for verification from in_progress status`.
>
> **Recovering a task that was already moved this way** — do not simply resubmit:
> 1. Confirm the task was moved prematurely, not legitimately submitted and awaiting verification.
> 2. Have the assignee move it back to `in_progress` with `chorus_update_task`; the usual
>    dependency checks apply.
> 3. **Repeat Step 7.** Leaving `to_verify` clears the developer *and* admin acceptance marks and
>    their evidence, so restore the self-check evidence and confirm the required criteria pass again.
> 4. Submit through Step 8.

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

> **Review Agent:** After `chorus_submit_for_verify`, the Chorus plugin's PostToolUse hook injects context instructing you to spawn the `chorus-task-reviewer` sub-agent. You MUST spawn it yourself (it is NOT auto-launched). Mount this plugin's `chorus-task-reviewer` skill explicitly:
>
> ```
> reviewer = spawn_agent({
>   items: [
>     { type: "skill", name: "Chorus Task Reviewer", path: "chorus:chorus-task-reviewer" },
>     { type: "text",  text: "Review Chorus task <task-uuid>. Post VERDICT comment." }
>   ]
> })
> wait_agent({ targets: [reviewer.agent_id] })
> close_agent({ target: reviewer.agent_id })
> ```
>
> Verification is blocked on the verdict, so this call site waits. Once the reviewer finishes, close it promptly to release its thread slot. The reviewer posts a `VERDICT:` comment on the task.

> **Final code-review gateway (after the Idea's LAST task is verified):** when the task you just verified is the **last** task of its idea-rooted proposal, the feature is about to ship — the PostToolUse hook injects a reminder to run the ship-time code-review gateway. Spawn it the same way, mounting `chorus:chorus-code-reviewer` and passing the `ideaUuid` + round number; it reviews the Idea's **aggregate** code change (cross-task integration, architecture, security, regression, feature-level coverage) and posts one `VERDICT:` comment on the **idea**. `PASS` / `PASS WITH NOTES` → ship; `FAIL` → fix via the **quick-dev** workflow (`$quick-dev`): `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** so the fix tasks attach to it (do not reopen old tasks). Group related small BLOCKERs into one cohesive task by default; split only materially large or independently testable fixes. Each fix task must self-check its acceptance criteria and pass independent task review plus admin verification. Re-run the gateway only after every fix task is successfully `done`; if there is a failed or cancelled fix task, stop and escalate instead. Advisory/behavioral, same as the other reviewers. Run it **before** any idea-completion report.

After the reviewer completes, read its VERDICT:
```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```
Find THIS round's `VERDICT:` comment — the one posted after your dispatch, not an older round's — and act on it:

- **VERDICT: PASS** — All AC verified, no issues. Proceed to admin verification.
- **VERDICT: PASS WITH NOTES** — All AC verified, minor notes. Proceed to admin verification (notes are non-blocking).
- **VERDICT: FAIL** — BLOCKERs found. Do NOT verify. Fix the BLOCKERs listed in the reviewer's comment, then resubmit.

If no new `VERDICT:` comment appears after the reviewer returns, check what it *did* post. A comment reporting that the round limit was reached, or any other explicit refusal to review, is a deliberate escalation to a human: STOP — do not respawn, do not self-review, do not post a VERDICT of your own. If it posted nothing at all, respawn it ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you review the task yourself as a read-only pass using the checklist and POST the VERDICT comment. **Absence is never a PASS.**

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

If the task you just self-verified was the LAST one of its Idea (every Task across every approved Proposal is now `done`/`closed`) and you have `document:write`, prompt the user and call `chorus_create_report` on accept. The call requires `title` (a short report title) plus `content`; `content`'s parameter description carries the three-section template (`## Summary` / `## Decisions` / `## Follow-ups`). Skip on decline — the PostToolUse hook will remind on the next run.

---

## Multi-Agent Workers (Codex `spawn_agent`)

When running multiple sub-agents in parallel on a proposal's tasks, the main agent plays Team Lead.

### Two-Layer Architecture

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Codex `spawn_agent` | Spawning sub-agents, passing task assignments |
| **Work Tracking** | Chorus MCP | Task lifecycle and work reports |

Codex owns execution-thread orchestration (`spawn_agent`, `wait_agent`, `send_input`, `close_agent`, `resume_agent`). Chorus MCP remains authoritative for task claims, status, work reports, acceptance evidence, verification submissions, and reviewer comments.

### Team Lead Workflow

```
# 1. Check in and plan
chorus_checkin()
chorus_list_tasks({ projectUuid: "<project-uuid>" })
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

# 2. Mount the workflow explicitly and pass Chorus entity UUIDs
worker = spawn_agent({
  items: [
    { type: "skill", name: "Chorus Develop", path: "chorus:develop" },
    { type: "text", text: """Work these Chorus tasks in dependency order:
Task UUIDs: <task-uuid-1>, <task-uuid-2>
Project UUID: <project-uuid>

For each task: claim → mark in_progress → implement → report work → self-check AC → submit for verification. Exit after submission; the main agent owns independent review and admin verification.""" }
  ]
})
```

### Context and Lifecycle

- Start routine entity-backed workers and reviewers with a fresh context (the default). They can fetch authoritative context from Chorus using the task, proposal, idea, and project UUIDs in the text item.
- Set `fork_context: true` only when the child genuinely needs material evidence or decisions from the parent conversation that cannot be conveyed cleanly in the mounted skill plus assignment text. State that reason in the assignment.
- Call `wait_agent` only when the next orchestrator action is blocked on the result. Independent workers can run while the main agent handles unrelated work.
- Use `send_input` to clarify, correct, or extend work in an active sub-agent.
- Call `close_agent` as soon as a completed or abandoned sub-agent needs no further interaction; completion alone does not release its thread slot.
- Use `resume_agent` only to restore a previously closed sub-agent. For an active sub-agent, use `send_input`.

### Wave-Based Execution

> **Server-side enforcement**: `chorus_update_task(status: "in_progress")` rejects if any `dependsOn` task is not `done` or `closed`.

1. `chorus_get_unblocked_tasks` — find ready tasks
2. Spawn workers for Wave 1
3. After each worker returns, verify its task (`chorus_admin_verify_task` → `done`)
4. `chorus_get_unblocked_tasks` again — find newly unblocked tasks (Wave 2)
5. Repeat until all tasks done

> **Critical:** `to_verify` does NOT resolve dependencies — only `done` or `closed` does. The Team Lead must verify tasks between waves.

### Multiple Tasks Per Worker

A single worker can work on multiple tasks sequentially — list them in the `spawn_agent` text item in dependency order, and have the worker loop over them.

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

- After submitting for verification, an Admin reviews using `$review`
- **Human "Yolo" wake:** a `yolo_requested` wake (the human clicked **Yolo** on the idea-detail panel) means: drive the WHOLE idea to done via the yolo skill (the full-auto AI-DLC pipeline), not just the execute stage — read the idea's current state and resume from whatever phase it is in. It is stage-adaptive, and it must never merge or push a PR without explicit human approval.
- For platform overview and shared tools, see `$chorus`
