---
name: yolo-chorus
description: Full-auto AI-DLC pipeline — drive a single prompt from Idea through Proposal, Execution, and Verification to Done.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.9.4"
  category: project-management
  mcp_server: chorus
---

# Yolo Skill

Full-auto AI-DLC pipeline. The user provides one prompt; you drive the entire lifecycle: Idea -> Elaboration -> Proposal -> Review -> Execute -> Verify -> Done. No interactive prompts, no human in the loop unless the pipeline gets stuck.

This skill is **framework-neutral**: it never assumes a specific agent harness. Every reviewer and worker is described as "spawn a sub-agent" with a concrete example or two, and every step has an inline single-agent fallback so the pipeline still completes when sub-agents are unavailable.

---

## Overview

You take a natural-language description of what to build, and you handle everything:

1. **Planning** — resolve/create a project, create an Idea, self-elaborate, draft a Proposal (tech-design doc + task DAG), validate, submit.
2. **Proposal Review** — adversarial review loop against the `proposal-reviewer-chorus` skill.
3. **Execution** — dependency-ordered, wave-based task dispatch.
4. **Verification** — adversarial review loop against the `task-reviewer-chorus` skill + admin verify.
5. **Report** — completion summary + a mandatory Idea Completion Report.

```
<prompt>
   |
   v
Project + Idea + Self-Elaboration + Proposal
   |
   v
Proposal Review loop  (up to maxProposalReviewRounds, default 3)
   |   PASS / PASS WITH NOTES -> approve ;  FAIL -> reject + revise + resubmit
   v
Admin Approve  -->  Documents + Tasks materialize (tasks land in `open`)
   |
   v
Wave-based Execution  --  chorus_get_unblocked_tasks
   |   dispatch one worker sub-agent per unblocked task (fallback: sequential main agent)
   v
Verification loop  (up to maxTaskReviewRounds, default 3)
   |   PASS / PASS WITH NOTES -> mark AC + verify ;  FAIL -> reopen
   |   verify unblocks dependents -> loop back to Execution
   v
Done  -->  Report summary + mandatory Idea Completion Report
```

**Escape hatch:** Interrupt at any time. Every created entity (project, idea, proposal, tasks, comments) persists in Chorus. Resume manually via `develop-chorus` or `review-chorus`.

> **Base URL:** Skill files are hosted under `<BASE_URL>/skill/`. The user provides the Chorus access URL (e.g. `https://chorus.acme.com` or `http://localhost:8637`), referred to as `<BASE_URL>` below. See `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`) for platform overview and shared tools.

---

## Prerequisites

Yolo touches every resource and acts as PM, developer, AND admin. The API key MUST carry write + admin on the resources it drives:

| Needs | Why |
|-------|-----|
| `idea: [write]` | Create the Idea, run self-elaboration |
| `proposal: [write, admin]` | Create + submit the Proposal; approve it |
| `task: [write, admin]` | Create, execute, verify (and reopen) tasks |
| `project: [write]` | Create the project when none is supplied |

**Permission preflight — run this before doing anything else:**

```
perms = chorus_checkin().agent.permissions
need = { idea:    ["write"],
         proposal:["write", "admin"],
         task:    ["write", "admin"],
         project: ["write"] }

missing = []
for resource, actions in need:
  for a in actions:
    if a not in (perms[resource] or []):
      missing.append(f"{resource}:{a}")

if missing:
  ABORT "yolo requires the following permissions, which this API key lacks: "
        + ", ".join(missing)
        + ". Use an Admin-preset API key (all 15 permissions) and retry."
```

List **every** missing `resource:action` pair in the abort message — do not stop at the first one — so the user can fix the key in one pass. Do not silently degrade or skip phases when a permission is missing; abort cleanly.

---

## Input

```
<natural language prompt of what to build>
<prompt>   (with an optional existing-project hint, e.g. a project UUID or name)
```

- **prompt** — what you want built. Becomes the Idea content verbatim.
- **existing-project hint** (optional) — a project UUID or name to reuse instead of creating a new project. If absent, you search for a match and create one only when none fits.

Keep the prompt detailed: the richer the input, the better the auto-generated proposal, and the fewer review rounds it takes.

---

## Workflow

### Phase 1: Planning

#### Step 1.1: Resolve Project

**If the user supplied a project UUID:**

```
chorus_get_project({ projectUuid: "<uuid>" })
```

Confirm it exists and reuse it.

**Otherwise, search for a suitable existing project first:**

```
# Search by topic
chorus_search({ query: "<key terms from prompt>", entityTypes: ["project"] })
# Or list recent projects
chorus_list_projects()
```

