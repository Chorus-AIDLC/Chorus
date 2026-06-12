---
name: yolo
description: Full-auto AI-DLC pipeline — from prompt to done. Automates the entire Idea -> Proposal -> Execute -> Verify lifecycle.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.10.0"
  category: project-management
  mcp_server: chorus
---

# Yolo Skill

Full-auto AI-DLC pipeline. User provides a prompt; agent drives the entire lifecycle: Idea -> Elaboration -> Proposal -> Review -> Execute -> Verify -> Done.

---

## Overview

`/yolo` automates the complete AI-DLC workflow. You provide a natural language description of what you want built, and the agent handles everything:

1. **Planning** -- create project, idea, self-elaboration, proposal with docs & tasks
2. **Proposal Review** -- proposal-reviewer adversarial loop
3. **Execution** -- wave-based Agent Team parallel task dispatch
4. **Verification** -- task-reviewer adversarial loop + admin verify
5. **Report** -- completion summary

```
/yolo <prompt>
       |
       v
  Project + Idea + Elaboration + Proposal
       |
       v
  Proposal Reviewer (auto, up to maxProposalReviewRounds)
       |
       v
  Admin Approve --> Tasks materialize
       |
       v
  Wave-based Agent Team execution
       |  (dev agent + task-reviewer per task)
       v
  Admin Verify each wave --> unblock next
       |
       v
  Done. Report summary.
```

**Escape hatch:** Ctrl+C at any time. All created entities (project, idea, proposal, tasks) persist in Chorus. Resume manually via `/develop` or `/review`.

---

## Prerequisites

The API key needs write + admin on every resource it touches:

| Needs | Why |
|------|-----|
| `idea: [write]` | Create ideas, run elaboration |
| `proposal: [write, admin]` | Create proposals; approve them |
| `task: [write, admin]` | Create, execute, verify tasks |
| `project: [write]` | Create the project if none is given |

**Check at startup:**

```
perms = chorus_checkin().agent.permissions
need = { idea: ["write"], proposal: ["write","admin"],
         task: ["write","admin"], project: ["write"] }

for resource, actions in need:
  missing = [a for a in actions if a not in (perms[resource] or [])]
  if missing: ABORT "/yolo needs {resource}: {missing}. Use an Admin-preset API key."
```

---

## Input

```
/yolo <natural language prompt>
/yolo <prompt> --project <project-uuid>
```

- `<prompt>` -- what you want built (becomes the Idea content)
- `--project <uuid>` -- optional; use an existing project instead of creating a new one

---

## Workflow

### Phase 1: Planning

#### Step 1.1: Resolve Project

Parse the arguments for `--project <uuid>`.

**If `--project` is provided:**
```
chorus_get_project({ projectUuid: "<uuid>" })
```
Verify it exists and proceed.

**If not provided**, search for a suitable existing project first:
```
# 1. Search for projects matching the prompt topic
chorus_search({ query: "<key terms from prompt>", entityTypes: ["project"] })

# 2. Or list recent projects to find a match
chorus_list_projects()
```

Review the results. If a project clearly matches the user's intent (same topic, active, relevant scope), use it. If no suitable project exists, create a new one:
```
chorus_admin_create_project({
  name: "<short title derived from prompt>",
  description: "<1-2 sentence summary of the prompt>"
})
```

#### Step 1.2: Create Idea

```
chorus_pm_create_idea({
  projectUuid: "<project-uuid>",
  title: "<concise title derived from prompt>",
  content: "<full user prompt as-is>"
})
```

Then claim it:
```
chorus_claim_idea({ ideaUuid: "<idea-uuid>" })
```

#### Step 1.3: Self-Elaboration

In /yolo mode, the agent generates elaboration questions and answers them itself -- no `AskUserQuestion` calls. This preserves an audit trail without interrupting the user.

> **Self-elaboration is still a loop.** If answering your own questions surfaces a **new question, contradiction, or gap**, loop back to `chorus_pm_start_elaboration` for another self-answered round before resolving — don't force a resolve over unresolved ambiguity. There is no human gate in YOLO, so the loop exits on **your** judgment that nothing material is left open (round cap 10). Steps 1–2 are one round; repeat them as needed, then resolve once in Step 3.

1. **Generate and submit questions:**
   ```
   chorus_pm_start_elaboration({
     ideaUuid: "<idea-uuid>",
     depth: "standard",
     questions: [
       {
         id: "q1",
         text: "<question about scope, architecture, etc.>",
         category: "functional",
         options: [
           { id: "a", label: "<option A>" },
           { id: "b", label: "<option B>" }
         ]
       }
       // ... 5-8 questions covering functional, technical, scope aspects
     ]
   })
   ```

