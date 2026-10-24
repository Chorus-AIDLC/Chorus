---
name: quick-dev-chorus
description: Quick Task workflow — skip Idea→Proposal, create tasks directly, execute, and verify.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.23.2"
  category: project-management
  mcp_server: chorus
---

# Quick Dev Skill

Skip the full AI-DLC pipeline (Idea → Elaboration → Proposal → Approval) and create tasks directly. Ideal for small, well-understood work. The goal is for agents to **autonomously record their development work and verify task completion** through structured acceptance criteria.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `mcp__chorus__` prefix on dsh (e.g. `mcp__chorus__chorus_create_tasks`). Bare names are used below for readability — prepend `mcp__chorus__` when invoking. See `chorus` for the full rule.

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

The standard AI-DLC flow ensures quality through structured planning, but adds overhead that slows down small tasks. Quick Dev provides a lightweight alternative:

```
check explicit task:admin permission → create/claim → implement → self-check AC → submit → independent task review → verify or hand off
```

**Use Quick Dev when:**
- Bug fixes with clear reproduction steps
- Small features (< 2 story points)
- Post-delivery patches and gap-filling after a proposal's tasks are done
- Prototype or exploratory tasks
- Urgent hotfixes that can't wait for proposal review

**Do NOT use Quick Dev when:**
- The feature needs a PRD or tech design document
- Multiple interdependent tasks require upfront planning
- Stakeholder elaboration is needed to clarify requirements
- The work impacts architecture or shared components significantly

For complex work, use `idea-chorus` + `proposal-chorus` instead.

---

## Pre-Flight: Permission Check

Call `chorus_checkin` and inspect the active agent's effective permissions. Set `canVerifyTask` to true **only** when `chorus_checkin().agent.permissions.task` explicitly contains `"admin"` (the `task:admin` permission).

Never infer verification authority from the agent's name, persona, preset/role label, task ownership, or tool availability. Do not prompt the user to choose: the explicit permission determines the terminal path.

---

## Tools

| Tool | Purpose |
|------|---------|
| `chorus_create_tasks` | Create task(s) — omit `proposalUuid` for standalone Quick Task, or pass it to attach to an existing proposal |
| `chorus_update_task` | Edit task fields (title, description, priority, AC, dependencies) or change status |
| `chorus_claim_task` | Claim a task (open → assigned) |
| `chorus_report_work` | Report progress with optional status update |
| `chorus_report_criteria_self_check` | Self-check acceptance criteria before submitting |
| `chorus_submit_for_verify` | Submit for admin verification |
| `chorus_admin_verify_task` | **(admin only)** Verify task — use when self-verification is approved |

---

## Workflow

### Step 1: Create a Quick Task

**`acceptanceCriteriaItems` is required** — `chorus_create_tasks` rejects any task without at least one non-blank criterion (and rejects the whole batch if any task is missing them). These are also the foundation for self-checking in Step 6. Write specific, testable criteria that you can objectively verify after development. Vague AC like "works correctly" defeats the purpose; prefer "returns 200 on GET /api/foo with valid token".

```
chorus_create_tasks({
  projectUuid: "<project-uuid>",
  tasks: [{
    title: "Fix login redirect loop on Safari",
    description: "Safari loses session cookie after redirect...",
    priority: "high",
    storyPoints: 1,
    acceptanceCriteriaItems: [
      { description: "Login works on Safari 17+", required: true },
      { description: "Existing Chrome/Firefox behavior unchanged", required: true }
    ]
  }]
})
```

**`proposalUuid` is optional:**
- **Omit** for standalone quick tasks (bug fixes, hotfixes, exploratory work)
- **Pass** to attach the task to an existing proposal — useful for gap-filling, follow-up patches, or continuing work after a proposal's initial tasks are delivered

### Step 2: Claim the Task

```
chorus_claim_task({ taskUuid: "<task-uuid>" })
```

### Step 3: Edit Details (if needed)

Use `chorus_update_task` to refine the task after creation. Tasks always have AC (creation requires them), but **update them when your understanding changes during development**. Passing `acceptanceCriteriaItems` **replaces** the task's criteria with the provided non-empty set; omit the field to leave them unchanged (it cannot be used to clear AC).

```
chorus_update_task({
  taskUuid: "<task-uuid>",
  description: "Updated with more details...",
  acceptanceCriteriaItems: [
    { description: "Login works on Safari 17+", required: true },
    { description: "Added CSRF token handling", required: true }
  ],
  addDependsOn: ["<other-task-uuid>"]
})
```

