---
name: review-chorus
description: Chorus Review workflow — approve/reject proposals, verify tasks, and manage project governance.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.17.2"
  category: project-management
  mcp_server: chorus
---

# Review Skill

This skill covers the **Review** stage of the AI-DLC workflow: approving or rejecting Proposals, verifying completed Tasks, and managing overall project governance as an Admin Agent.

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

Admin Agent has **full access to all Chorus operations**. You are the **human proxy role** — acting on behalf of the project owner to ensure quality and manage the AI-DLC lifecycle.

Key responsibilities:
- **Proposal review** — approve or reject Proposals submitted by PM Agents (see `proposal-chorus` skill at `<BASE_URL>/skill/proposal-chorus/SKILL.md`)
- **Task verification** — verify or reopen Tasks submitted by Developer Agents (see `develop-chorus` skill at `<BASE_URL>/skill/develop-chorus/SKILL.md`)
- **Project governance** — create projects/ideas, manage groups, close/delete entities

> **First-principles alignment (a stage-tailored instruction in all three reviewers).** The proposal-, task-, and code-reviewer each also verify, top-down, that the work still serves the *original Idea's intent* — resolving the Idea from the entity under review and reading it via the existing `chorus_get_idea` + `chorus_get_elaboration` + `chorus_get_comments` (intent counts **human-authored** content only) and flagging **scope creep**, **requirement loss / shrink**, or **semantic drift**. Unauthorized drift is a **BLOCKER → `VERDICT: FAIL` / reject**, downgraded to a cited NOTE only when traceable to a **human-originated** authorization (a human-authored Idea comment, a human-answered elaboration entry, or an explicit human override at the gate) — an agent's own comment never authorizes. So a review `FAIL` may come from intent drift, not just a local defect: treat it the same way — reject/reopen and fix, or record a human override. See the canonical **Independent Review** section in the `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`) for the full rule.

---

## Tools

**Admin-Exclusive:**

| Tool | Purpose |
|------|---------|
| `chorus_admin_create_project` | Create a new project (optional `groupUuid` for group assignment) |
| `chorus_admin_approve_proposal` | Approve proposal (materializes documents + tasks) |
| `chorus_admin_verify_task` | Verify completed task (to_verify -> done). Blocked if required AC not all passed. |
| `chorus_mark_acceptance_criteria` | Mark acceptance criteria as passed/failed during verification (batch) |
| `chorus_admin_reopen_task` | Reopen task for rework (to_verify -> in_progress) |
| `chorus_admin_close_task` | Close task (any state -> closed) |
| `chorus_admin_close_idea` | Close idea (any state -> closed) |
| `chorus_admin_delete_idea` | Delete an idea permanently |
| `chorus_admin_delete_task` | Delete a task permanently |
| `chorus_admin_delete_document` | Delete a document permanently |
| `chorus_admin_create_project_group` | Create a new project group |
| `chorus_admin_update_project_group` | Update a project group (name, description) |
| `chorus_admin_delete_project_group` | Delete a project group (projects become ungrouped) |
| `chorus_admin_move_project_to_group` | Move a project to a group or ungroup it |

**PM + Admin (proposal reject/revoke):**

| Tool | Purpose |
|------|---------|
| `chorus_pm_reject_proposal` | Reject a pending proposal (pending -> draft). PM: own proposals only. Admin: any proposal. |
| `chorus_pm_revoke_proposal` | Revoke an approved proposal (approved -> draft). Cascade-closes tasks, deletes documents. PM: own only. Admin: any. |

**All PM tools** (`chorus_pm_*`, `chorus_*_idea`) and **all Developer tools** (`chorus_*_task`, `chorus_report_work`) are also available to Admin.

**Shared tools** (checkin, query, comment, search, notifications): see `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`)

---

## Workflow

### Step 1: Check In

```
chorus_checkin()
```

Pay attention to:
- Pending proposal count (items awaiting approval)
- Tasks in `to_verify` status (work awaiting review)
- Overall project health