2. **Answer immediately** (agent selects best options based on the prompt):
   ```
   chorus_answer_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     answers: [
       { questionId: "q1", selectedOptionId: "a", customText: "Rationale: ..." },
       // ...
     ]
   })
   ```

3. **Resolve** — in YOLO mode the agent resolves elaboration **autonomously, with no human-confirmation gate** (the human-confirmation requirement that applies to the interactive `/idea` flow is explicitly waived under `/yolo` automation):

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>"
   })
   ```

   > `chorus_pm_validate_elaboration` requires `idea:admin`. `/yolo` already mandates an Admin-preset key in Prerequisites, so this is satisfied. To open another self-elaboration round instead of resolving, just call `chorus_pm_start_elaboration` again.

#### Step 1.4: Create Proposal

1. **Detect OpenSpec mode.** Load the `openspec-aware` skill at `.claude/skills/openspec-aware/SKILL.md` and run its §1 detection contract. The result determines how the rest of this step authors documents:

   - `CHORUS_OPENSPEC_ACTIVE=1` → spec-driven branch (sub-step 2a below).
   - `CHORUS_OPENSPEC_ACTIVE=0` → free-form branch (sub-step 2b below).

   This is mandatory — yolo runs unattended, so silently picking the wrong mode is exactly the failure scenario the detection contract exists to prevent.

2. **Create the empty proposal container.** In OpenSpec mode, the `description` MUST contain the literal line `OpenSpec change slug: <slug>` (use the `$SLUG` you'll pick in 2a); in free-form mode, omit that line.

   ```
   chorus_pm_create_proposal({
     projectUuid: "<project-uuid>",
     title: "<feature name>",
     description: "<summary>\n\nOpenSpec change slug: <slug>",   // OpenSpec mode
     // description: "<summary>",                                 // free-form mode
     inputType: "idea",
     inputUuids: ["<idea-uuid>"]
   })
   ```

   Then branch:

   **2a. OpenSpec mode (`CHORUS_OPENSPEC_ACTIVE=1`).** Follow `openspec-aware` §3 end-to-end:
   - Pick `$SLUG`, run `openspec new change "$SLUG"` (§3.1–§3.2).
   - Author `proposal.md`, `design.md`, and one `specs/<capability>/spec.md` per capability locally on disk (§3.3). ADDED Requirements only; per-spec fallback to free-form Markdown if MODIFIED/REMOVED is needed.
   - Define `$API`, `json_encode_file`, `chorus_check_response` helpers (§3.4, §6).
   - Mirror each local file via `"$API" mcp-tool chorus_pm_add_document_draft "$PAYLOAD"` (§3.6) — one call per file, with the document type from `openspec-aware` §5.

   > **⛔ Do not** invoke `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_update_document` from the MCP harness with a hand-typed `content` field in this branch. Re-typing the markdown body wastes 20k+ tokens per proposal and breaks byte-equality with the local files. See `openspec-aware` §2 Rule 1.

   Then continue to step 3 (task drafts).

   **2b. Free-form mode (`CHORUS_OPENSPEC_ACTIVE=0`).** Add a tech design document draft directly via MCP, content authored inline:

   ```
   chorus_pm_add_document_draft({
     proposalUuid: "<proposal-uuid>",
     type: "tech_design",
     title: "Tech Design: <feature>",
     content: "<markdown tech design covering architecture, data model, API, module contracts>"
   })
   ```

3. **Add task drafts incrementally** (use returned `draftUuid` for dependency chaining). `acceptanceCriteriaItems` is **required** on every draft — at least one non-blank criterion, or the call is rejected:
   ```
   # First task
   result1 = chorus_pm_add_task_draft({
     proposalUuid: "<proposal-uuid>",
     title: "<module name>",
     description: "<what to build, referencing tech design>",
     priority: "high",
     storyPoints: 3,
     acceptanceCriteriaItems: [
       { description: "<testable criterion>", required: true },
       // ...
     ]
   })

   # Second task, depends on first
   chorus_pm_add_task_draft({
     proposalUuid: "<proposal-uuid>",
     title: "<dependent module>",
     description: "...",
     priority: "medium",
     storyPoints: 2,
     acceptanceCriteriaItems: [...],
     dependsOnDraftUuids: ["<result1.draftUuid>"]
   })
   ```

4. **Validate:**
   ```
   chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
   ```
   Fix any errors, then proceed.

5. **Submit:**
   ```
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```
   After this call, the PostToolUse hook injects context instructing you to spawn `chorus:proposal-reviewer`. You MUST spawn it yourself in **foreground** (do NOT set `run_in_background`) — it is NOT auto-launched.

---

### Phase 2: Proposal Review Loop

After `chorus_pm_submit_proposal`, the PostToolUse hook injects context instructing you to spawn `chorus:proposal-reviewer`. You MUST manually spawn it as a read-only sub-agent in **foreground** (do NOT set `run_in_background`). Wait for it to complete, then:

1. **Read the reviewer's VERDICT:**
   ```
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```
   Look for the most recent comment containing `VERDICT:`.

2. **Act on the VERDICT:**

   - **PASS** or **PASS WITH NOTES** --
     ```
     chorus_admin_approve_proposal({
       proposalUuid: "<proposal-uuid>",
       reviewNote: "PASS from reviewer. <brief summary of notes if any>"
     })
     ```
     Tasks and documents materialize automatically. Proceed to Phase 3.

   - **FAIL** --
     Read the BLOCKERs from the reviewer comment. Then:
     ```
     chorus_pm_reject_proposal({
       proposalUuid: "<proposal-uuid>",
       reviewNote: "FAIL from reviewer. Fixing BLOCKERs: <list>"
     })
     ```
     Revise the drafts (`chorus_pm_update_document_draft`, `chorus_pm_update_task_draft`) to address each BLOCKER, then resubmit:
     ```
     chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
     ```
     After resubmission, the hook injects context again — spawn the reviewer yourself for Round 2.

3. **Max rounds:** Loop up to `maxProposalReviewRounds` (from plugin config, default 3). If exhausted:
   ```
   STOP: "Proposal review failed after {maxRounds} rounds. 
          Remaining BLOCKERs: <list>. Human review needed.
          Proposal UUID: <uuid>"
   ```

4. **No new VERDICT comment after reviewer returns?** The reviewer exhausted its `maxTurns` budget. Respawn it ONCE with a concise-budget hint: *"Stay within turn budget. Skip deep source verification. Fetch proposal + comments + idea only, skim for obvious BLOCKERs, and post your VERDICT within the first 10 turns."* If the second attempt still produces no VERDICT, treat the proposal as PASS WITH NOTES and proceed — the pipeline cannot loop forever on a silent reviewer.

---

### Phase 3: Task Execution (Wave-Based)

After proposal approval, tasks exist in `open` status. Execute them in dependency-ordered waves using Agent Teams. If team creation fails, fall back to main agent execution.

#### Primary: Agent Team (parallel)

```
wave = 1

