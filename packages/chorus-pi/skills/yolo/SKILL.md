---
name: yolo
description: Full-auto AI-DLC pipeline — from prompt to done. Automates the entire Idea -> Proposal -> Execute -> Verify lifecycle.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.23.2"
  category: project-management
  mcp_server: chorus
---

# Yolo Skill

Full-auto AI-DLC pipeline. User provides a prompt; agent drives the entire lifecycle: Idea -> Elaboration -> Proposal -> Review -> Execute -> Verify -> Done.

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

`/yolo` automates the complete AI-DLC workflow. You provide a natural language description of what you want built, and the agent handles everything:

1. **Planning** -- create project, idea, self-elaboration, proposal with docs & tasks
2. **Proposal Review** -- proposal-reviewer adversarial loop
3. **Execution** -- wave-based Agent Team parallel task dispatch
4. **Verification** -- task-reviewer adversarial loop + admin verify
4.5. **Code-Review Gateway** -- code-reviewer reviews the Idea's aggregate change before ship (FAIL → add fix tasks → re-run)
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
  Code-Review Gateway (auto, up to CHORUS_MAX_CODE_REVIEW_ROUNDS; default 3, 0 = unlimited)
       |  PASS --> ship   |   FAIL --> add fix tasks --> re-run
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

## Research routing

During planning, follow the Idea and Proposal routes to `/skill:research` ([shared rules](../research/SKILL.md)): Idea before formal clarification once focused, Proposal after reusing evidence and only for new gaps or an explicit request. Carry findings and the request context across wakes and brainstorm; do not restart the same investigation on resume. Preserve the existing yolo decision/review gates. A Tracker Research action is research-only even inside a yolo-associated conversation: use the Idea research-only branch, save/report, and return without advancing to elaboration, proposal submission, or development. A yolo request alone does not prove development started; use actual execution facts.

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

3. **Resolve** — in YOLO mode the agent resolves elaboration **autonomously, with no human-confirmation gate** (the human-confirmation requirement that applies to the interactive `/idea` flow is explicitly waived under `/yolo` automation):

   ```
   chorus_pm_validate_elaboration({
     ideaUuid: "<idea-uuid>"
   })
   ```

   > `chorus_pm_validate_elaboration` requires `idea:admin`. `/yolo` already mandates an Admin-preset key in Prerequisites, so this is satisfied. To open another self-elaboration round instead of resolving, just call `chorus_pm_start_elaboration` again.

#### Step 1.4: Create Proposal

