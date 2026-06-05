---
name: yolo
description: Full-auto AI-DLC pipeline — from prompt to done. Automates the entire Idea -> Proposal -> Execute -> Verify lifecycle.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.4"
  category: project-management
  mcp_server: chorus
---

# Yolo Skill

Full-auto AI-DLC pipeline. User provides a prompt; agent drives the entire lifecycle: Idea -> Elaboration -> Proposal -> Review -> Execute -> Verify -> Done.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_pm_create_proposal`). Bare names are used below for readability — prepend `chorus__` when invoking. See `/chorus` for the full rule.

> **OpenClaw adaptations summarized (details inline below):** (1) elaboration is **self-answered as plain text** — no `AskUserQuestion`, no user interaction; (2) reviewers run **inline** after each submit — spawn a sub-agent with the OpenClaw `sessions_spawn` tool and tell it to run the `/proposal-reviewer` or `/task-reviewer` skill, with a read-only self-review fallback when `sessions_spawn` is unavailable; (3) sessions are **manual** if you dispatch sub-agents (no SubagentStart hook); (4) task execution is **sequential main-agent waves** — OpenClaw has no Agent Teams / `TeamCreate` primitive.

---

## Overview

`/yolo` automates the complete AI-DLC workflow. You provide a natural language description of what you want built, and the agent handles everything:

1. **Planning** -- create project, idea, self-elaboration, proposal with docs & tasks
2. **Proposal Review** -- proposal-reviewer adversarial loop
3. **Execution** -- sequential, dependency-ordered task execution by the main agent
4. **Verification** -- task-reviewer adversarial loop + admin verify
5. **Report** -- completion summary

```
/yolo <prompt>
       |
       v
  Project + Idea + Elaboration (self-answered) + Proposal
       |
       v
  Proposal Reviewer (inline, up to maxProposalReviewRounds)
       |
       v
  Admin Approve --> Tasks materialize
       |
       v
  Sequential wave execution (main agent: loop chorus_get_unblocked_tasks)
       |  (implement task + task-reviewer per task)
       v
  Admin Verify each task --> unblock next
       |
       v
  Done. Report summary.
```

**Escape hatch:** interrupt at any time. All created entities (project, idea, proposal, tasks) persist in Chorus. Resume manually via `/develop` or `/review`.

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

In /yolo mode, the agent generates elaboration questions and answers them itself -- **no user interaction at all**. There is no `AskUserQuestion` primitive on OpenClaw, and yolo deliberately does not prompt the user; it self-answers to preserve an audit trail without interrupting the run.

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

2. **Answer immediately** (agent selects best options based on the prompt — no user prompt):
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
     // roundUuid optional — defaults to the most recent answered round
   })
   ```

   > `chorus_pm_validate_elaboration` requires `idea:admin`. `/yolo` already mandates an Admin-preset key in Prerequisites, so this is satisfied. To open another self-elaboration round instead of resolving, just call `chorus_pm_start_elaboration` again.

#### Step 1.4: Create Proposal

1. **Detect OpenSpec mode (inline).** Load the `openspec-aware` skill and run its **§1 inline three-check detection** (`CHORUS_OPENSPEC_MODE != "off"`, an `openspec/` directory at the project root, and the `openspec` CLI on `PATH`).

   > **OpenClaw note:** there is no Claude Code SessionStart hook to precompute `CHORUS_OPENSPEC_ACTIVE`. You must run the three checks yourself, inline, here. This is mandatory — yolo runs unattended, so silently picking the wrong mode is exactly the failure scenario the detection contract exists to prevent.

   - All three checks pass → spec-driven branch (sub-step 2a below).
   - Any check fails (or `CHORUS_OPENSPEC_MODE=off`) → free-form branch (sub-step 2b below).

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

   **2a. OpenSpec mode (all three checks pass).** Follow `openspec-aware` §3 end-to-end:
   - Pick `$SLUG`, run `openspec new change "$SLUG"` (§3.1–§3.2).
   - Author `proposal.md`, `design.md`, and one `specs/<capability>/spec.md` per capability locally on disk (§3.3). ADDED Requirements only; per-spec fallback to free-form Markdown if MODIFIED/REMOVED is needed.
   - Define `json_encode_file`, `chorus_check_response` helpers (§3.4, §6).
   - Mirror each local file via `chorus-api.sh mcp-tool chorus_pm_add_document_draft "$PAYLOAD"` (§3.6) — one call per file, with the document type from `openspec-aware` §5.

   > **⛔ Do not** invoke `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_update_document` from the MCP harness with a hand-typed `content` field in this branch. Re-typing the markdown body wastes 20k+ tokens per proposal and breaks byte-equality with the local files. See `openspec-aware` §2 Rule 1.

   Then continue to step 3 (task drafts).

   **2b. Free-form mode (any check fails).** Add a tech design document draft directly via MCP, content authored inline:

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
   Immediately proceed to Phase 2 and run the proposal reviewer **inline** — OpenClaw has no PostToolUse hook to remind you.