loop:
  # 1. Find ready tasks
  unblocked = chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

  if no unblocked tasks and all tasks done:
    break  # All complete

  if no unblocked tasks and some tasks not done:
    # Stuck -- tasks failed review and can't proceed
    break with escalation report

  # 2. Try to create team for this wave
  TeamCreate({ team_name: "yolo-wave-{wave}" })

  # 3. Spawn a sub-agent for each unblocked task
  for each task in unblocked:
    Agent({
      name: "task-{short-title}",
      prompt: "Your Chorus task UUID: {task.uuid}\nProject UUID: {project-uuid}\n\nImplement the task per its description and acceptance criteria. Read the task, proposal, and project documents for context."
    })

  # 4. Wait for all sub-agents to complete
  #    Each sub-agent follows the /develop workflow:
  #    claim -> in_progress -> develop -> report -> self-check AC -> submit_for_verify
  #    PostToolUse hook injects context — main agent must spawn task-reviewer after submit_for_verify

  # 5. Proceed to Phase 4 (verification) for this wave
  wave += 1
```

**What the sub-agent prompt needs:**
- Task UUID(s)
- Project UUID
- NO session UUID, NO workflow boilerplate -- the plugin auto-injects everything via SubagentStart hook

#### Fallback: Main Agent (sequential)

If `TeamCreate` fails (e.g., Agent Teams not available, permission denied, or sub-agents crash repeatedly), fall back to executing tasks sequentially as the main agent:

```
for each task in unblocked:
  # Follow the /develop workflow directly as main agent
  chorus_claim_task({ taskUuid: "<task-uuid>" })
  chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })

  # ... implement the task: read context, write code, run tests ...

  chorus_report_work({ taskUuid: "<task-uuid>", report: "..." })
  chorus_report_criteria_self_check({ taskUuid: "<task-uuid>", criteria: [...] })
  chorus_submit_for_verify({ taskUuid: "<task-uuid>", summary: "..." })

  # PostToolUse hook injects context — you must spawn task-reviewer yourself
  # Proceed to Phase 4 verification for this task before moving to next