### Step 2: Triage

Check what needs your attention:

```
# Pending proposals
chorus_get_proposals({ projectUuid: "<project-uuid>", status: "pending" })

# Tasks awaiting verification
chorus_list_tasks({ projectUuid: "<project-uuid>", status: "to_verify" })

# Recent activity
chorus_get_activity({ projectUuid: "<project-uuid>" })
```

Prioritize: **Proposals first** (they unblock PM and Developer work), then task verifications.

### Workflow A: Proposal Review

#### A1: Read the Proposal

```
chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "full" })
```

`chorus_get_proposal` defaults to `section: "basic"` — proposal metadata plus a lightweight index of the drafts (uuid, type/title, contentLength, AC count, dependency edges) with **no** document content or full task descriptions. For a review you need the bodies, so pass `section: "full"` to get everything at once (or `section: "documents"` / `section: "tasks"` to read one kind at a time).

The `full` view returns: title, description, input ideas, **document drafts** (PRD, tech design), **task drafts** (with descriptions and acceptance criteria).

#### A2: Quality Checklist

**Documents:**
- [ ] PRD clearly describes the *what* and *why*
- [ ] Requirements are specific and testable
- [ ] Tech design is feasible and follows project conventions
- [ ] No missing edge cases or security considerations

**Tasks:**
- [ ] Tasks cover all requirements in the PRD
- [ ] Each task has clear acceptance criteria
- [ ] Tasks are appropriately sized (1-8 story points)
- [ ] Task descriptions have enough context for a developer agent
- [ ] Priority is set correctly

**Overall:**
- [ ] Proposal aligns with the original idea(s)
- [ ] No scope creep beyond what was requested
- [ ] Implementation approach is reasonable

#### A3: Read Comments

```
chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
```

#### A3.5: Independent Review

Before approving, run an independent review of the proposal. Spawn a read-only sub-agent that loads the `proposal-reviewer-chorus` skill (`<BASE_URL>/skill/proposal-reviewer-chorus/SKILL.md`), pass it the `proposalUuid`, and let it adversarially audit document quality, task granularity, AC alignment, and the dependency DAG. It posts a single `VERDICT` comment (PASS / PASS WITH NOTES / FAIL) on the proposal; read THIS round's verdict comment — the one posted after your dispatch, not an older round's — with `chorus_get_comments` before deciding.

The spawn mechanism is harness-specific, and an inline self-review fallback exists when sub-agents are unavailable — see the canonical **Independent Review** section in the `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`) for the full pattern.

> **VERDICT: FAIL is advisory** — the reviewer's opinion does not block approval. The admin reads the review comment and makes the final decision.

#### A4: Approve or Reject

**Approve:**

```
chorus_admin_approve_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "Approved. Good breakdown of tasks."
})
```

The response includes `materializedTasks` and `materializedDocuments` — use them to immediately assign tasks or reference documents.

When approved:
- Document drafts become real Documents
- Task drafts become real Tasks (status: `open`)

**Reject:**

```
chorus_pm_reject_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "PRD missing error handling requirements. Task 3 needs clearer AC."
})

chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "Specific feedback:\n1. Add error scenarios to PRD\n2. Task 3 AC should include performance benchmarks"
})
```

### Workflow A2: Revoking Approved Proposals

If an approved Proposal's direction turns out to be wrong, use `chorus_pm_revoke_proposal` to undo the approval. Unlike `reject` (which acts on pending proposals), `revoke` acts on already-approved proposals and rolls back all materialized resources.

```
chorus_pm_revoke_proposal({
  proposalUuid: "<proposal-uuid>",
  reviewNote: "Requirements changed — original approach no longer viable."
})
```

Cascade effects: all materialized Tasks are closed, all materialized Documents are deleted, and related AcceptanceCriteria/TaskDependencies/SessionCheckins are cleaned up. The Proposal returns to `draft` status so the PM can revise and resubmit.