If a project clearly matches the user's intent (same topic, active, relevant scope), reuse it. Only when no project fits, create one:

```
chorus_admin_create_project({
  name: "<short title derived from prompt>",
  description: "<1-2 sentence summary of the prompt>"
})
```

#### Step 1.2: Create the Idea

```
chorus_pm_create_idea({
  projectUuid: "<project-uuid>",
  title: "<concise title derived from prompt>",
  content: "<full user prompt, as-is>"
})
```

Then claim it so you own the elaboration:

```
chorus_claim_idea({ ideaUuid: "<idea-uuid>" })
```

#### Step 1.3: Self-Elaboration (no interactive prompts)

In yolo mode you generate the elaboration questions AND answer them yourself — there are NO interactive user prompts. This preserves a decision audit trail without interrupting anyone.

1. **Generate and submit questions:**

   ```
   chorus_pm_start_elaboration({
     ideaUuid: "<idea-uuid>",
     depth: "standard",
     questions: [
       {
         id: "q1",
         text: "<question about scope, architecture, data model, etc.>",
         category: "functional",
         options: [
           { id: "a", label: "<option A>" },
           { id: "b", label: "<option B>" }
         ]
       }
       // ... 5-8 questions covering functional, technical, and scope aspects
     ]
   })
   ```

2. **Answer immediately** — pick the option that best fits the prompt and record your rationale:

   ```
   chorus_answer_elaboration({
     ideaUuid: "<idea-uuid>",
     roundUuid: "<round-uuid>",
     answers: [
       { questionId: "q1", selectedOptionId: "a", customText: "Rationale: ..." }
       // ...
     ]
   })
   ```

3. **Resolve** — in YOLO mode the agent resolves elaboration **autonomously, with no human-confirmation gate** (the human-confirmation requirement that applies to the interactive idea flow is explicitly waived under `/yolo` automation):

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>"
     // roundUuid optional — defaults to the most recent answered round
   })
   ```

   > `chorus_pm_validate_elaboration` requires `idea:admin`. `/yolo` already mandates an Admin-preset key in Prerequisites, so this is satisfied. To open another self-elaboration round instead of resolving, just call `chorus_pm_start_elaboration` again.

#### Step 1.4: Create the Proposal

1. **Create the empty proposal container:**

   ```
   chorus_pm_create_proposal({
     projectUuid: "<project-uuid>",
     title: "<feature name>",
     description: "<summary derived from the elaborated idea>",
     inputType: "idea",
     inputUuids: ["<idea-uuid>"]
   })
   ```

2. **Add a tech-design document draft.** Capture architecture, data model, API surface, and module contracts (return formats, error patterns, call points) so each task draft can reference a single source of truth:

   ```
   chorus_pm_add_document_draft({
     proposalUuid: "<proposal-uuid>",
     type: "tech_design",
     title: "Tech Design: <feature>",
     content: "<markdown tech design: architecture, data model, API, module contracts>"
   })
   ```

3. **Add task drafts incrementally** and chain them into a `dependsOn` DAG with the returned `draftUuid` of each upstream draft. `acceptanceCriteriaItems` is **required** on every draft — at least one non-blank criterion, or the call is rejected. Each criterion must be objectively verifiable by a different agent:

   ```
   # First task
   result1 = chorus_pm_add_task_draft({
     proposalUuid: "<proposal-uuid>",
     title: "<module name>",
     description: "<what to build, referencing the tech design>",
     priority: "high",
     storyPoints: 3,
     acceptanceCriteriaItems: [
       { description: "<testable criterion>", required: true }
       // ...
     ]
   })

   # Second task depends on the first
   chorus_pm_add_task_draft({
     proposalUuid: "<proposal-uuid>",
     title: "<dependent module>",
     description: "...",
     priority: "medium",
     storyPoints: 2,
     acceptanceCriteriaItems: [ { description: "...", required: true } ],
     dependsOnDraftUuids: ["<result1.draftUuid>"]
   })
   ```

   > For a DAG of **4 or more tasks**, include at least one integration-checkpoint task whose AC requires end-to-end execution of the preceding modules together. The proposal reviewer treats a missing integration checkpoint as a BLOCKER, so add one up front.

4. **Validate** and fix any reported errors before submitting:

   ```
   chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