---

### Phase 2: Proposal Review Loop

> **OpenClaw difference:** there is no PostToolUse hook injecting a "spawn the reviewer" reminder. Run the reviewer **inline**, right after `chorus_pm_submit_proposal`.

Obtain an independent VERDICT on the proposal:

- **Preferred — spawn a reviewer sub-agent.** Use the OpenClaw `sessions_spawn` tool to spawn a sub-agent whose `task` instructs it to **invoke the `/proposal-reviewer` skill** (bundled with this plugin) against the proposal, then wait for it (poll the `subagents` tool, or use `sessions_yield` — do **not** detach; you need the VERDICT before proceeding). The sub-agent inherits the plugin's skills, so `/proposal-reviewer` is available to it; that skill is read-only and ends with a `VERDICT:` comment on the proposal. Example task prompt:
  > `Run the /proposal-reviewer skill to review proposalUuid <uuid>. This is review round <N>. Read the proposal, its documents, the idea, and the elaboration; classify findings as BLOCKER/NOTE; post your VERDICT comment on the proposal when done.`
- **Fallback — review it yourself.** If `sessions_spawn` is unavailable (e.g. spawning disabled by policy), do the review yourself as a **focused, read-only pass** following the `/proposal-reviewer` skill's procedure (read proposal + comments + idea + elaboration; check doc completeness, task granularity, AC↔requirement coverage, the DAG, and integration checkpoints; classify BLOCKER/NOTE) and record the result via `chorus_add_comment` ending with a `VERDICT:` line. Do not modify drafts during the review pass.

Then:

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
     After resubmission, run the reviewer inline again for Round 2 (same as above).

3. **Max rounds:** Loop up to `maxProposalReviewRounds` (from plugin config, default 3). If exhausted:
   ```
   STOP: "Proposal review failed after {maxRounds} rounds.
          Remaining BLOCKERs: <list>. Human review needed.
          Proposal UUID: <uuid>"
   ```

4. **No new VERDICT comment after a spawned reviewer returns?** It exhausted its turn budget. Respawn it ONCE with a concise-budget hint: *"Stay within turn budget. Skip deep source verification. Fetch proposal + comments + idea only, skim for obvious BLOCKERs, and post your VERDICT within the first 10 turns."* If still no VERDICT, fall back to reviewing manually and post the VERDICT yourself — the pipeline cannot loop forever on a silent reviewer.

---

### Phase 3: Task Execution (Sequential Waves)

After proposal approval, tasks exist in `open` status. Execute them in dependency-ordered waves.

> **OpenClaw difference:** OpenClaw has **no Agent Teams / `TeamCreate` primitive**. Run waves **sequentially as the main agent**: loop `chorus_get_unblocked_tasks`, implement each ready task yourself, verify it, then loop again for the next wave. Do NOT call `TeamCreate` — it does not exist on OpenClaw. (Under the Claude Code plugin, each wave can be dispatched in parallel via `TeamCreate`; that is a Claude-Code-only optimization that degrades to the sequential loop here.)

```
wave = 1

loop:
  # 1. Find ready tasks (all dependencies done/closed)
  unblocked = chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

  if no unblocked tasks and all tasks done/closed:
    break  # All complete

  if no unblocked tasks and some tasks not done:
    # Stuck -- tasks failed review and can't proceed
    break with escalation report

  # 2. Implement each unblocked task, in order, AS THE MAIN AGENT:
  for each task in unblocked:
    chorus_claim_task({ taskUuid: task.uuid })
    chorus_update_task({ taskUuid: task.uuid, status: "in_progress" })

    # ... read task + proposal + project documents for context,
    #     write code, run tests ...

    chorus_report_work({ taskUuid: task.uuid, report: "...", status: "to_verify" })
    chorus_report_criteria_self_check({ taskUuid: task.uuid, criteria: [...] })
    chorus_submit_for_verify({ taskUuid: task.uuid, summary: "..." })

    # 3. Proceed to Phase 4 (verification) for THIS task before moving to the next.

  wave += 1
```

> **Optional sub-agent dispatch:** if your OpenClaw host supports generic worker sub-agents (not Agent Teams), you may hand one task to a sub-agent at a time. Because there is no SubagentStart hook, the worker prompt **must** include the manual session instructions explicitly — see `/develop` "Optional: sub-agent dispatch". The main agent still owns review + verification. This does not change the sequential, wave-by-wave structure above.

---

### Phase 4: Verification

After each task is submitted (Phase 3 step 3), verify it before moving on:

```
for the just-submitted task:
  # 1. Check task status
  task = chorus_get_task({ taskUuid: "<task-uuid>" })

  if task.status != "to_verify":
    # implementation may have failed; handle or skip
    continue

  # 2. Run the task-reviewer INLINE (no hook on OpenClaw):
  #    - Preferred: use the sessions_spawn tool to spawn a sub-agent whose task is
  #      "Run the /task-reviewer skill to verify taskUuid <uuid> (round <N>); post your
  #      VERDICT comment on the task when done." Wait for it (poll the subagents tool /
  #      sessions_yield — do NOT detach; you need the VERDICT). The sub-agent inherits the
  #      plugin skills, so /task-reviewer is available to it.
  #    - Fallback (sessions_spawn unavailable): review it yourself as a focused read-only
  #      pass following the /task-reviewer procedure (read task + proposal + docs + code,
  #      run read-only tests, classify findings BLOCKER/NOTE) and post the VERDICT via
  #      chorus_add_comment.

  # 3. Read task-reviewer VERDICT
  comments = chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
  # Find the most recent comment containing "VERDICT:"

  # 4. Act on VERDICT — three possible outcomes:
  if VERDICT is "PASS":
    chorus_mark_acceptance_criteria({
      taskUuid: "<task-uuid>",
      criteria: [
        { uuid: "<ac-uuid>", status: "passed", evidence: "<from reviewer>" },
        // ...
      ]
    })
    chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
    # Task is now "done" -- unblocks dependents for the next wave

  if VERDICT is "PASS WITH NOTES":
    chorus_mark_acceptance_criteria({ ... })
    chorus_admin_verify_task({ taskUuid: "<task-uuid>" })

  if VERDICT is "FAIL":
    # BLOCKERs found. Do NOT verify. Reopen for rework.
    chorus_admin_reopen_task({ taskUuid: "<task-uuid>" })
    # Fix the BLOCKERs in a later pass (the task returns to in_progress/open)
```

After verifying the wave's tasks, return to Phase 3's loop to pick up newly unblocked tasks. Remember: only `done` (not `to_verify`) unblocks dependents.

**Max rounds per task:** Tracked by `maxTaskReviewRounds` from plugin config (default 3). If a task has been reopened `maxRounds` times, skip it and flag for human escalation:

```
ESCALATE: "Task '{title}' failed review after {maxRounds} rounds.
           Last BLOCKERs: <list>. Manual intervention needed.
           Task UUID: <uuid>"
```

Continue with remaining tasks -- do not halt the entire pipeline for one stuck task.

**No new VERDICT comment after a spawned task-reviewer returns?** It exhausted its turn budget. Respawn it ONCE with a concise-budget hint: *"Stay within turn budget. Skip deep verification. Fetch task/proposal/comments, run only the core tests, and post your VERDICT within the first 12 turns."* If still no VERDICT, fall back to reviewing manually and post the VERDICT yourself — do not loop indefinitely.

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

> **OpenSpec archive:** if you ran in OpenSpec mode (Step 1.4 branch 2a), the last verified task also triggers the archive flow. OpenClaw has no PostToolUse hook to remind you — after verifying the final task, run `openspec-aware` §3.9 yourself (`openspec archive <slug> --yes`, then mirror each emitted `openspec/specs/<capability>/spec.md` back via §3.8).

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Missing permissions at startup | Abort with message listing the missing resource/action pairs (see Prerequisites). Recommend an Admin-preset API key. |
| Project creation fails | Report error, suggest user create project manually and retry with `--project` |
| Proposal reviewer FAIL after maxRounds | Stop pipeline, report persisting BLOCKERs, suggest manual review |
| Task reviewer FAIL after maxRounds | Flag task as escalation-needed, continue with other tasks |
| Task implementation fails / no submit | Log error, skip task, pick it up in next wave if possible |
| Reviewer sub-agent unavailable (`sessions_spawn` disabled) | Run the review yourself as a focused read-only pass following the `/proposal-reviewer` or `/task-reviewer` skill, then post the VERDICT |
| Interrupted | All entities persist in Chorus. User can resume via `/develop` or `/review` |

---

## Tips

- Keep the initial prompt detailed -- the more context you provide, the better the auto-generated proposal quality
- The proposal-reviewer is your quality gate -- if it keeps FAILing, the prompt may be too vague
- Watch the wave count -- if tasks keep getting reopened, consider stopping and reviewing the feedback manually
- All audit trail is preserved: elaboration Q&A, reviewer VERDICTs, work reports. Check Chorus UI for full history
- For small/simple tasks, consider `/quick-dev` instead -- it skips the Idea->Proposal overhead
- Sub-agents (if you dispatch any) share your API key; ensure it has the permissions listed in Prerequisites before starting

---

## Next

- To manually review proposals: `/review`
- To manually develop tasks: `/develop`
- To create quick standalone tasks: `/quick-dev`
- For platform overview: `/chorus`
