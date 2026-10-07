---
name: yolo
description: Full-auto AI-DLC pipeline in Hermes — from prompt to done. Automates the entire Idea -> Proposal -> Execute -> Verify lifecycle, with delegate_task wave execution and read-only delegate_task reviewers.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.22.0"
  category: project-management
  mcp_server: chorus
---

# Yolo Skill

Full-auto AI-DLC pipeline. User provides a prompt; agent drives the entire lifecycle: Idea -> Elaboration -> Proposal -> Review -> Execute -> Verify -> Done.

---

## Overview

Yolo automates the complete AI-DLC workflow. You provide a natural language description of what you want built, and the agent handles everything:

1. **Planning** -- create project, idea, self-elaboration, proposal with docs & tasks
2. **Proposal Review** -- proposal-reviewer adversarial loop
3. **Execution** -- wave-based parallel task dispatch via `delegate_task(tasks=[...])`
4. **Verification** -- task-reviewer adversarial loop + admin verify
4.5. **Code-Review Gateway** -- code-reviewer reviews the Idea's aggregate change before ship (FAIL → add fix tasks → re-run)
5. **Report** -- completion summary

```
yolo: <prompt>
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
  Wave-based delegate_task parallel execution
       |  (dev agent + task-reviewer per task)
       v
  Admin Verify each wave --> unblock next
       |
       v
  Code-Review Gateway (auto, up to CHORUS_MAX_CODE_REVIEW_ROUNDS; default 3, 0 = unlimited)
       |  PASS --> ship   |   FAIL --> add fix tasks --> re-run
       v
  Done. Report summary.
```

**Escape hatch:** Ctrl+C at any time. All created entities (project, idea, proposal, tasks) persist in Chorus. Resume manually via `skill_view("chorus:develop")` or `skill_view("chorus:review")`.

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
  if missing: ABORT "yolo needs {resource}: {missing}. Use an Admin-preset API key."
```

---

## Input

The user asks for a yolo run in chat (load this skill with `skill_view("chorus:yolo")`):

```
yolo: <natural language prompt>
yolo: <prompt> --project <project-uuid>
```

- `<prompt>` -- what you want built (becomes the Idea content)
- `--project <uuid>` -- optional; use an existing project instead of creating a new one

---

## Research routing

During planning, follow the Idea and Proposal routes in the research skill (`skill_view("chorus:research")`, which also holds the shared rules): Idea before formal clarification once focused, Proposal after reusing evidence and only for new gaps or an explicit request. Carry findings and the request context across wakes and brainstorm; do not restart the same investigation on resume. Preserve the existing yolo decision/review gates. A Tracker Research action is research-only even inside a yolo-associated conversation: use the Idea research-only branch, save/report, and return without advancing to elaboration, proposal submission, or development. A yolo request alone does not prove development started; use actual execution facts.

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

In yolo mode, the agent generates elaboration questions and answers them itself -- it does not list them in chat and does not @mention the owner for answers. This preserves an audit trail without interrupting the user.

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
       // ... 5-8 questions covering functional, technical_context, scope aspects
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

3. **Resolve** — in YOLO mode the agent resolves elaboration **autonomously, with no human-confirmation gate** (the human-confirmation requirement that applies to the interactive idea flow (`skill_view("chorus:idea")`) is explicitly waived under yolo automation):

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>"
   })
   ```

   > `chorus_pm_validate_elaboration` requires `idea:admin`. Yolo already mandates an Admin-preset key in Prerequisites, so this is satisfied. To open another self-elaboration round instead of resolving, just call `chorus_pm_start_elaboration` again.

#### Step 1.4: Create Proposal

1. **Read the spec mode (already computed).** The Chorus Hermes plugin's `pre_llm_call` session-start check-in (`spec_mode.py`) has already resolved it — do NOT re-derive. Read the `## Spec Mode` section: `CHORUS_SPEC_MODE=<lite|openspec|off>` + a routing note. Act on it: `openspec` (usable, shows `CHORUS_OPENSPEC_ACTIVE=1`) → **2a**; `off` → **2b**; `lite` → **2c**. If it says the mode **cannot be honored** (explicit `openspec` but unusable), **halt** and surface it — do NOT fall back or enter 2a with no OpenSpec. (No `## Spec Mode`? See `openspec-aware` §1 manual fallback.) This matters because yolo runs unattended.