5. **Submit** for review:

   ```
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

   Proceed to Phase 2 — you drive the proposal review yourself; nothing reviews it automatically.

---

### Phase 2: Proposal Review Loop

Run an adversarial review on the submitted proposal using the **Independent Review pattern** (see below). Loop until the verdict allows approval or you exhaust `maxProposalReviewRounds`.

> **Independent Review pattern (framework-neutral).** Spawn a **read-only** sub-agent and have it load the `proposal-reviewer-chorus` skill (`<BASE_URL>/skill/proposal-reviewer-chorus/SKILL.md`), pass it the `proposalUuid` and the current review round number, and instruct it to post exactly one `VERDICT` comment on the proposal. The reviewer's only side effect is that comment; it makes no writes to your project. After it returns, read the verdict via `chorus_get_comments`.
>
> **The exact spawn mechanism is harness-specific** — these are EXAMPLES only, not a hard dependency:
> - Claude Code: dispatch a sub-agent with the Task/Agent tool, mounting the `proposal-reviewer-chorus` skill.
> - Codex: `spawn_agent` mounting the skill, then `wait_agent`; release the thread slot with `close_agent` afterwards.
> - Any other harness: whatever read-only sub-agent primitive it exposes.
>
> **Inline self-review fallback (no sub-agents available).** If your harness cannot spawn a sub-agent, perform the review inline as the main agent: read `proposal-reviewer-chorus`, follow its procedure against this proposal (fetch the proposal `section: "full"`, the idea, and the elaboration; audit documents and task drafts; classify findings as BLOCKER vs NOTE), and post your own `VERDICT` comment via `chorus_add_comment`. The verdict semantics below are identical in either mode.
>
> This is the canonical pattern; `chorus` (`<BASE_URL>/skill/chorus/SKILL.md`) documents it canonically — describe it inline here so yolo is self-contained.

**Review loop:**

```
round = 1
loop:
  # 1. Spawn the reviewer (Independent Review pattern above) with proposalUuid + round.
  #    Fallback: inline self-review as the main agent.

  # 2. Read the latest VERDICT comment.
  comments = chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
  # Find the most recent comment containing "VERDICT:".

  # 3. Act on the verdict (three outcomes).
```

1. **`VERDICT: PASS`** or **`VERDICT: PASS WITH NOTES`** — approve. Tasks and documents materialize automatically; proceed to Phase 3.

   ```
   chorus_admin_approve_proposal({
     proposalUuid: "<proposal-uuid>",
     reviewNote: "PASS from reviewer. <one-line summary of any NOTES>"
   })
   ```

2. **`VERDICT: FAIL`** — read the BLOCKERs from the reviewer comment, reject, revise, and resubmit:

   ```
   chorus_pm_reject_proposal({
     proposalUuid: "<proposal-uuid>",
     reviewNote: "FAIL from reviewer. Fixing BLOCKERs: <list>"
   })
   # Revise drafts to address each BLOCKER:
   #   chorus_pm_update_document_draft({ ... })
   #   chorus_pm_update_task_draft({ ... })
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   round += 1
   # Re-run the Independent Review for the next round (pass round = current number).
   ```

3. **Max rounds escalation.** Loop up to `maxProposalReviewRounds` (default **3**). If exhausted with unresolved BLOCKERs:

   ```
   STOP: "Proposal review failed after 3 rounds. Remaining BLOCKERs: <list>.
          Human review needed. Proposal UUID: <proposal-uuid>."
   ```

4. **No VERDICT comment after the reviewer returns?** The reviewer likely exhausted its turn budget. **Respawn it once** with a concise-budget hint: *"Stay within turn budget. Fetch the proposal + comments + idea only, skim for obvious BLOCKERs, and post your VERDICT within the first ~10 turns."* If the second attempt still posts no VERDICT, treat the proposal as **PASS WITH NOTES** and proceed — the pipeline must not loop forever on a silent reviewer.

---

### Phase 3: Execution (Wave-Based)

After approval, tasks exist in `open`. Execute them in dependency-ordered waves. A wave is the current set of unblocked tasks; verifying a wave (Phase 4) unblocks the next.

```
wave = 1
loop:
  # 1. Find tasks whose dependencies are all resolved (done/closed).
  unblocked = chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

  if no unblocked tasks and all tasks done:
    break   # pipeline complete

  if no unblocked tasks and some tasks not done:
    break with escalation report   # stuck: tasks failed review or are circularly blocked

  # 2. Dispatch one worker per unblocked task (see worker dispatch below).
  # 3. Wait for workers to reach `to_verify`.
  # 4. Run Phase 4 verification for this wave's tasks.
  wave += 1
  # 5. Loop: re-check chorus_get_unblocked_tasks for newly unblocked tasks.