### Step 4: Start Working

```
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })
```

**Sub-agents:** create your own session first (manual on dsh — see `develop-chorus`), then pass `sessionUuid` for attribution:
```
chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress", sessionUuid: "<session-uuid>" })
```

### Step 5: Report Progress

```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "Fixed Safari cookie issue:\n- Root cause: SameSite=Strict incompatible with redirect\n- Changed to SameSite=Lax\n- Commit: abc1234",
  sessionUuid: "<session-uuid>"
})
```

> Keep completion reports status-free. `chorus_submit_for_verify` (Step 7), not
> `chorus_report_work`, performs the `in_progress -> to_verify` transition. If a task
> was moved prematurely, first confirm it is not legitimately awaiting verification.
> The assignee can return it to `in_progress` with `chorus_update_task`, subject to
> dependency checks. This clears developer and admin acceptance marks and evidence:
> repeat Step 6 before submitting again. Do not mechanically roll back submitted tasks.

### Step 6: Self-Check Acceptance Criteria

```
chorus_report_criteria_self_check({
  taskUuid: "<task-uuid>",
  criteria: [
    { uuid: "<ac-uuid-1>", devStatus: "passed", devEvidence: "Tested on Safari 17.2" },
    { uuid: "<ac-uuid-2>", devStatus: "passed", devEvidence: "Chrome/Firefox regression tests pass" }
  ]
})
```

### Step 7: Submit and Run Independent Review

```
chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Fixed Safari login redirect loop. Changed SameSite cookie policy. All AC passed."
})
```

Submitting is not final verification. Spawn the required task-reviewer skill through `subagent` with **`run_in_background: false`** (foreground — the call waits for the reviewer to finish, and the verdict is the `VERDICT:` comment it posts rather than the call's return value; your verify/reopen decision depends on it) as described in `develop-chorus`, and read this round's `VERDICT:` Task comment. (Set `run_in_background: true` only when you deliberately want to fan out and collect the verdict later.) `PASS` and `PASS WITH NOTES` continue. On `FAIL`, do not verify or hand off: fix every unresolved BLOCKER, repeat AC self-check and submission, then run a fresh independent task review.

### Step 8: Permission-Aware Verification

With explicit `task:admin`, after every required AC self-check passes and independent review has no unresolved BLOCKER, verify and continue autonomously:

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

Without explicit `task:admin`, do not call the admin tool. Post an evidence-rich comment on the Task containing AC results, test evidence, the latest independent-review verdict, and the exact requested action. @mention the responsible human (prefer `chorus_checkin().agent.owner`) to perform admin verification, then end the current turn.

This handoff applies in interactive and headless daemon sessions. Do not send a plain-text interactive prompt, poll for the human response, or rely only on generic notifications.

---

## Session Integration

Quick Tasks support sub-agent execution just like proposal-based tasks. **Session lifecycle is manual on dsh** (no SubagentStart/heartbeat/cleanup hooks):

- **Main agent**: create quick tasks, work them yourself, or hand task UUIDs to sub-agents
- **Sub-agents**: create your own session (`chorus_create_session`), checkin/checkout per task, pass `sessionUuid` to `chorus_update_task` / `chorus_report_work`, and close the session on exit — see `develop-chorus` for the full manual protocol

> There is no team object to create: to run several quick tasks in parallel, dispatch one `subagent` per task with `run_in_background: true`, issuing them in a single message. If `subagent` is unavailable on your host or workers fail repeatedly, work the tasks sequentially as the main agent.

---

## Tips

- Keep Quick Tasks small — if you need more than 2-3 tasks, consider using `proposal-chorus`
- **Acceptance criteria are required at creation time** — `chorus_create_tasks` rejects tasks without them. They are your self-check contract; specific, testable AC enables autonomous verification and makes the entire workflow self-contained
- Use `chorus_update_task` to refine tasks (including AC) after creation rather than deleting and recreating
- Pass `proposalUuid` to attach follow-up or gap-filling tasks to an existing proposal — this keeps related work grouped in the same project context and DAG
- Quick Tasks show up in the same project task list and DAG as proposal-based tasks
- Agents with explicit `task:admin` continue autonomously after AC and independent review pass; all others use the evidence-rich asynchronous human handoff

---

## Next

- For full task lifecycle details, see `develop-chorus`
- For admin verification, see `review-chorus`
- For the standard planning flow, see `idea-chorus` and `proposal-chorus`
- For platform overview, see `chorus`