2. **Create the empty proposal container.** The `description` MUST carry the mode's locator line — OpenSpec: `OpenSpec change slug: <slug>`; spec-lite: `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`; free-form: none. `description` is only settable at creation, so decide the slug/dated-path first.

   ```
   chorus_pm_create_proposal({
     projectUuid: "<project-uuid>",
     title: "<feature name>",
     description: "<summary>\n\nOpenSpec change slug: <slug>",                          // OpenSpec (2a)
     // description: "<summary>\n\nSpec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/", // spec-lite (2c)
     // description: "<summary>",                                                        // free-form (2b)
     inputType: "idea",
     inputUuids: ["<idea-uuid>"]
   })
   ```

   Then branch:

   **2a. OpenSpec mode (`CHORUS_OPENSPEC_ACTIVE=1`).** Follow `openspec-aware` (`skill_view("chorus:openspec-aware")`) §3 end-to-end:
   - Pick `$SLUG`, run `openspec new change "$SLUG"` (§3.1–§3.2).
   - Author `proposal.md`, `design.md`, and one `specs/<capability>/spec.md` per capability locally on disk (§3.3). ADDED Requirements only; per-spec fallback to free-form Markdown if MODIFIED/REMOVED is needed.
   - Define the `chorus_check_response` helper (§6); use `chorus mcp call … --arg-file content=<file>` via `terminal` for mirrors (§3.4/§3.6). Only when `chorus` is not on `PATH`, fall back to the native MCP tool with the `read_file` text verbatim (`openspec-aware` §2 Rule 1).
   - Mirror each local file via `chorus mcp call chorus_pm_add_document_draft … --arg-file content=<file>` (§3.6; fallback = native `mcp__chorus__chorus_pm_add_document_draft` with the file text) — one call per file, with the document type from `openspec-aware` §5.

   > **⛔ Do not** invoke `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_update_document` as native MCP calls with a hand-typed `content` field in this branch. Re-typing the markdown body wastes 20k+ tokens per proposal and breaks byte-equality with the local files. See `openspec-aware` §2 Rule 1.

   Then continue to step 3 (task drafts).

   **2b. Free-form mode (resolved mode = free-form).** Only when step 1 resolved to free-form — i.e. explicit `CHORUS_SPEC_MODE=off` (unset never comes here: it resolves to OpenSpec when usable, else spec-lite/2c). Add a tech design document draft directly via MCP, content authored inline:

   ```
   chorus_pm_add_document_draft({
     proposalUuid: "<proposal-uuid>",
     type: "tech_design",
     title: "Tech Design: <feature>",
     content: "<markdown tech design covering architecture, data model, API, module contracts>"
   })
   ```

   **2c. spec-lite mode (resolved mode = lite).** Load the `spec-lite` skill (`skill_view("chorus:spec-lite")`). Pick `$SLUG` (a **capability**). Ensure the durable `.chorus/specs/<slug>/spec.md` exists (local-only, no ids; use the `spec-lite` skill's inline durable-spec template) and update it in place. Create this change's **dated folder** `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` with its **synced** Chorus-typed docs (shape = the `spec-lite` skill's inline dated-folder document template) — `prd.md` (primary), optional `tech_design.md`… The `description` carries the `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` locator (step 2). Mirror **each** dated-folder `<type>.md` to its persistent Document byte-exact — first time `chorus mcp call chorus_pm_add_document_draft "{\"proposalUuid\":\"<uuid>\",\"type\":\"prd\",\"title\":\"PRD: <feature>\"}" --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/prd.md`, later edits via `chorus_pm_update_document` against the recorded `documentUuid` (native-tool fallback with the `read_file` text when `chorus` is not on `PATH`). **`spec.md` is never mirrored.** No `openspec/changes/` scaffold; no `tasks.md`. Then continue to step 3.

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
   After this call, the Chorus Hermes plugin's `transform_tool_result` reminder tells you to spawn the proposal reviewer. You MUST spawn it yourself with `delegate_task` (Reviewer contract below) — it is NOT auto-launched.

---

### Reviewer contract (applies to every review gate below)

Every gate in Phases 2, 4 and 4.5 follows the same three steps. They are written once here; the phases below only name their entity and their stage-specific actions.

1. **Spawn and wait.** Spawn the reviewer as a read-only `delegate_task` child. The call blocks until the child returns, so there is nothing to track or close. Read the verdict from the reviewer's `VERDICT:` comment on the entity — the verdict is that comment, not the child's returned summary.
   - The `context` MUST start with the marker `[chorus-reviewer:<kind>]` (kind = `proposal` | `task` | `code`), and the `goal` should carry it too. The Chorus Hermes plugin keys on it to run the child read-only: Chorus write tools other than `chorus_add_comment` are blocked, and so are `write_file`, `patch`, `terminal`, `execute_code`, and `delegate_task`.
   - The child starts with an isolated context. Put everything it needs in `context`: `skill_view("chorus:chorus-<kind>-reviewer")` as its first step, the entity UUID, the max review rounds, the repo path, and (for task and code reviews) the evidence bundle paths.
   - **Evidence bundle (task and code reviews).** The reviewer cannot run commands, so YOU build the evidence first and pass absolute paths. For example, under `/tmp/chorus-review/<uuid>/`: `git diff $BASE...HEAD > diff.patch` (plus `git diff` of uncommitted changes and `git status --short` if workers did not commit), `git log --oneline $BASE..HEAD > log.txt`, and the project's test/build output (`<test command> > tests.txt 2>&1`). `$BASE` is the commit you recorded at the start of Phase 3.

   ```
   delegate_task(
     goal="[chorus-reviewer:task] Review Chorus task <task-uuid> and post one VERDICT comment.",
     context="[chorus-reviewer:task]\nFirst call skill_view(\"chorus:chorus-task-reviewer\") and follow it.\nTask UUID: <task-uuid>\nMax review rounds: 3\nRepo: <abs repo path>\nEvidence: /tmp/chorus-review/<task-uuid>/diff.patch, /tmp/chorus-review/<task-uuid>/log.txt, /tmp/chorus-review/<task-uuid>/tests.txt",
   )
   ```
2. **Read THIS round's VERDICT.** Call `chorus_get_comments` on the entity and find the `VERDICT:` comment posted **after your dispatch**, not an older round's. Do not advance the gate before you have read it.
3. **No VERDICT for this round?** Check what the reviewer *did* post:
   - **A reported round limit, or any other explicit refusal to review** — a deliberate escalation to a human. STOP: do not respawn, do not self-review, do not post a VERDICT of your own.
   - **Nothing at all** — respawn ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you review the entity yourself as a read-only pass and POST the VERDICT, then proceed on what you posted rather than looping forever.

**Absence is never a PASS**, and a round limit reached by someone else is never yours to clear. (A reviewer never writes files or runs commands; if it reports that the evidence is missing or unreadable, rebuild the bundle and respawn — that is a retry, not a self-review.)

---

### Phase 2: Proposal Review Loop

After `chorus_pm_submit_proposal`, the Chorus Hermes plugin's `transform_tool_result` reminder tells you to spawn the proposal reviewer. Spawn it yourself as a read-only `delegate_task` child (no evidence bundle is needed for a proposal review — it reads the drafts from Chorus):

```
delegate_task(
  goal="[chorus-reviewer:proposal] Review Chorus proposal <proposal-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:proposal]\nFirst call skill_view(\"chorus:chorus-proposal-reviewer\") and follow it.\nProposal UUID: <proposal-uuid>\nMax review rounds: 3\nRepo: <abs repo path>\nRead existing comments first to determine the round number; post the VERDICT as a comment.",
)
```

`delegate_task` returns when the reviewer finishes. Then:

1. **Read the reviewer's VERDICT:**
   ```
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```
   Look for THIS round's `VERDICT:` comment — the one posted after your dispatch, not an older round's.

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
     After resubmission, the plugin's reminder appears again — spawn the reviewer yourself for Round 2.

3. **Max rounds:** Loop up to `maxProposalReviewRounds` (default 3; pass the same value as `Max review rounds` in the reviewer's `context`). If exhausted:
   ```
   STOP: "Proposal review failed after {maxRounds} rounds.
          Remaining BLOCKERs: <list>. Human review needed.
          Proposal UUID: <uuid>"
   ```

4. **No new VERDICT for this round?** Apply step 3 of the **Reviewer contract**, reviewing the proposal yourself if the reviewer stays silent.

---

### Phase 3: Task Execution (Wave-Based)

After proposal approval, tasks exist in `open` status. Execute them in dependency-ordered waves using `delegate_task` workers. If delegation fails, fall back to main agent execution.

Before the first wave, record the base commit for the review evidence bundles: `BASE=$(git rev-parse HEAD)` (via `terminal`).

#### Primary: `delegate_task` parallel dispatch (wave-based)

One wave is **one** `delegate_task(tasks=[...])` call with one child per unblocked task. The call **blocks** until every child finishes and returns each child's final summary — there is no id to track and no close step. The batch size is capped by `delegation.max_concurrent_children` in `~/.hermes/config.yaml`; if a wave has more ready tasks than the cap, split it into several consecutive calls.

Children start with an **isolated context** — they know nothing of this conversation. They inherit your toolsets (including the Chorus MCP tools), so everything they need goes in `context`. Chorus sessions for workers are **not** auto-created on Hermes: for observability, you (the parent) create one Chorus session per worker before the call and close it after the call returns. You, the main agent, use no session yourself.

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

  # 2. One Chorus session per worker (reuse a closed one when its name matches:
  #    chorus_list_sessions -> chorus_reopen_session; otherwise create).
  for each task in unblocked:
    session[task] = chorus_create_session({ name: "yolo-w{wave}-{short task title}" })

  # 3. Dispatch the whole wave as ONE blocking batch (split into several calls
  #    if it exceeds delegation.max_concurrent_children).
  delegate_task(tasks=[
    { "goal": "Implement Chorus task {task.uuid}: {task.title}",
      "context": """First call skill_view("chorus:develop") and follow it.
Task UUID: {task.uuid}
Project UUID: {project-uuid}
Repo: {abs repo path}
Chorus sessionUuid: {session[task].uuid}
Spec Mode: {copy the CHORUS_SPEC_MODE / CHORUS_OPENSPEC_ACTIVE lines of your ## Spec Mode section}

Implement the task per its description and acceptance criteria. Read the task,
proposal, and project documents for context.
Session workflow: chorus_session_checkin_task({sessionUuid, taskUuid}) first;
pass sessionUuid to chorus_update_task (status in_progress) and to every
chorus_report_work; self-check every AC with chorus_report_criteria_self_check;
chorus_session_checkout_task at the end; then chorus_submit_for_verify.
Do NOT spawn reviewers, verify, or reopen tasks -- the parent does that.
Return a short summary: files changed, tests run, and anything left open.""" },
    # ... one entry per unblocked task in this wave
  ])
  # Returns when every worker in the wave has finished. Each worker follows the
  # develop workflow: claim -> in_progress -> report -> self-check AC
  # -> submit_for_verify (leaving its task at to_verify).
  # For a single ready task: delegate_task(goal="...", context="...").

  # 4. Close the wave's worker sessions
  for each task in unblocked:
    chorus_close_session({ sessionUuid: session[task].uuid })

  # 5. Proceed to Phase 4 (verification) for this wave
  wave += 1
```

> Workers in one wave share the same working tree. Keep the dependency DAG honest so tasks in one wave touch disjoint areas, and have each worker report the files it changed — you need that list to scope each task's evidence bundle in Phase 4.

**What each worker's `context` needs:**
- Task UUID + Project UUID + absolute repo path
- The instruction to `skill_view("chorus:develop")` first
- Its Chorus `sessionUuid` (parent-created) and the session check-in / check-out steps
- The resolved `## Spec Mode` lines (children start with an isolated context and may not see it; `openspec-aware` §1)
- Nothing to track or close on your side except the session — `delegate_task` owns the child's lifecycle


#### Fallback: Main Agent (sequential)

If `delegate_task` is unavailable or its workers fail repeatedly (e.g., delegation is disabled in the Hermes config, permission denied, or the children crash), fall back to executing tasks sequentially as the main agent:

```
for each task in unblocked:
  # Follow the develop workflow (skill_view("chorus:develop")) directly as main agent
  chorus_claim_task({ taskUuid: "<task-uuid>" })
  chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })

  # ... implement the task: read context, write code, run tests ...

  chorus_report_work({ taskUuid: "<task-uuid>", report: "..." })
  chorus_report_criteria_self_check({ taskUuid: "<task-uuid>", criteria: [...] })
  chorus_submit_for_verify({ taskUuid: "<task-uuid>", summary: "..." })

  # the plugin's reminder appears — you must spawn the task reviewer yourself
  # Proceed to Phase 4 verification for this task before moving to next
```

The fallback is slower (sequential, not parallel) but still completes the pipeline. The Chorus Hermes plugin appends its reviewer reminder the same way in both modes — you must always spawn the reviewer manually.

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

  # 2. Build the evidence bundle (terminal), then spawn the task reviewer
  #    (the plugin's reminder tells you to; you must spawn it yourself)
  #    /tmp/chorus-review/<task-uuid>/diff.patch  <- git diff $BASE (scoped to
  #        the files the worker reported) + git status --short
  #    /tmp/chorus-review/<task-uuid>/log.txt     <- git log --oneline $BASE..HEAD
  #    /tmp/chorus-review/<task-uuid>/tests.txt   <- project test/build output
  delegate_task(
    goal="[chorus-reviewer:task] Review Chorus task <task-uuid> and post one VERDICT comment.",
    context="[chorus-reviewer:task]\nFirst call skill_view(\"chorus:chorus-task-reviewer\") and follow it.\nTask UUID: <task-uuid>\nMax review rounds: 3\nRepo: <abs repo path>\nEvidence: /tmp/chorus-review/<task-uuid>/diff.patch, /tmp/chorus-review/<task-uuid>/log.txt, /tmp/chorus-review/<task-uuid>/tests.txt",
  )
  #    Reviewers for several tasks of one wave may run as one batch,
  #    delegate_task(tasks=[...]), as long as EACH child's context starts with
  #    its own [chorus-reviewer:task] marker.

  # 3. Read task-reviewer VERDICT
  comments = chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
  # Find THIS round's "VERDICT:" comment — the one posted after your dispatch, not an older round's

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

**Max rounds per task:** Tracked by `maxTaskReviewRounds` (default 3; pass it as `Max review rounds` in the reviewer's `context`). If a task has been reopened `maxRounds` times, skip it and flag for human escalation:

```
ESCALATE: "Task '{title}' failed review after {maxRounds} rounds.
           Last BLOCKERs: <list>. Manual intervention needed.
           Task UUID: <uuid>"
```

Continue with remaining tasks -- do not halt the entire pipeline for one stuck task.

**No new VERDICT for this round?** Apply step 3 of the **Reviewer contract**, reviewing the task yourself if the reviewer stays silent.

---

### Phase 4.5: Code-Review Gateway (mandatory pre-ship)

Once **every** task of the idea's proposal is verified (`done`) — i.e. Phase 3 finds no more unblocked tasks and all are terminal — run the final ship-time code-review gateway **before** declaring the Idea done and **before** the Phase 5b completion report. After the last task is verified, the Chorus Hermes plugin's `transform_tool_result` reminder on `chorus_admin_verify_task` (its code-review gateway branch) tells you to spawn the code reviewer; you MUST spawn it yourself as a read-only `delegate_task` child. (When the change is an OpenSpec proposal, the same result also carries the OpenSpec archive reminder — perform that archive per `openspec-aware` §3.9 before the code review; it is a reminder only, the plugin archives nothing.)

```
# Spawn the code-reviewer for the IDEA (not a task). Determine the round
# number by reading prior code-review VERDICT comments on the idea.
# Build the aggregate evidence bundle first (terminal):
#   /tmp/chorus-review/<idea-uuid>/diff.patch  <- git diff $BASE...HEAD (+ uncommitted)
#   /tmp/chorus-review/<idea-uuid>/log.txt     <- git log --oneline $BASE..HEAD
#   /tmp/chorus-review/<idea-uuid>/tests.txt   <- full project test/build output
delegate_task(
  goal="[chorus-reviewer:code] Review aggregate code for idea <idea-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:code]\nFirst call skill_view(\"chorus:chorus-code-reviewer\") and follow it.\nIdea UUID: <idea-uuid>\nProposal UUID: <proposal-uuid>\nRound: N\nRepo: <abs repo path>\nEvidence: /tmp/chorus-review/<idea-uuid>/diff.patch, /tmp/chorus-review/<idea-uuid>/log.txt, /tmp/chorus-review/<idea-uuid>/tests.txt",
)

# Read its VERDICT on the idea
comments = chorus_get_comments({ targetType: "idea", targetUuid: "<idea-uuid>" })
# Find THIS round's "VERDICT:" comment — the one posted after your dispatch, not an older round's
```

Act on the VERDICT:

- **PASS** / **PASS WITH NOTES** — the feature is cleared to ship. Proceed to Phase 5 / 5b.
- **FAIL** — do NOT ship. Read the BLOCKERs, then fix them via the **quick-dev** workflow (`skill_view("chorus:quick-dev")`): call `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** so the fix tasks attach to it — do **not** reopen the already-verified tasks. Group related small BLOCKERs into one cohesive task by default; split only materially large or independently testable fixes. Drive every fix task through Phase 3 → Phase 4, including AC self-check, independent task review, and admin verification. Re-spawn the code-reviewer only after every fix task is successfully `done`; a failed or cancelled fix task, stop the automatic loop and escalate. Loop bounded by the `maxCodeReviewRounds` setting (`CHORUS_MAX_CODE_REVIEW_ROUNDS`, default 3; 0 = unlimited). Rebuild the aggregate evidence bundle before every re-review round.

```
# Max rounds escalation
ESCALATE: "Idea '<title>' failed code review after {CHORUS_MAX_CODE_REVIEW_ROUNDS} rounds.
           Last BLOCKERs: <list>. Manual intervention needed. Idea UUID: <uuid>"
```

**No new VERDICT for this round?** Apply step 3 of the **Reviewer contract**, reviewing the idea's aggregate change yourself if the reviewer stays silent.

> The code-review gateway is **behavioral**, consistent with the proposal/task reviewers: its verdict is advisory and does not change the Idea's stored status. The yolo orchestrator honors it — PASS to ship, FAIL to loop. It runs **before** the completion report so the report is never written for a feature with an outstanding FAIL.

---

### Phase 5: Report

After all waves complete, output a markdown summary:

```markdown
## Yolo Complete

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

A successful yolo run always finishes the Idea — call `chorus_create_report` once with `proposalUuid` set to the last verified proposal. The call requires `title` (a short report title) plus `content`; `content`'s parameter description carries the three-section template (`## Summary` / `## Decisions` / `## Follow-ups`); follow it. Surface the returned `documentUuid` in the Phase 5 summary. Skipping is a protocol violation.

> **Order:** the completion report is written only **after** the Phase 4.5 code-review gateway returns PASS / PASS WITH NOTES. Never write it while a code-review FAIL is outstanding — the report is a ship-time summary, and the gateway is what clears the feature to ship.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Missing permissions at startup | Abort with message listing the missing resource/action pairs (see Prerequisites). Recommend an Admin-preset API key. |
| Project creation fails | Report error, suggest user create project manually and retry with `--project` |
| Proposal reviewer FAIL after maxRounds | Stop pipeline, report persisting BLOCKERs, suggest manual review |
| Task reviewer FAIL after maxRounds | Flag task as escalation-needed, continue with other tasks |
| Code-review gateway FAIL after CHORUS_MAX_CODE_REVIEW_ROUNDS rounds | Stop before ship, escalate the persisting feature-level BLOCKERs to a human (Idea UUID), do not write the completion report |
| Sub-agent crash / no submit | Log error, close its Chorus session, skip task, pick it up in next wave if possible |
| Reviewer reports missing evidence | Rebuild the evidence bundle under `/tmp/chorus-review/<uuid>/` and respawn the reviewer (counts as the one retry) |
| Ctrl+C | All entities persist in Chorus. User can resume via `skill_view("chorus:develop")` or `skill_view("chorus:review")` |

---

## Tips

- Keep the initial prompt detailed -- the more context you provide, the better the auto-generated proposal quality
- The proposal-reviewer is your quality gate -- if it keeps FAILing, the prompt may be too vague
- Watch the wave count -- if tasks keep getting reopened, consider Ctrl+C and manually reviewing the feedback
- All audit trail is preserved: elaboration Q&A, reviewer VERDICTs, work reports. Check Chorus UI for full history
- For small/simple tasks, consider quick-dev (`skill_view("chorus:quick-dev")`) instead -- it skips the Idea->Proposal overhead
- Sub-agents inherit your toolsets and therefore your Chorus API key; ensure it has the permissions listed in Prerequisites before starting
- Yolo runs unattended in a gateway (Chorus-woken) session too: it never asks the owner anything, so it does not end the turn waiting for a reply

---

## Next

- To manually review proposals: `skill_view("chorus:review")`
- To manually develop tasks: `skill_view("chorus:develop")`
- To create quick standalone tasks: `skill_view("chorus:quick-dev")`
- For platform overview: `skill_view("chorus:chorus")`