```

**Worker dispatch (framework-neutral).** For each unblocked task, dispatch a worker sub-agent that follows the developer workflow (`develop-chorus`, `<BASE_URL>/skill/develop-chorus/SKILL.md`): claim -> in_progress -> implement -> report_work -> self-check AC -> submit_for_verify. The worker prompt needs:

- `taskUuid` (required)
- `projectUuid` (required, for context lookups)
- An explicit instruction to follow the `develop-chorus` skill and to exit after `chorus_submit_for_verify` so the main agent can run verification.

> **The spawn mechanism is harness-specific** — EXAMPLES only:
> - Claude Code: one sub-agent per task via the Task/Agent tool (parallel within the wave).
> - Codex: `spawn_agent` per task, then `wait_agent`; `close_agent` each worker after it returns.
> - Optionally create a `chorus_create_session` per worker for observability and `chorus_close_session` it when the worker finishes.

**Sequential main-agent fallback.** If sub-agents are unavailable, or parallel execution is impractical (rate limits, token budget, simpler debugging), execute each unblocked task yourself, sequentially, as the main agent:

```
for each task in unblocked:
  chorus_claim_task({ taskUuid: "<task-uuid>" })
  chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })
  # ... read context (task, proposal documents, upstream deps), implement, run tests ...
  chorus_report_work({ taskUuid: "<task-uuid>", report: "..." })
  chorus_report_criteria_self_check({ taskUuid: "<task-uuid>", criteria: [ ... ] })
  chorus_submit_for_verify({ taskUuid: "<task-uuid>", summary: "..." })
  # Then run Phase 4 verification for this task before moving on.
```

The fallback is slower (no parallelism) but completes the same pipeline.

---

### Phase 4: Verification Loop

After each wave's workers reach `to_verify`, verify their tasks using the **Independent Review pattern** — the same neutral mechanism as Phase 2, pointed at the `task-reviewer-chorus` skill.

> **Independent Review pattern (framework-neutral).** Spawn a **read-only** sub-agent and have it load the `task-reviewer-chorus` skill (`<BASE_URL>/skill/task-reviewer-chorus/SKILL.md`), pass it the `taskUuid` and the current review round number, and instruct it to post exactly one `VERDICT` comment on the task. The reviewer's only project side effect is that comment (it may run read-only tests/build/lint, but never writes). After it returns, read the verdict via `chorus_get_comments`.
>
> **The exact spawn mechanism is harness-specific** — EXAMPLES only:
> - Claude Code: dispatch a read-only sub-agent with the Task/Agent tool, mounting the `task-reviewer-chorus` skill.
> - Codex: `spawn_agent` mounting the skill, then `wait_agent`; `close_agent` afterwards to release the thread slot.
>
> **Inline self-review fallback (no sub-agents available).** Perform the review inline as the main agent: read `task-reviewer-chorus`, follow its procedure (fetch the task, its AC, comments, and the proposal `section: "documents"`; run the project's test/build/lint; verify each AC independently; classify BLOCKER vs NOTE), and post your own `VERDICT` comment via `chorus_add_comment`.

**Verification loop, per task in the wave:**

```
for each task in wave_tasks:
  t = chorus_get_task({ taskUuid: "<task-uuid>" })
  if t.status != "to_verify":
    continue   # worker did not submit; handle in a later wave or escalate

  # Spawn the task reviewer (Independent Review pattern) with taskUuid + round.
  # Fallback: inline self-review.

  comments = chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
  # Find the most recent comment containing "VERDICT:".
```

Act on the verdict — three outcomes:

1. **`VERDICT: PASS`** — all AC verified, no issues. Mark AC and verify:

   ```
   chorus_mark_acceptance_criteria({
     taskUuid: "<task-uuid>",
     criteria: [ { uuid: "<ac-uuid>", status: "passed", evidence: "<from reviewer>" } /* ... */ ]
   })
   chorus_admin_verify_task({ taskUuid: "<task-uuid>" })   # -> done, unblocks dependents
   ```

2. **`VERDICT: PASS WITH NOTES`** — minor, non-blocking notes only. Still mark AC and verify (same two calls as above).

3. **`VERDICT: FAIL`** — BLOCKERs found. Do NOT verify. Reopen for rework; the task returns to `in_progress` (its AC reset to pending) and is picked up in the next wave:

   ```
   chorus_admin_reopen_task({ taskUuid: "<task-uuid>" })
   chorus_add_comment({ targetType: "task", targetUuid: "<task-uuid>",
                        content: "Reopened. BLOCKERs to fix: <list>" })
   ```

**Max rounds escalation.** Track review rounds per task via `maxTaskReviewRounds` (default **3**). If a task has been reopened 3 times and still FAILs, skip it and flag for human escalation — do **not** halt the whole pipeline for one stuck task:

```
ESCALATE: "Task '<title>' failed review after 3 rounds. Last BLOCKERs: <list>.
           Manual intervention needed. Task UUID: <task-uuid>."