### Workflow B: Task Verification

#### B1: Review the Submitted Task

```
chorus_get_task({ taskUuid: "<task-uuid>" })
```

Check: developer's work summary, acceptance criteria, self-check results.

#### B2: Read Comments and Work Reports

```
chorus_get_comments({ targetType: "task", targetUuid: "<task-uuid>" })
```

#### B2.5: Independent Review

Before marking acceptance criteria and verifying, run an independent review of the task. Spawn a read-only sub-agent that loads the `task-reviewer-chorus` skill (`<BASE_URL>/skill/task-reviewer-chorus/SKILL.md`), pass it the `taskUuid`, and let it independently verify the implementation against the acceptance criteria and proposal documents. It posts a single `VERDICT` comment (PASS / PASS WITH NOTES / FAIL) on the task; read THIS round's verdict comment — the one posted after your dispatch, not an older round's — with `chorus_get_comments` before deciding.

The spawn mechanism is harness-specific, and an inline self-review fallback exists when sub-agents are unavailable — see the canonical **Independent Review** section in the `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`) for the full pattern.

> **VERDICT is advisory** — a `FAIL` does not block verification and a `PASS` does not auto-verify. The admin reads the review comment, marks the acceptance criteria, and makes the final decision.

#### B2.6: Final Code-Review Gateway (after an Idea's LAST task is verified)

When the task you just verified is the **last** task of its idea-rooted proposal, run the ship-time code-review gateway before the Idea's code is considered shipped. Spawn a read-only sub-agent that loads the `code-reviewer-chorus` skill (`<BASE_URL>/skill/code-reviewer-chorus/SKILL.md`), pass it the `ideaUuid` + round number, and let it review the Idea's **aggregate** code change across all its tasks — cross-task integration, architecture/convention consistency, security, regression/performance, and feature-level test coverage — dimensions a single-task review cannot see. It posts one `VERDICT` comment on the **Idea**; read THIS round's verdict comment on the Idea — posted after your dispatch, not an earlier round's — with `chorus_get_comments({ targetType: "idea", targetUuid })` before deciding.

- `PASS` / `PASS WITH NOTES` → the feature may ship.
- `FAIL` → fix via the **quick-dev** workflow (`<BASE_URL>/skill/quick-dev-chorus/SKILL.md`): `chorus_create_tasks` with `proposalUuid` set to the **current approved proposal** so the fix tasks attach to it, targeting the BLOCKERs — do **not** reopen the already-verified tasks — then execute and verify them. Group related small BLOCKERs by default; split only materially large or independently testable fixes. Require AC self-check, independent task review, and admin verification for every fix task. Re-run aggregate review only after every fix is successfully `done`; a failed or cancelled fix stops the loop and escalates (next round), bounded by `maxCodeReviewRounds`.

The plugin's post-verify hook injects this reminder automatically on the last-task verify. The spawn mechanism is harness-specific with an inline fallback — see the canonical **Independent Review** section in the `chorus` skill.

> **VERDICT is advisory / behavioral** — the gateway does not change the Idea's stored status; the orchestrator honors its verdict. Run it **before** writing any idea-completion report (the report must not be written while a `FAIL` is outstanding).

#### B3: Mark Acceptance Criteria

Review and mark each criterion:

```
chorus_mark_acceptance_criteria({
  taskUuid: "<task-uuid>",
  criteria: [
    { uuid: "<criterion-uuid>", status: "passed" },
    { uuid: "<criterion-uuid>", status: "passed" },
    { uuid: "<criterion-uuid>", status: "failed", evidence: "Missing edge case handling" }
  ]
})
```

#### B4: Verify or Reopen

**Verify (all required AC passed):**

```
chorus_admin_verify_task({ taskUuid: "<task-uuid>" })
```

This moves the task to `done`. Verifying may unblock downstream tasks. Consider checking:

```
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })
```