1. **Read the spec mode (already computed).** The chorus-pi extension's `session_start` handler (`resolveSpecMode`) has already resolved it — do NOT re-derive. Read the `## Spec Mode` section: `CHORUS_SPEC_MODE=<lite|openspec|off>` + a routing note. Act on it: `openspec` (usable, shows `CHORUS_OPENSPEC_ACTIVE=1`) → **2a**; `off` → **2b**; `lite` → **2c**. If it says the mode **cannot be honored** (explicit `openspec` but unusable), **halt** and surface it — do NOT fall back or enter 2a with no OpenSpec. (No `## Spec Mode`? See `openspec-aware` §1 manual fallback.) This matters because yolo runs unattended.

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

   **2a. OpenSpec mode (`CHORUS_OPENSPEC_ACTIVE=1`).** Follow `openspec-aware` §3 end-to-end:
   - Pick `$SLUG`, run `openspec new change "$SLUG"` (§3.1–§3.2).
   - Author `proposal.md`, `design.md`, and one `specs/<capability>/spec.md` per capability locally on disk (§3.3). ADDED Requirements only; per-spec fallback to free-form Markdown if MODIFIED/REMOVED is needed.
   - Define the `chorus_check_response` helper (§6); prefer `chorus mcp call … --arg-file content=<file>` for mirrors (§3.4/§3.6) — the bash-wrapper fallback's `$CHORUS_BIN` + `json_encode_file` are only needed when `chorus` is not on `PATH`.
   - Mirror each local file via `chorus mcp call chorus_pm_add_document_draft … --arg-file content=<file>` (§3.6; fallback = `"$CHORUS_BIN" chorus_pm_add_document_draft "$PAYLOAD"`) — one call per file, with the document type from `openspec-aware` §5.

   > **⛔ Do not** invoke `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_update_document` from the MCP harness with a hand-typed `content` field in this branch. Re-typing the markdown body wastes 20k+ tokens per proposal and breaks byte-equality with the local files. See `openspec-aware` §2 Rule 1.

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

   **2c. spec-lite mode (resolved mode = lite).** Load the `spec-lite` skill (`/skill:spec-lite`). Pick `$SLUG` (a **capability**). Ensure the durable `.chorus/specs/<slug>/spec.md` exists (local-only, no ids; use the `spec-lite` skill's inline durable-spec template) and update it in place. Create this change's **dated folder** `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` with its **synced** Chorus-typed docs (shape = the `spec-lite` skill's inline dated-folder document template) — `prd.md` (primary), optional `tech_design.md`… The `description` carries the `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` locator (step 2). Mirror **each** dated-folder `<type>.md` to its persistent Document byte-exact — first time `chorus mcp call chorus_pm_add_document_draft "{\"proposalUuid\":\"<uuid>\",\"type\":\"prd\",\"title\":\"PRD: <feature>\"}" --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/prd.md`, later edits via `chorus_pm_update_document` against the recorded `documentUuid` (`chorus-mcp-call.sh` fallback when `chorus` not on `PATH`). **`spec.md` is never mirrored.** No `openspec/changes/` scaffold; no `tasks.md`. Then continue to step 3.

3. **Add task drafts incrementally** (use returned `draftUuid` for dependency chaining). `acceptanceCriteriaItems` is **required** on every draft — at least one non-blank criterion, or the call is rejected:
   ```
   # First task
   result1 = chorus_pm_add_task_draft({
     proposalUuid: "<proposal-uuid>",
     title: "<module name>",
     kind: "implementation",
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
     kind: "implementation",
     description: "...",
     priority: "medium",
     storyPoints: 2,
     acceptanceCriteriaItems: [...],
     dependsOnDraftUuids: ["<result1.draftUuid>"]
   })
   ```

   **Task kind:** `implementation`, `verification`, `docs`, or `other`. Set `kind` on each draft to describe its actual purpose. Both `chorus_pm_add_task_draft` and `chorus_pm_update_task_draft` accept it; omitting `kind` on update preserves the existing value. It is optional for compatibility with older proposals. Kind is draft-only metadata, visible in `taskDraftIndex`, and is not copied to materialized Tasks; do not add it to `chorus_create_tasks` or `chorus_update_task`.

4. **Validate:**
   ```
   chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
   ```
   Dependency errors block submission. Repair drafts while the proposal is in `draft`; if it is pending, use the normal authorized `chorus_pm_reject_proposal` revision flow first.

   - `E-DEP-UNKNOWN`: replace unknown or foreign dependencies with task-draft UUIDs returned by `chorus_pm_add_task_draft` in this same proposal (confirm with `chorus_get_proposal`, `section: "tasks"`), or remove invalid edges. Do not use materialized Task UUIDs.
   - `E-DEP-SELF`: remove the current draft's own UUID from its `dependsOnDraftUuids`.
   - `E-DEP-CYCLE`: inspect the reported cycle path and remove or redirect edges to match the real execution order; reordering the displayed task list does not break a cycle.

   Replace the affected dependency list with `chorus_pm_update_task_draft`, retaining valid edges (use `[]` if none remain). This update deliberately omits `kind`, preserving its existing value:

   ```
   chorus_pm_update_task_draft({
     proposalUuid: "<proposal-uuid>",
     draftUuid: "<affected-draft-uuid>",
     dependsOnDraftUuids: ["<valid-same-proposal-draft-uuid>"]
   })
   chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

   Revalidate after repairs and resolve all errors before `chorus_pm_submit_proposal`.

   Kind checks are advisory: `I-KIND` means no draft declares a kind, so classification-based implementation coverage cannot be checked; `W-IMPL` means at least one kind is declared but none is `implementation`. Neither advisory blocks submission. Inspect the actual requested scope, existing repository work, task descriptions and AC rather than trusting labels alone. Add or correct real implementation coverage when required by that scope. A justified docs-only or verification-only proposal is valid: record why no new implementation is needed in its description or review context; never fabricate implementation tasks or relabel unrelated work merely to silence an advisory.

5. **Submit:**
   ```
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```
   After this call, the extension nudges you to spawn `chorus-proposal-reviewer`. You MUST spawn it yourself with the `subagent` tool and wait for its VERDICT — it is NOT auto-launched.

---

### Reviewer contract (applies to every review gate below)

Every gate in Phases 2, 4 and 4.5 follows the same three steps. They are written once here; the phases below only name their entity and their stage-specific actions.

1. **Spawn and wait.** Spawn the reviewer as a read-only sub-agent, then wait for it to finish. Read the verdict from the reviewer's `VERDICT:` comment on the entity — the verdict is that comment, not the dispatch's return value.
2. **Read THIS round's VERDICT.** Call `chorus_get_comments` on the entity and find the `VERDICT:` comment posted **after your dispatch**, not an older round's. Do not advance the gate before you have read it.
3. **No VERDICT for this round?** Check what the reviewer *did* post:
   - **A reported round limit, or any other explicit refusal to review** — a deliberate escalation to a human. STOP: do not respawn, do not self-review, do not post a VERDICT of your own.
   - **Nothing at all** — respawn ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you review the entity yourself as a read-only pass and POST the VERDICT, then proceed on what you posted rather than looping forever.

**Absence is never a PASS**, and a round limit reached by someone else is never yours to clear.

---

### Phase 2: Proposal Review Loop

After `chorus_pm_submit_proposal`, the extension nudges you to spawn `chorus-proposal-reviewer`. You MUST manually spawn it as a read-only sub-agent with the `subagent` tool and wait for its VERDICT. Wait for it to complete, then:

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
     After resubmission, the extension nudges you again — spawn the reviewer yourself for Round 2.

3. **Max rounds:** Loop up to `maxProposalReviewRounds` (from plugin config, default 3). If exhausted:
   ```
   STOP: "Proposal review failed after {maxRounds} rounds.
          Remaining BLOCKERs: <list>. Human review needed.
          Proposal UUID: <uuid>"
   ```

4. **No new VERDICT for this round?** Apply step 3 of the **Reviewer contract**, reviewing the proposal yourself if the reviewer stays silent.

---

### Phase 3: Task Execution (Wave-Based)

**Completion and recovery:** report completed work with `chorus_report_work` **without a status field**, then self-check AC with `chorus_report_criteria_self_check`, then call `chorus_submit_for_verify`. Submission owns the `in_progress -> to_verify` transition; reporting must not move the task early. If submission finds a task already at `to_verify`, fetch `chorus_get_task` and its work-report comments first. Leave a legitimately submitted task awaiting verification. Only after confirming a premature transition may the assignee call `chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })` with normal dependency checks (no force/bypass). This rollback clears **both developer and admin acceptance marks and evidence**; repeat the developer self-check with fresh evidence before submitting again. Do not mechanically roll back every task awaiting verification.

After proposal approval, tasks exist in `open` status. Execute them in dependency-ordered waves using subagents. If spawning fails, fall back to main agent execution.

#### Primary: subagent parallel dispatch (wave-based)

The **dispatch shape and the run mode both depend on the installed implementation**: the bundled subagent takes one composite call (`subagent({ tasks: [...] })`, max 8 per call, concurrency 4) and is blocking (the call returns when every worker in the wave has exited); nicobailon `pi-subagents` takes **one single dispatch per worker** (its public tool rejects top-level `tasks`/`chain` before dispatch) and is **async/background by default** (each call returns a run receipt; completion arrives on the run notification / `bg_wait`). Either way there is no `agentId` to track and no manual close. The chorus-pi extension auto-injects each worker's Chorus session UUID + workflow at `tool_call` time and closes the sessions when the dispatch returns (blocking) or when the run settles (`subagent:async-complete` / `process-terminal`).

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

  # 2. Dispatch one chorus-worker per unblocked task as a single wave.
  #    Shape follows the installed implementation:
  #      bundled subagent    → ONE composite call (max 8 tasks/call,
  #        concurrency 4; a bigger wave splits into batches of <=8 calls)
  #      nicobailon          → ONE single dispatch per worker, issued together
  #        (it rejects top-level `tasks`/`chain` before dispatch)
  #    Pass only task + project UUIDs; the chorus-pi extension auto-injects the
  #    session UUID + workflow into each worker's task at tool_call time.
  subagent({
    tasks: [
      { agent: "chorus-worker",
        task: "Your Chorus task UUID: {task.uuid}\nProject UUID: {project-uuid}\n\nImplement the task per its description and acceptance criteria. Read the task, proposal, and project documents for context." },
      // ... one entry per unblocked task, max 8  (bundled subagent only)
    ]
  })
  # ... or, under nicobailon `pi-subagents`, one call per worker in the wave:
  subagent({ agent: "chorus-worker", task: "Your Chorus task UUID: {task.uuid}\n..." })  # worker 1
  subagent({ agent: "chorus-worker", task: "Your Chorus task UUID: {task.uuid}\n..." })  # worker 2
  # Wait for the whole wave to settle — the bundled composite call returns when
  # every worker finishes; under nicobailon each call returns a run receipt, so
  # wait on the run notifications / `bg_wait`. Each worker follows
  # the /skill:develop workflow: claim -> in_progress -> report -> self-check AC
  # -> submit_for_verify (leaving its task at to_verify).
  # For a single ready task, single mode is all you need:
  #   subagent({ agent: "chorus-worker", task: "..." })

  # 3. Proceed to Phase 4 (verification) for this wave
  wave += 1
```