```

**No VERDICT comment after the reviewer returns?** It exhausted its turn budget. **Respawn it once** with a concise-budget hint: *"Stay within turn budget. Fetch the task/proposal/comments, run only the core tests, and post your VERDICT within the first ~12 turns."* If the second attempt still posts no VERDICT, treat as **PASS WITH NOTES** and proceed — do not loop indefinitely.

After verifying every task in the wave, return to **Phase 3** and re-run `chorus_get_unblocked_tasks` for newly unblocked tasks. Repeat until no tasks remain.

---

### Phase 5: Report

When all waves complete, output a markdown summary:

```markdown
## Yolo Complete

**Project:** <project-name> (<project-uuid>)
**Proposal:** <proposal-title> (<proposal-uuid>)
**Idea:** <idea-title> (<idea-uuid>)

### Tasks
| Task | Status | Review Rounds |
|------|--------|---------------|
| <title> | done      | 1 |
| <title> | done      | 2 |
| <title> | ESCALATED | 3 (max) |

### Summary
- Total tasks: N
- Completed: X / N
- Escalated: Y (need human review)
- Waves executed: W
- Idea Completion Report: <document-uuid>   (from Phase 5b)
```

---

### Phase 5b: Idea Completion Report (mandatory)

A successful yolo run always finishes the Idea. Call `chorus_create_report` **exactly once**, with `proposalUuid` set to the **last verified proposal**. The tool's own description carries the section template — follow it. Surface the returned `documentUuid` in the Phase 5 summary table. Skipping this is a protocol violation.

```
result = chorus_create_report({
  proposalUuid: "<last-verified-proposal-uuid>",
  // ... follow the tool description's section template ...
})
# Surface result.documentUuid in the Phase 5 summary.
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Missing permissions at startup | Abort, listing **every** missing `resource:action` pair (see Prerequisites). Recommend an Admin-preset API key. |
| Project creation fails | Report the error; suggest the user create the project manually and rerun with an existing-project hint. |
| Proposal review FAILs after `maxProposalReviewRounds` (3) | Stop the pipeline; report the persisting BLOCKERs; recommend manual review of the proposal. |
| Task review FAILs after `maxTaskReviewRounds` (3) | Flag the task as escalation-needed; continue with the other tasks. |
| Reviewer returns no VERDICT | Respawn the reviewer once with a concise-budget hint; if still none, treat as PASS WITH NOTES and proceed. |
| Worker crashes / never submits | Log it, leave the task non-`to_verify`; re-pick it in a later wave or escalate if it stays stuck. |
| No unblocked tasks but some not done | Stuck DAG (failed reviews or bad dependencies). Break with an escalation report; do not loop. |
| Sub-agents unavailable | Use the inline self-review fallback (reviews) and the sequential main-agent fallback (execution). |
| Interrupted mid-run | All entities persist in Chorus. Resume via `develop-chorus` or `review-chorus`. |

---

## Tips

- **Keep the prompt detailed** — richer input yields a stronger proposal and fewer review rounds.
- **The proposal reviewer is your quality gate** — repeated FAILs usually mean the prompt is too vague; tighten it and rerun.
- **Watch the wave count** — if tasks keep getting reopened, interrupt and inspect the reviewer feedback before continuing.
- **Prefer sub-agents when available** — a fresh read-only reviewer is more adversarial than reviewing your own output inline; use the inline fallback only when you must.
- **Everything is audited** — elaboration Q&A, reviewer VERDICTs, work reports, and approvals all persist; inspect the Chorus UI for the full history.
- **For small, single-step work**, prefer `quick-dev-chorus` (`<BASE_URL>/skill/quick-dev-chorus/SKILL.md`) — it skips the Idea -> Proposal overhead.
- **Sub-agents share your API key** — confirm it carries the Prerequisites permissions before starting.

---

## Next

- To create proposals manually: `proposal-chorus` skill (`<BASE_URL>/skill/proposal-chorus/SKILL.md`)
- To develop tasks manually: `develop-chorus` skill (`<BASE_URL>/skill/develop-chorus/SKILL.md`)
- To review proposals and verify tasks manually: `review-chorus` skill (`<BASE_URL>/skill/review-chorus/SKILL.md`)
- For platform overview and shared tools: `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`)