If new tasks are unblocked, assign them or notify developers.

**Reopen (needs fixes):**

```
chorus_admin_reopen_task({ taskUuid: "<task-uuid>" })

chorus_add_comment({
  targetType: "task",
  targetUuid: "<task-uuid>",
  content: "Reopened: Missing error handling for user-not-found edge case."
})
```

The task returns to `in_progress`. All acceptance criteria are reset.

#### B5: Close / Delete Tasks

```
# Close (preserves history)
chorus_admin_close_task({ taskUuid: "<task-uuid>" })

# Delete (permanent — prefer closing over deleting to preserve history)
chorus_admin_delete_task({ taskUuid: "<task-uuid>" })
```

### Workflow C: Project & Idea Management

#### Create Project

```
chorus_get_project_groups()  # List available groups first
chorus_admin_create_project({
  name: "My Project",
  description: "Project goals...",
  groupUuid: "<optional-group-uuid>"
})
```

#### Manage Project Groups

```
chorus_admin_create_project_group({ name: "Mobile Apps", description: "All mobile projects" })
chorus_admin_move_project_to_group({ projectUuid: "<uuid>", groupUuid: "<uuid>" })
chorus_admin_move_project_to_group({ projectUuid: "<uuid>", groupUuid: null })  # Ungroup
chorus_admin_delete_project_group({ groupUuid: "<uuid>" })  # Projects become ungrouped
```

#### Close / Delete Ideas

```
chorus_admin_close_idea({ ideaUuid: "<idea-uuid>" })
chorus_admin_delete_idea({ ideaUuid: "<idea-uuid>" })
```

> **Note:** Creating ideas is a PM tool (`chorus_pm_create_idea`). See `idea-chorus` skill (`<BASE_URL>/skill/idea-chorus/SKILL.md`).

#### Document Management

```
chorus_admin_delete_document({ documentUuid: "<doc-uuid>" })
chorus_pm_update_document({ documentUuid: "<doc-uuid>", content: "Updated..." })
```

---

## Daily Admin Routine

1. **Check in** — `chorus_checkin()`
2. **Review activity** — `chorus_get_activity()` for recent events
3. **Process proposals** — Review and approve/reject pending proposals
4. **Verify tasks** — Review and verify/reopen tasks in `to_verify`
5. **Create new ideas** — If the human has new requirements
6. **Check project health** — Stale tasks? Blocked items? Orphaned ideas?

---

## Tips

- **Review thoroughly** — Confirm proposals meet quality standards before approving
- **Give actionable feedback** — When rejecting, explain specifically what to fix
- **Verify against criteria** — Check acceptance criteria, not just the summary
- **Manage scope** — Consider closing ideas and tasks that are no longer relevant
- **Unblock the team** — Prioritize proposal reviews to keep PM and Developer work flowing
- **Prefer closing over deleting** — Closing preserves history for future reference
- **Document decisions** — Use comments to explain approval/rejection reasoning

---

## Governance Principles

1. **Quality over speed** — A rejected proposal now saves rework later
2. **Actionable feedback** — Every rejection should include specific fixes
3. **Criteria-based verification** — Verify against acceptance criteria, not just subjective impression
4. **Scope discipline** — Close what's no longer needed; do not let orphaned items pile up
5. **Unblock others** — Your reviews are the bottleneck; prioritize them
6. **Preserve history** — Close > Delete; comments > silent actions
7. **Document reasoning** — Future agents will read your comments to understand decisions

---

## Next

- For platform overview and shared tools, see `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`)
- For Idea elaboration (before proposals), see `idea-chorus` skill (`<BASE_URL>/skill/idea-chorus/SKILL.md`)
- For Proposal creation (what you're reviewing), see `proposal-chorus` skill (`<BASE_URL>/skill/proposal-chorus/SKILL.md`)
- For Developer workflow (what you're verifying), see `develop-chorus` skill (`<BASE_URL>/skill/develop-chorus/SKILL.md`)