```

The fallback is slower (sequential, not parallel) but still completes the pipeline. The PostToolUse hook injects reviewer instructions the same way in both modes — you must always spawn the reviewer manually.

---

### Phase 4: Verification

After each wave's sub-agents complete, verify their tasks:

```
for each task in wave_tasks:
  # 1. Check task status
  task = chorus_get_task({ taskUuid: "<task-uuid>" })

  if task.status != "to_verify":
    # Sub-agent may have failed; skip or handle
    continue

  # 2. Spawn task-reviewer in FOREGROUND (hook injects context — you must spawn it yourself)
  #    Do NOT set run_in_background — you need the VERDICT before proceeding
  Agent({ subagent_type: "chorus:task-reviewer", prompt: "Review task <task-uuid>..." })

  # 3. Read task-reviewer VERDICT
  comments = chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
  # Find the most recent comment containing "VERDICT:"

  # 4. Act on VERDICT — three possible outcomes:
  if VERDICT is "PASS":
    # All AC verified, no issues. Mark AC and verify.
    chorus_mark_acceptance_criteria({
      taskUuid: "<task-uuid>",
      criteria: [
        { uuid: "<ac-uuid>", status: "passed", evidence: "<from reviewer>" },
        // ...
      ]
    })
    chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
    # Task is now "done" -- unblocks dependents

  if VERDICT is "PASS WITH NOTES":
    # All AC verified, minor non-blocking notes. Still mark AC and verify.
    chorus_mark_acceptance_criteria({ ... })
    chorus_admin_verify_task({ taskUuid: "<task-uuid>" })

  if VERDICT is "FAIL":
    # BLOCKERs found. Do NOT verify. Reopen for rework.
    chorus_admin_reopen_task({ taskUuid: "<task-uuid>" })
    # Task returns to "open", will be picked up in next wave
```

After verifying all tasks in the wave, return to Phase 3 to check for newly unblocked tasks.

**Max rounds per task:** Tracked by `maxTaskReviewRounds` from plugin config (default 3). If a task has been reopened `maxRounds` times, skip it and flag for human escalation:

```
ESCALATE: "Task '{title}' failed review after {maxRounds} rounds. 
           Last BLOCKERs: <list>. Manual intervention needed.
           Task UUID: <uuid>"
```

Continue with remaining tasks -- do not halt the entire pipeline for one stuck task.

**No new VERDICT comment after the task-reviewer returns?** It exhausted its `maxTurns` budget. Respawn it ONCE with a concise-budget hint: *"Stay within turn budget. Skip deep verification. Fetch task/proposal/comments, run only the core tests, and post your VERDICT within the first 12 turns."* If the second attempt also produces no VERDICT, treat as PASS WITH NOTES and proceed — do not loop indefinitely.

---

### Phase 5: Report

After all waves complete, output a markdown summary:

```markdown
## /yolo Complete

**Project:** <project-name> (<project-uuid>)
**Proposal:** <proposal-title> (<proposal-uuid>)
**Idea:** <idea-title> (<idea-uuid>)

### Tasks
| Task | Status | Review Rounds |
|------|--------|---------------|
| <title> | done | 1 |
| <title> | done | 2 |
| <title> | ESCALATED | 3 (max) |

### Summary
- Total tasks: N
- Completed: X / N
- Escalated: Y (need human review)
- Waves executed: W
```

---

### Phase 5b: Idea Completion Report (mandatory)

A successful `/yolo` run always finishes the Idea — call `chorus_create_report` once with `proposalUuid` set to the last verified proposal. The tool's description carries the section template; follow it. Surface the returned `documentUuid` in the Phase 5 summary. Skipping is a protocol violation.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Missing permissions at startup | Abort with message listing the missing resource/action pairs (see Prerequisites). Recommend an Admin-preset API key. |
| Project creation fails | Report error, suggest user create project manually and retry with `--project` |
| Proposal reviewer FAIL after maxRounds | Stop pipeline, report persisting BLOCKERs, suggest manual review |
| Task reviewer FAIL after maxRounds | Flag task as escalation-needed, continue with other tasks |
| Sub-agent crash / no submit | Log error, skip task, pick it up in next wave if possible |
| Ctrl+C | All entities persist in Chorus. User can resume via `/develop` or `/review` |

---

## Tips

- Keep the initial prompt detailed -- the more context you provide, the better the auto-generated proposal quality
- The proposal-reviewer is your quality gate -- if it keeps FAILing, the prompt may be too vague
- Watch the wave count -- if tasks keep getting reopened, consider Ctrl+C and manually reviewing the feedback
- All audit trail is preserved: elaboration Q&A, reviewer VERDICTs, work reports. Check Chorus UI for full history
- For small/simple tasks, consider `/quick-dev` instead -- it skips the Idea->Proposal overhead
- Sub-agents share your API key; ensure it has the permissions listed in Prerequisites before starting

---

## Next

- To manually review proposals: `/review`
- To manually develop tasks: `/develop`
- To create quick standalone tasks: `/quick-dev`
- For platform overview: `/chorus`
