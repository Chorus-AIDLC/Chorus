---
name: quick-dev-chorus
version: 0.1.0
description: Quick Task workflow — skip Idea→Proposal, create tasks directly, execute, and verify.
---

# Quick Dev Skill

Skip the full AI-DLC pipeline (Idea → Elaboration → Proposal → Approval) and create tasks directly. Ideal for small, well-understood work. The goal is for agents to **autonomously record their development work and verify task completion** through structured acceptance criteria.

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

For complex work, consider using the idea and proposal skills instead.

---

## Pre-Flight: Admin Self-Verify Check

**Before creating tasks**, if you have the `admin_agent` role, ask the user:

> "I have admin privileges. After development, should I verify the task myself, or leave it for another admin to verify?"

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

**Always include `acceptanceCriteriaItems`** — these are the foundation for self-checking in Step 6. Write specific, testable criteria that you can objectively verify after development. Vague AC like "works correctly" defeats the purpose; prefer "returns 200 on GET /api/foo with valid token".

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

Use `chorus_update_task` to refine the task after creation. **If you skipped AC in Step 1, add them now** — you will need them for self-check later. Also update AC when your understanding of the task changes during development.

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

### Step 5: Report Progress

```
chorus_report_work({
  taskUuid: "<task-uuid>",
  report: "Fixed Safari cookie issue:\n- Root cause: SameSite=Strict incompatible with redirect\n- Changed to SameSite=Lax\n- Commit: abc1234"
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

**Admin self-verification:** If you have the `admin_agent` role and the user approved self-verification in the Pre-Flight check, you can verify the task yourself immediately after submitting:

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

This completes the full autonomous cycle: create → develop → verify → done.

---

## Tips

- Keep Quick Tasks small — if you need more than 2-3 tasks, consider using a proposal
- **Always write acceptance criteria at creation time** — they are your self-check contract. Specific, testable AC enables autonomous verification and makes the entire workflow self-contained
- Use `chorus_update_task` to refine tasks (including AC) after creation rather than deleting and recreating
- Pass `proposalUuid` to attach follow-up or gap-filling tasks to an existing proposal — this keeps related work grouped in the same project context and DAG
- Quick Tasks appear in the same project task list and DAG as proposal-based tasks
- Admin agents can run the full lifecycle autonomously (create → develop → self-verify) — but always confirm with the user first

---

## Next

- For full task lifecycle details, download `<BASE_URL>/skill/develop-chorus/SKILL.md`
- For admin verification, download `<BASE_URL>/skill/review-chorus/SKILL.md`
- For the standard planning flow, download `<BASE_URL>/skill/idea-chorus/SKILL.md` and `<BASE_URL>/skill/proposal-chorus/SKILL.md`
- For platform overview, download `<BASE_URL>/skill/chorus/SKILL.md`
