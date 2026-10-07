---
name: quick-dev
description: Quick Task workflow — skip Idea→Proposal, create tasks directly, execute, run the task reviewer via Hermes delegate_task, and verify.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.22.0"
  category: project-management
  mcp_server: chorus
---

# Quick Dev Skill

Skip the full AI-DLC pipeline (Idea → Elaboration → Proposal → Approval) and create tasks directly. Ideal for small, well-understood work. The goal is for agents to **autonomously record their development work and verify task completion** through structured acceptance criteria.

---

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

For complex work, use the idea and proposal skills instead (`skill_view("chorus:idea")`, `skill_view("chorus:proposal")`).

---

## Pre-Flight: Permission Check

Call `chorus_checkin` and inspect the active agent's effective permissions. Set `canVerifyTask` to true **only** when `chorus_checkin().agent.permissions.task` explicitly contains `"admin"` (the `task:admin` permission).

Never infer verification authority from the agent's name, persona, preset/role label, task ownership, or tool availability. Do not ask whether to self-verify: the explicit permission determines the terminal path.

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

**Workers** (`delegate_task` children with a Team-Lead-created session): pass `sessionUuid` for attribution:
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

Submitting is not final verification. The Chorus Hermes plugin appends a reminder to the `chorus_submit_for_verify` result; act on it. Build the evidence bundle (diff, commit log, and test output written to files under `/tmp/chorus-review/<task-uuid>/` with `terminal`), then run the required `chorus-task-reviewer` as a read-only `delegate_task` child whose `context` starts with the `[chorus-reviewer:task]` marker and passes the task UUID, repo path, round cap (3), and evidence paths. The full example is in the review skill (`skill_view("chorus:review")`, Review Strategy) and in `skill_view("chorus:develop")` Step 8. `delegate_task` blocks until the reviewer finishes; then read THIS round's `VERDICT:` Task comment — the one posted after your dispatch, not an older round's. `PASS` and `PASS WITH NOTES` continue. On `FAIL`, do not verify or hand off: fix every unresolved BLOCKER, repeat AC self-check and submission, then run a fresh independent task review.

### Step 8: Permission-Aware Verification

With explicit `task:admin`, after every required AC self-check passes and independent review has no unresolved BLOCKER, verify and continue autonomously:

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

Without explicit `task:admin`, do not call the admin tool. Post an evidence-rich comment on the Task with `chorus_add_comment` containing AC results, test evidence, the latest independent-review verdict, and the exact requested action. @mention the responsible human (prefer `chorus_checkin().agent.owner`, as `@[Name](user:<ownerUuid>)`) to perform admin verification, then end the current turn.

This handoff applies in interactive CLI sessions and in Chorus-woken gateway sessions alike. Do not ask in chat instead of commenting, poll for the human response, or rely only on generic notifications. When the human replies or verifies, the `chorus` gateway platform wakes you in the Idea's session if follow-up is needed.

---

## Session Integration

Quick Tasks work with Hermes `delegate_task` workers just like proposal-based tasks (see `skill_view("chorus:develop")`, Parallel Workers):

- **Team Lead**: create quick tasks, create (or reopen) one Chorus session per worker with `chorus_create_session`, then run the workers with `delegate_task` (one child, or a `tasks=[...]` batch). Each child has an isolated context, so pass the task UUID, project UUID, repo path, session UUID, and the instruction to `skill_view("chorus:develop")` first in its `context`.
- **Workers**: checkin with `chorus_session_checkin_task`, pass `sessionUuid` to `chorus_update_task` and `chorus_report_work`, checkout with `chorus_session_checkout_task`, then `chorus_submit_for_verify`
- **Session lifecycle**: `delegate_task` blocks until the workers finish; the Team Lead then calls `chorus_close_session` for each worker session and runs the task reviewer per task

---

## Tips

- Keep Quick Tasks small — if you need more than 2-3 tasks, consider using the proposal skill (`skill_view("chorus:proposal")`)
- **Acceptance criteria are required at creation time** — `chorus_create_tasks` rejects tasks without them. They are your self-check contract; specific, testable AC enables autonomous verification and makes the entire workflow self-contained
- Use `chorus_update_task` to refine tasks (including AC) after creation rather than deleting and recreating
- Pass `proposalUuid` to attach follow-up or gap-filling tasks to an existing proposal — this keeps related work grouped in the same project context and DAG
- Quick Tasks show up in the same project task list and DAG as proposal-based tasks
- Agents with explicit `task:admin` continue autonomously after AC and independent review pass; all others use the evidence-rich asynchronous human handoff

---

## Next

- For full task lifecycle details, see `skill_view("chorus:develop")`
- For admin verification, see `skill_view("chorus:review")`
- For the standard planning flow, see `skill_view("chorus:idea")` and `skill_view("chorus:proposal")`
- For platform overview, see `skill_view("chorus:chorus")`
