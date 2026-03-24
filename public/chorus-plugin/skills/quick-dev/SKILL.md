---
name: quick-dev
version: 0.1.0
description: Quick Task workflow — skip Idea→Proposal, create tasks directly, execute, and verify.
---

# Quick Dev Skill

Skip the full AI-DLC pipeline (Idea → Elaboration → Proposal → Approval) and create tasks directly. Ideal for small, well-understood work.

---

## Overview

The standard AI-DLC flow ensures quality through structured planning, but adds overhead that slows down small tasks. Quick Dev provides a lightweight alternative:

```
chorus_create_tasks → chorus_claim_task → in_progress → report → self-check AC → submit for verify → done
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

## Tools

| Tool | Purpose |
|------|---------|
| `chorus_create_tasks` | Create task(s) directly — omit `proposalUuid` for Quick Task mode |
| `chorus_update_task` | Edit task fields (title, description, priority, AC, dependencies) or change status |
| `chorus_claim_task` | Claim a task (open → assigned) |
| `chorus_report_work` | Report progress with optional status update |
| `chorus_report_criteria_self_check` | Self-check acceptance criteria before submitting |
| `chorus_submit_for_verify` | Submit for admin verification |

---

## Workflow

### Step 1: Create a Quick Task

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

**Omit `proposalUuid`** — this is what makes it a Quick Task.

To associate with an existing proposal (gap-filling): pass `proposalUuid`.

### Step 2: Claim the Task

```
chorus_claim_task({ taskUuid: "<task-uuid>" })
```

### Step 3: Edit Details (if needed)

Use `chorus_update_task` to refine the task after creation:

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

**Sub-agents:** pass `sessionUuid` for attribution:
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

### Step 7: Submit for Verification

```
chorus_submit_for_verify({
  taskUuid: "<task-uuid>",
  summary: "Fixed Safari login redirect loop. Changed SameSite cookie policy. All AC passed."
})
```

---

## Session Integration

Quick Tasks work with Claude Code Agent Teams just like proposal-based tasks:

- **Team Lead**: create quick tasks, then assign to sub-agents via task UUIDs
- **Sub-agents**: the Chorus Plugin auto-injects session context — just pass `sessionUuid` to `chorus_update_task` and `chorus_report_work`
- **Session lifecycle** is fully automated by the plugin

---

## Tips

- Keep Quick Tasks small — if you need more than 2-3 tasks, consider using `/proposal`
- Always add acceptance criteria — they enable structured verification
- Use `chorus_update_task` to refine tasks after creation rather than deleting and recreating
- For gap-filling after a proposal, pass the `proposalUuid` to keep tasks grouped
- Quick Tasks show up in the same project task list and DAG as proposal-based tasks

---

## Next

- For full task lifecycle details, see `/develop`
- For admin verification, see `/review`
- For the standard planning flow, see `/idea` and `/proposal`
- For platform overview, see `/chorus`
