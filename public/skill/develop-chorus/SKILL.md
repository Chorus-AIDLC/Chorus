---
name: develop-chorus
description: Chorus Development workflow — claim tasks, report work, self-check acceptance criteria, and submit for verification.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.17.2"
  category: project-management
  mcp_server: chorus
---

# Develop Skill

This skill covers the **Development** stage of the AI-DLC workflow: claiming Tasks, doing the work, reporting progress, and submitting for verification.

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

Developer Agents take Tasks created by PM Agents (via proposals) and turn them into working code. Each task follows:

```
claim --> in_progress --> report work --> self-check AC --> submit for verify --> Admin review
```

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

**Shared tools** (checkin, query, comment, search, notifications): see `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`)

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

### Step 5: Start Working

Mark the task as in-progress:

```
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })
```

> **Dependency enforcement**: If this task has unresolved dependencies (dependsOn tasks not in `done` or `closed`), the call will be rejected with detailed blocker info. Use `chorus_get_unblocked_tasks` to find tasks you can start now.

### Step 6: Report Progress

Report periodically with `chorus_report_work`. Consider including:
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

> For **required** criteria, prefer to keep working until you can self-check as `passed`. Only use `failed` for **optional** criteria that are out of scope.

### Step 8: Submit for Verification

```
chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Implemented auth feature:\n- Added login/logout endpoints\n- JWT middleware\n- 95% test coverage\n- All AC self-checked (3/3 passed)"
})
```

> `to_verify` does NOT unblock downstream tasks — only `done` (after admin verification) does.

> **Independent Review:** After `chorus_submit_for_verify`, run an independent review of the task before it is verified. Spawn a read-only sub-agent that loads the `task-reviewer-chorus` skill (`<BASE_URL>/skill/task-reviewer-chorus/SKILL.md`), pass it the `taskUuid`, and let it post a single `VERDICT` comment (PASS / PASS WITH NOTES / FAIL) on the task; then read THIS round's verdict comment — the one posted after your dispatch, not an older round's — with `chorus_get_comments` and act on it. The verdict is **advisory** (it does not block verification). The spawn mechanism is harness-specific, and an inline self-review fallback exists when sub-agents are unavailable — see the canonical **Independent Review** section in the `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`) for the full pattern.

> **Final code-review gateway (after the Idea's LAST task is verified):** when the task you just verified is the **last** task of its idea-rooted proposal, the feature is about to ship — run the ship-time code-review gateway before declaring the Idea done. Spawn a read-only sub-agent that loads the `code-reviewer-chorus` skill (`<BASE_URL>/skill/code-reviewer-chorus/SKILL.md`), pass it the `ideaUuid` + round number, and let it review the Idea's **aggregate** code change (cross-task integration, architecture, security, regression, feature-level coverage) and post one `VERDICT` comment on the **Idea**. `PASS` / `PASS WITH NOTES` → ship; `FAIL` → fix via the **quick-dev** workflow (`<BASE_URL>/skill/quick-dev-chorus/SKILL.md`): `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** so the fix tasks attach to it. Group related small BLOCKERs by default; split only materially large or independently testable fixes. Require AC self-check, independent task review, and admin verification for every fix task. Re-run aggregate review only after every fix is successfully `done`; a failed or cancelled fix stops the loop and escalates. Do **not** reopen the already-verified tasks. The plugin's post-verify hook injects this reminder automatically; the verdict is **advisory** (same canonical pattern). Run it **before** writing any idea-completion report.

### Step 9: Handle Review Feedback

If reopened (verification failed), **all acceptance criteria are reset to pending**.

1. Check feedback:
   ```
   chorus_get_task({ taskUuid: "<task-uuid>" })
   chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
   ```
2. Fix the issues, report fixes, and resubmit.

### Step 10: Task Complete

Once Admin verifies (status: `done`), move to the next available task (back to Step 2).

### Step 11: Idea Completion Report (advisory)

If the task you just self-verified was the LAST one of its Idea (every Task across every approved Proposal is now `done`/`closed`) and you have `document:write`, prompt the user and call `chorus_create_report` on accept. The call requires `title` (a short report title) plus `content`; `content`'s parameter description carries the three-section template (`## Summary` / `## Decisions` / `## Follow-ups`). Skip on decline.

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
- If blocked, consider adding a comment and releasing the task
- Prefer finishing one task at a time: complete or release before claiming another

---

## When to Release a Task

Release if:
- You cannot complete it (missing knowledge, blocked)
- A higher-priority task needs attention
- You will not finish in a reasonable timeframe

```
chorus_release_task({ taskUuid: "<task-uuid>" })
chorus_add_comment({ targetType: "task", targetUuid: "<task-uuid>", content: "Releasing: reason..." })
```

---

## Next

- After submitting for verification, an Admin reviews using the `review-chorus` skill (`<BASE_URL>/skill/review-chorus/SKILL.md`)
- **Human "Start Development" wake:** a `start_development` wake (the human clicked **Start Development** on the idea-detail panel) means: claim and execute ALL remaining tasks of the idea's approved proposal in dependency order — loop this workflow until no claimable task remains, leaving `to_verify` and other-session tasks untouched.
- **Human "Yolo" wake:** a `yolo_requested` wake (the human clicked **Yolo** on the idea-detail panel) means: drive the WHOLE idea to done via the yolo skill (the full-auto AI-DLC pipeline), not just the execute stage — read the idea's current state and resume from whatever phase it is in. Unlike `start_development` it is stage-adaptive, and it must never merge or push a PR without explicit human approval.
- For platform overview and shared tools, see `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`)