> Do **not** dispatch Chorus workers from a `workflowScript` — children created there are invisible to the extension's session hook, so they would get no Chorus session. One call per worker (or one bundled `tasks` composite) is the supported shape.

**What each worker task needs:**
- Task UUID + Project UUID
- NO session UUID, NO workflow boilerplate -- the extension auto-injects via tool_call mutation
- No `agentId` and no close step — the dispatch owns the worker's whole lifecycle


#### Fallback: Main Agent (sequential)

If the `subagent` dispatch is unavailable or its workers fail repeatedly (e.g., the subagent extension is not loaded, permission denied, or the child pi processes crash), fall back to executing tasks sequentially as the main agent:

```
for each task in unblocked:
  # Follow the /develop workflow directly as main agent
  chorus_claim_task({ taskUuid: "<task-uuid>" })
  chorus_update_task({ taskUuid: "<task-uuid>", status: "in_progress" })

  # ... implement the task: read context, write code, run tests ...

  chorus_report_work({ taskUuid: "<task-uuid>", report: "..." })
  chorus_report_criteria_self_check({ taskUuid: "<task-uuid>", criteria: [...] })
  chorus_submit_for_verify({ taskUuid: "<task-uuid>", summary: "..." })

  # the extension injects context — you must spawn task-reviewer yourself
  # Proceed to Phase 4 verification for this task before moving to next
```

