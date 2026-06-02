---
name: quick-dev
description: Quick Task workflow — skip Idea→Proposal, create tasks directly, execute, and verify.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.2"
  category: project-management
  mcp_server: chorus
---

# Quick Dev Skill

Skip the full AI-DLC pipeline (Idea → Elaboration → Proposal → Approval) and create tasks directly. Ideal for small, well-understood work. The goal is for agents to **autonomously record their development work and verify task completion** through structured acceptance criteria.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_create_tasks`). Bare names are used below for readability — prepend `chorus__` when invoking. See `/chorus` for the full rule.

---

## Overview

The standard AI-DLC flow ensures quality through structured planning, but adds overhead that slows down small tasks. Quick Dev provides a lightweight alternative:

```
[check admin role] → chorus_create_tasks → chorus_claim_task → in_progress → report → self-check AC → submit for verify → [self-verify if admin] → done
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

For complex work, use `/idea` + `/proposal` instead.

---

## Pre-Flight: Admin Self-Verify Check

**Before creating tasks**, if `chorus_checkin().agent.permissions.task` includes `"admin"`, ask the user (as a **plain-text prompt** — OpenClaw has no `AskUserQuestion`):

> "I have admin privileges. After development, should I verify the task myself, or leave it for another admin to verify? Reply 'self' or 'other'."

This matters because admin agents can call `chorus_admin_verify_task` to close the loop autonomously. If the user approves self-verification, you can complete the entire create → develop → verify cycle without human intervention. Record the decision and apply it in Step 7.

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

**Sub-agents:** create your own session first (manual on OpenClaw — see `/develop`), then pass `sessionUuid` for attribution:
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

### Step 7: Submit for Verification (or Self-Verify)

```
chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Fixed Safari login redirect loop. Changed SameSite cookie policy. All AC passed."
})
```

**Admin self-verification:** If you have `task: ["admin"]` in `permissions` and the user approved self-verification in the Pre-Flight check, you can verify the task yourself immediately after submitting:

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

This completes the full autonomous cycle: create → develop → verify → done.

> **Optional independent review:** for non-trivial quick tasks you may still run the `/task-reviewer` skill in a spawned sub-agent (`sessions_spawn` with a task telling it to run `/task-reviewer` against the taskUuid, then wait for the VERDICT) or do a focused read-only self-review before verifying — same pattern as `/develop` Step 8.5. There is no PostToolUse hook on OpenClaw, so do this inline if you want it.

---

## Session Integration

Quick Tasks support sub-agent execution just like proposal-based tasks. **Session lifecycle is manual on OpenClaw** (no SubagentStart/heartbeat/cleanup hooks):

- **Main agent**: create quick tasks, work them yourself, or hand task UUIDs to sub-agents
- **Sub-agents**: create your own session (`chorus_create_session`), checkin/checkout per task, pass `sessionUuid` to `chorus_update_task` / `chorus_report_work`, and close the session on exit — see `/develop` for the full manual protocol

> OpenClaw has no Agent Teams / `TeamCreate` primitive; if you need to run several quick tasks, work them sequentially as the main agent (or dispatch generic sub-agents one at a time).

---

## Tips

- Keep Quick Tasks small — if you need more than 2-3 tasks, consider using `/proposal`
- **Acceptance criteria are required at creation time** — `chorus_create_tasks` rejects tasks without them. They are your self-check contract; specific, testable AC enables autonomous verification and makes the entire workflow self-contained
- Use `chorus_update_task` to refine tasks (including AC) after creation rather than deleting and recreating
- Pass `proposalUuid` to attach follow-up or gap-filling tasks to an existing proposal — this keeps related work grouped in the same project context and DAG
- Quick Tasks show up in the same project task list and DAG as proposal-based tasks
- Admin agents can run the full lifecycle autonomously (create → develop → self-verify) — but always confirm with the user first (plain-text prompt)

---

## Next

- For full task lifecycle details, see `/develop`
- For admin verification, see `/review`
- For the standard planning flow, see `/idea` and `/proposal`
- For platform overview, see `/chorus`