The fallback is slower (sequential, not parallel) but still completes the pipeline. The the extension injects reviewer instructions the same way in both modes — you must always spawn the reviewer manually.

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

  # 2. Spawn chorus-task-reviewer (the extension nudges you; you must spawn it yourself)
  #    Use the `subagent` tool and wait for its VERDICT comment
  subagent({ agent: "chorus-task-reviewer", task: "Review task <task-uuid>..." })

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

**Max rounds per task:** Tracked by `maxTaskReviewRounds` from plugin config (default 3). If a task has been reopened `maxRounds` times, skip it and flag for human escalation:

```
ESCALATE: "Task '{title}' failed review after {maxRounds} rounds.
           Last BLOCKERs: <list>. Manual intervention needed.
           Task UUID: <uuid>"
```

Continue with remaining tasks -- do not halt the entire pipeline for one stuck task.

**No new VERDICT for this round?** Apply step 3 of the **Reviewer contract**, reviewing the task yourself if the reviewer stays silent.

---

### Phase 4.5: Code-Review Gateway (mandatory pre-ship)

Once **every** task of the idea's proposal is verified (`done`) — i.e. Phase 3 finds no more unblocked tasks and all are terminal — run the final ship-time code-review gateway **before** declaring the Idea done and **before** the Phase 5b completion report. After the last task is verified, the extension nudges you to spawn the code-reviewer; you MUST spawn it yourself with the `subagent` tool and wait for its VERDICT.

```
# Spawn the code-reviewer for the IDEA (not a task). Determine the round
# number by reading prior code-review VERDICT comments on the idea.
subagent({ agent: "chorus-code-reviewer",
           task: "Review the aggregate code for idea <idea-uuid>. Round: N." })

# Read its VERDICT on the idea
comments = chorus_get_comments({ targetType: "idea", targetUuid: "<idea-uuid>" })
# Find THIS round's "VERDICT:" comment — the one posted after your dispatch, not an older round's
```

Act on the VERDICT:

- **PASS** / **PASS WITH NOTES** — the feature is cleared to ship. Proceed to Phase 5 / 5b.
- **FAIL** — do NOT ship. Read the BLOCKERs, then fix them via the **quick-dev** workflow (`/quick-dev`): call `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** so the fix tasks attach to it — do **not** reopen the already-verified tasks. Group related small BLOCKERs into one cohesive task by default; split only materially large or independently testable fixes. Drive every fix task through Phase 3 → Phase 4, including AC self-check, independent task review, and admin verification. Re-spawn the code-reviewer only after every fix task is successfully `done`; a failed or cancelled fix task, stop the automatic loop and escalate. Loop bounded by the `maxCodeReviewRounds` setting (`CHORUS_MAX_CODE_REVIEW_ROUNDS`, default 3; 0 = unlimited); the injected Quick Reference states the current value.

```
# Max rounds escalation
ESCALATE: "Idea '<title>' failed code review after {CHORUS_MAX_CODE_REVIEW_ROUNDS} rounds.
           Last BLOCKERs: <list>. Manual intervention needed. Idea UUID: <uuid>"
```

**No new VERDICT for this round?** Apply step 3 of the **Reviewer contract**, reviewing the idea's aggregate change yourself if the reviewer stays silent.

> The code-review gateway is **behavioral**, consistent with the proposal/task reviewers: its verdict is advisory and does not change the Idea's stored status. The /yolo orchestrator honors it — PASS to ship, FAIL to loop. It runs **before** the completion report so the report is never written for a feature with an outstanding FAIL.

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

A successful `/yolo` run always finishes the Idea — call `chorus_create_report` once with `proposalUuid` set to the last verified proposal. The call requires `title` (a short report title) plus `content`; `content`'s parameter description carries the three-section template (`## Summary` / `## Decisions` / `## Follow-ups`); follow it. Surface the returned `documentUuid` in the Phase 5 summary. Skipping is a protocol violation.

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
