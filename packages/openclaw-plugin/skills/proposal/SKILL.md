---
name: proposal
description: Chorus Proposal workflow — create proposals with document and task drafts, manage dependency DAG, validate and submit for review.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.23.2"
  category: project-management
  mcp_server: chorus
---

# Proposal Skill

This skill covers the **Planning** stage of the AI-DLC workflow: creating Proposals that contain document drafts (PRD, tech design) and task drafts with dependency DAGs, then submitting them for Admin review.

> **Tool namespace:** Chorus tools are exposed by the connected MCP server under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_pm_create_proposal`). Bare names are used below for readability — prepend `chorus__` when invoking. See `/chorus` for the full rule.

---

## Authoritative Idea Team Routing

**Apply this gate before the workflow below, including any claim, assignment, approval, verification or YOLO instructions.** Resolve the event's root Idea via Idea/Task/Proposal/Document reads (including every source Idea in proposal input ancestry); fetch `chorus__chorus_get_idea_team_context({ideaUuid})` for each and re-read before mutations. Session anchors, wake messages and `chorus__chorus_get_project_team` snapshots are context, not authorization. Missing/ambiguous ancestry or tool failure is a stop, not evidence of unmanaged work.

- **Current assignee, not fixed Team lead:** each Idea's current explicitly human-assigned agent is its orchestrator. New enrollment requires the receiving agent owner's consent, a bound private Team, project editor access and `idea:write`, not Team lead membership or a full admin permission bundle. The optional default lead is a suggestion, never the Idea owner. Runtime “Team Lead” wording describes local worker coordination, not a required project Team role. Unassigned Ideas stay unassigned; assigned-but-not-authorized is not “no owner.” Bare creation, agent self-claim, template changes, presence, upgrades and instance repinning do not start automation. Explicit human selection in conversational creation DOES start it; derived children inherit no authority.
- **Verified agent-mediated start:** ask the receiving owner to use the human confirmation control, or post the exact standalone HUMAN comment `chorus:assign <agent-uuid>` on that Idea. For the comment path call `chorus__chorus_prepare_idea_assignment({ideaUuid, agentUuid, commentUuid})`, then pass the returned `uuid` as `humanAuthorizationUuid` to `chorus__chorus_pm_assign_idea` with the matching Idea and agent. Both tools require `idea:admin`; confirmation controls are authenticated human actions, not agent tools. Proof is company/project/Idea/target/owner/generation-bound, private, single-use and expires after 24 hours. Never invent consent, post the command as an agent, fake human headers, or reuse stale/edited/deleted/replayed proof. Prose and mentions are not proof. Without proof, permitted agent assignment cannot activate or repair automation; cross-owner assignment needs the receiving owner's consent. Use the same operation key only to retry the identical committed assignment, never to authorize a new one.
- **Delegate without taking ownership:** only the current active orchestrator routes managed work. Use `chorus__chorus_recommend_team_agent({ideaUuid, role: "product"})` or `chorus__chorus_recommend_team_agent({ideaUuid, role: "development", taskUuid})`. Product delegation uses `chorus__chorus_delegate_team_product({ideaUuid, agentUuid})`, never Idea assignment; development uses task assignment after checking eligibility. The orchestrator stays the sole assignee. Product delegates may elaborate and create/submit proposals, but must not claim/release/reassign the Idea, resolve elaboration, approve proposals or verify tasks. Re-delegation invalidates the old turn and creates fresh product AND orchestrator turns, even for the same agent: stop the obsolete run, do not continue with refreshed guesses.
- **Respect recommendations:** `recommended` selects a candidate; the compatibility value `lead_decision` leaves a tie for the current orchestrator; `manual` requires manual handling; `paused` stops automation. Empty/all-ineligible roles mean manual handling, not orchestrator fallback. Only eligible-but-all-offline roles may fall back to an eligible online current orchestrator returned by the tool. Development reopens prefer the eligible online original assignee; otherwise minimize live activeCount, with dependency-chain affinity only as a load-tie breaker. Never invent candidates or silently break ties. Membership grants no permissions/access; recommendations neither assign, reserve load nor wake agents.
- **Stop at server gates:** non-YOLO proposal approval is human-only. Server-confirmed human `yolo_requested` belongs to the exact Idea and survives reassignment; only its current active orchestrator with `proposal:admin` may approve. Task verification does NOT require YOLO, but requires the current active orchestrator, `task:admin`, valid task state and passed required acceptance criteria; delegates/workers cannot verify. Missing only an action permission blocks that action, not enrollment. Local YOLO mode or wake wording grants nothing. Intersect all source Idea gates and retain authorized human control; never retry a denial through another tool.
- **Fence every directed turn:** runtimes must support `ideaTeamProtocol=1` AND `wakeRecoveryProtocol=1`. Carry actual admitted `X-Chorus-Turn-Uuid` / `X-Chorus-Admission-Uuid` headers; for multi-source actions, supplemental `X-Chorus-Idea-Team-Turns` is a JSON array of at most 16 `{turnUuid, admissionUuid}` pairs, requiring the primary pair. Use server-provided primary `ideaTeam` plus `ideaTeams` source snapshots; never invent or reuse stale admission proofs. Scheduling, admission, resume, recovery and mutation recheck recipient, owner, active state and generation. A→B→A does not revive A's old turn; broadcasts cannot bypass fencing. Stop obsolete runs; old clients need an upgrade, not an unfenced fallback. Already executing tasks are not killed, but later mutations must pass current gates.
- **Privacy, repair and review:** shared viewers get only safe gate responsibility, never private rosters/delegation/proofs. Context and recommendations require `idea:read` and project access; recommendations are owner-private. Delegation requires `idea:write`, current active orchestrator authority and live eligibility. Paused enrollment needs explicit human repair; report the reason and end the turn rather than polling. Legacy managed work keeps legacy guards until an authorized transition; unmanaged Ideas and standalone Quick Tasks keep their existing flows. Existing independent reviewer/human gates remain mandatory; review grants no approval/verification authority, no independent Reviewer auto-wake is added, and there is no automatic merge.

## Overview

After an Idea's elaboration is resolved (see `/idea`), the PM Agent creates a Proposal — a container that holds document drafts and task drafts. On Admin approval, these drafts materialize into real Documents and Tasks.

```
Elaboration resolved --> Create Proposal --> Add drafts --> Validate --> Submit --> Reviewer --> Admin /review
```

---

## Tools

**Proposal Management:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_create_proposal` | Create empty proposal container |
| `chorus_pm_validate_proposal` | Validate proposal completeness (returns errors, warnings, info) |
| `chorus_pm_submit_proposal` | Submit proposal for Admin approval (draft -> pending) |

**Document Drafts:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_add_document_draft` | Add document draft to proposal |
| `chorus_pm_update_document_draft` | Update document draft content |
| `chorus_pm_remove_document_draft` | Remove document draft from proposal |

**Task Drafts:**

| Tool | Purpose |
|------|---------|
| `chorus_pm_add_task_draft` | Add task draft (returns draftUuid for dependency chaining) |
| `chorus_pm_update_task_draft` | Update task draft |
| `chorus_pm_remove_task_draft` | Remove task draft from proposal |

**Post-Approval (tasks exist):**

| Tool | Purpose |
|------|---------|
| `chorus_create_tasks` | Batch create tasks (supports intra-batch dependencies via draftUuid) |
| `chorus_pm_assign_task` | Assign a task to a Developer Agent |
| `chorus_pm_create_document` | Create standalone document |
| `chorus_pm_update_document` | Update document content (increments version) |
| `chorus_update_task` (with `addDependsOn` / `removeDependsOn`) | Add or remove task dependencies (with cycle detection) |

**Shared tools** (checkin, query, comment, search, notifications): see `/chorus`

---

## Workflow

### Step 0: Reuse Evidence and Check New Factual Gaps

Read the confirmed input Idea(s) or Documents, current specifications, References and recent context before drafting. Reuse existing findings first; invoke `/research` ([shared rules](../research/SKILL.md)) only for a new factual design gap or explicit user request, subject to explicit skip. Supply the Proposal stage, focused question, existing evidence and budget. Do not automatically repeat Idea research, including on a resumed planning wake; this route also applies to form/MCP-created inputs without a research flag.

If the Proposal does not exist yet, retain candidate source URLs/titles/types in the current context, then include them in `references[]` on the Step 1 `chorus__pm_create_proposal` call when possible. Read `chorus__get_proposal` afterward to obtain actual `references[].uuid`; inline creation returns the container UUID, not individual evidence UUIDs. If it already exists, reuse its evidence or attach new sources via `chorus__add_reference` and take the returned reference `uuid`. Only then write citations such as `[1](ref:<actual-reference-uuid>)` beside supported statements in the design/specifications. Never invent UUIDs or substitute the Proposal UUID.

In OpenSpec/spec-lite modes, resolve the existing spec mode and locator as below, update authoritative local files with findings and real citations, then mirror file bytes using `chorus mcp call … --arg-file content=<file>` (or the port's existing file-reading wrapper). No hand-typed MCP document `content`; spec-lite's durable `spec.md` remains local-only. Free-form mode keeps its normal draft-saving path. Empty/partial results preserve unknowns and continue preparation. Research does not submit, approve, or bypass revision restrictions; pending/approved proposals retain their existing revision gates. A Tracker research-only instruction returns through the Idea route instead of entering this drafting workflow.

### Step 1: Create an Empty Proposal

**Resolve the spec mode (Step 1.5) BEFORE this create.** In OpenSpec and spec-lite modes the container's `description` MUST carry a locator line (`OpenSpec change slug: <slug>` or `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`), and `description` can only be set at creation — decide the mode + slug/dated-path first and include that line in this single call. Do NOT create a bare container and then realize you needed it. Free-form mode omits any locator line. (OpenClaw has no SessionStart hook — you resolve the mode inline here; see Step 1.5.)

**Recommended approach:** Create the proposal container first (with the mode's locator line in `description` when applicable), then incrementally add document and task drafts one by one.

```
chorus_pm_create_proposal({
  projectUuid: "<project-uuid>",
  title: "Implement <feature name>",
  description: "Analysis and implementation plan for Idea #xxx",
  inputType: "idea",
  inputUuids: ["<idea-uuid>"]
})
```

**Multiple Ideas:** You can combine multiple ideas into one proposal by passing multiple UUIDs in `inputUuids`.

> **A theme cannot be a proposal input** — `chorus_pm_create_proposal` rejects any input idea with `isContainer = true`. Derive a child idea from the theme and write the proposal on the child instead. (See the theme-ideas section of the `/idea` skill.)

### Step 1.5: Select spec mode

Resolve the spec mode **inline** — OpenClaw has no SessionStart hook to precompute it, so you compute the **whole** contract yourself (not just "is OpenSpec active"), every time you reach this step. Load the `openspec-aware` skill and run its **§1 resolution block (which sources the plugin's shipped `bin/resolve-spec-mode.sh`)**, which yields one of `lite` / `openspec` / `off` (the canonical resolver, byte-identical to the Claude Code copy; `/chorus spec` prints the same result from the TS mirror `src/spec-mode.ts`). The rule: an explicit `CHORUS_SPEC_MODE` (`lite`/`openspec`/`off`) wins; when unset, **OpenSpec is the default whenever usable** (`CHORUS_OPENSPEC_MODE` ≠ `off`, an `openspec/` directory at the project root, and the `openspec` CLI on `PATH`), else **spec-lite**.

- If the resolution says the mode **cannot be honored** (explicit `CHORUS_SPEC_MODE=openspec` but OpenSpec unusable — config-conflict or not-installed), **halt** and surface it; do not silently fall back.
- Otherwise branch on the resolved mode:

- **resolved = spec-lite** (the default when OpenSpec isn't usable, or explicit `CHORUS_SPEC_MODE=lite`) → load the `spec-lite` skill and follow it: pick `$SLUG` (a **capability**, not one change). Ensure the durable `.chorus/specs/<slug>/spec.md` exists (local-only, **no Chorus ids**; use the `spec-lite` skill's inline durable-spec template) and update it in place. Create this change's **dated folder** `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` with its **synced** Chorus-typed docs (`prd.md` primary, optional `tech_design.md`…; use the `spec-lite` skill's inline dated-folder document template). Put the literal locator line `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` in the **Step 1 create** `description`, then mirror **each** dated-folder `<type>.md` to its persistent Document (`chorus_pm_add_document_draft --arg-file` first time, `chorus_pm_update_document --arg-file` after) via `chorus mcp call … --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/<type>.md` (fallback = `chorus-api.sh mcp-tool …` when `chorus` is not on `PATH`). **`spec.md` is never mirrored.** Skip Step 2 below. (Tasks via `chorus_pm_add_task_draft`; no `tasks.md`.)

- **resolved = OpenSpec** (unset with `openspec/` + CLI present and not disabled, or explicit `CHORUS_SPEC_MODE=openspec` that is usable) → follow `openspec-aware` §3. Pick `$SLUG`, scaffold `openspec/changes/<slug>/`, author `proposal.md` / `design.md` / `specs/<capability>/spec.md` locally, then put the literal line `OpenSpec change slug: <slug>` in the **Step 1 create** `description`, and mirror each local file into a document draft.

  > **⛔ Mandatory in OpenSpec mode:** mirror calls fill `content` from the local file — prefer `chorus mcp call … --arg-file content=<file>`, falling back to the `chorus-api.sh` wrapper with `json_encode_file` when `chorus` is not on `PATH` — see `openspec-aware` §3.6. Do **not** call `chorus_pm_add_document_draft` directly from the MCP harness with a hand-typed `content` field. Re-typing thousands of lines through the LLM burns 20k+ content tokens per proposal and breaks byte-equality with the local source of truth (`openspec-aware` §2 Rule 1 explains the full reasoning). Skip Step 2 below when in OpenSpec mode — the file-fill flow in `openspec-aware` §3.6 replaces it for documents.

- **resolved = free-form** (explicit `CHORUS_SPEC_MODE=off`) → proceed with Step 2 unchanged. Author drafts inline as free-form Markdown via direct MCP `chorus_pm_add_document_draft`.

### Step 2: Add Document Drafts

Add document drafts one at a time:

```
# Add PRD
chorus_pm_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "prd",
  title: "PRD: <Feature Name>",
  content: "# PRD: <Feature Name>\n\n## Background\n...\n## Requirements\n..."
})

# Add Tech Design
chorus_pm_add_document_draft({
  proposalUuid: "<proposal-uuid>",
  type: "tech_design",
  title: "Tech Design: <Feature Name>",
  content: "# Technical Design\n\n## Architecture\n...\n## Implementation\n..."
})
```

**Document types:** `prd`, `tech_design`, `adr`, `spec`, `guide`

### Step 3: Add Task Drafts

Add task drafts one at a time. The response returns the new draft's `draftUuid` — use it directly for `dependsOnDraftUuids` in subsequent drafts.

**`acceptanceCriteriaItems` is required** — every task draft must include at least one item with a non-blank `description`, or the call is rejected. Use the structured `acceptanceCriteriaItems` array (the legacy `acceptanceCriteria` Markdown string does not satisfy the requirement).

```
# First task -> response includes { draftUuid, draftTitle }
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Implement <component>",
  kind: "implementation",
  description: "Detailed description of what to build...",
  priority: "high",
  storyPoints: 3,
  acceptanceCriteriaItems: [
    { description: "Criteria 1", required: true },
    { description: "Criteria 2", required: true }
  ]
})

# Second task — depends on first
chorus_pm_add_task_draft({
  proposalUuid: "<proposal-uuid>",
  title: "Write tests for <component>",
  kind: "verification",
  description: "Unit and integration tests...",
  priority: "medium",
  storyPoints: 2,
  acceptanceCriteriaItems: [
    { description: "Test coverage > 80%", required: true }
  ],
  dependsOnDraftUuids: ["<draftUuid-from-first-task>"]
})
```

> To edit a draft's criteria later via `chorus_pm_update_task_draft`, pass a non-empty `acceptanceCriteriaItems` to replace them; omit the field to leave them unchanged. The field cannot be used to clear criteria.

**Task priority:** `low`, `medium`, `high`

**Task kind:** `implementation`, `verification`, `docs`, or `other`. Set `kind` on each draft to describe its actual purpose. Both `chorus_pm_add_task_draft` and `chorus_pm_update_task_draft` accept it; omitting `kind` on update preserves the existing value. It is optional for compatibility with older proposals. Kind is draft-only metadata, visible in `taskDraftIndex`, and is not copied to materialized Tasks; do not add it to `chorus_create_tasks` or `chorus_update_task`.

### Step 4: Review and Refine Drafts

```
# Review current state. chorus_get_proposal defaults to section:"basic"
# (metadata + a lightweight draft index, no bodies). Use section:"full" to
# see every draft's content, or section:"documents"/"tasks" for one kind.
chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "full" })

# Update a document draft
chorus_pm_update_document_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  content: "Updated content..."
})

# Update a task draft
chorus_pm_update_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>",
  description: "Updated description...",
  kind: "implementation",
  dependsOnDraftUuids: ["<other-draft-uuid>"]
})

# Remove a draft
chorus_pm_remove_task_draft({
  proposalUuid: "<proposal-uuid>",
  draftUuid: "<draft-uuid>"
})
```

### Step 5: Validate and Submit

Before submitting, validate to preview issues:

```
chorus_pm_validate_proposal({ proposalUuid: "<proposal-uuid>" })
```

Returns `{ valid, issues }` with error, warning, and info levels. Fix errors before submitting.

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

When validation passes:

```
chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
```

This changes the status from `draft` to `pending`. An Admin will review it (see `/review`).

Add a comment explaining your reasoning:

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "This proposal covers... Key decisions: ..."
})
```

### Step 5.5: Run the Proposal Reviewer (inline — no hook on OpenClaw)

> **OpenClaw difference:** the Claude Code plugin relies on a PostToolUse hook to inject a "spawn the reviewer" reminder after `chorus_pm_submit_proposal`. **OpenClaw has no such hook.** Run the reviewer step **inline**, right here, immediately after submitting. Do not wait for an injected reminder — it will never come.

Obtain an independent VERDICT before considering the proposal ready for Admin approval:

1. **Preferred — spawn a reviewer sub-agent.** Use the OpenClaw `sessions_spawn` tool to spawn a sub-agent whose `task` tells it to **invoke the `/proposal-reviewer` skill** (bundled with this plugin) against the proposal, then wait for it (poll the `subagents` tool or use `sessions_yield` — do NOT detach; you need its VERDICT before proceeding). The sub-agent inherits the plugin skills, so `/proposal-reviewer` is available to it; that skill is read-only and posts a `VERDICT:` comment on the proposal. Example task prompt:
   > `Run the /proposal-reviewer skill to review proposalUuid <uuid>. Read the proposal, its documents, the idea, and the elaboration; classify findings BLOCKER/NOTE; post your VERDICT comment on the proposal when done.`

2. **Fallback — review it yourself.** If `sessions_spawn` is unavailable on your host (spawning disabled by policy), perform the review yourself as a **focused, read-only pass** following the `/proposal-reviewer` skill's procedure: read `chorus_get_proposal`, `chorus_get_comments`, the linked idea, and the elaboration; check document completeness, task granularity, AC ↔ requirement coverage, the dependency DAG, and integration checkpoints; then record the result yourself via `chorus_add_comment` ending with a `VERDICT:` line (PASS / PASS WITH NOTES / FAIL). Do NOT modify any drafts during this pass — it is review-only. Use the same BLOCKER vs NOTE classification the `/proposal-reviewer` skill defines.

3. **Read the VERDICT and act:**
   ```
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```
   Find THIS round's `VERDICT:` comment — the one posted after your dispatch, not an older round's:
   - **PASS** / **PASS WITH NOTES** — proceed; an Admin can approve (notes are non-blocking).
   - **FAIL** — go to Step 6 and fix the BLOCKERs before resubmitting.

If no new `VERDICT:` comment appears after the reviewer returns, check what it *did* post. A comment reporting that the round limit was reached, or any other explicit refusal to review, is a deliberate escalation to a human: STOP — do not respawn, do not self-review, do not post a VERDICT of your own. If it posted nothing at all, respawn it ONCE, telling it to stay within its turn budget and reserve its last turns for the VERDICT, then apply this same check again to what the retry posts. An explicit refusal from the retry still means STOP; only a second true silence lets you fall back to reviewing manually (Step 5.5 fallback) and post the VERDICT yourself. **Absence is never a PASS.**

### Step 6: Handle Feedback

After the reviewer runs (or an Admin reviews), if the VERDICT is **FAIL** or the Admin rejects, you need to revise and resubmit.

**IMPORTANT:** A proposal in `pending` status cannot be edited. You **must** reject it first to return it to `draft` status before editing any drafts.

1. **Read feedback:**
   ```
   chorus_get_proposal({ proposalUuid: "<proposal-uuid>", section: "full" })
   chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })
   ```
   Identify BLOCKERs from the reviewer VERDICT or rejection note.

2. **Reject the proposal** (self-reject your own, or ask admin to reject someone else's):
   ```
   chorus_pm_reject_proposal({
     proposalUuid: "<proposal-uuid>",
     reviewNote: "Reviewer FAIL. Fixing BLOCKERs: <list>"
   })
   ```
   This returns the proposal to `draft` status. PM agents can only reject their own proposals; admin agents can reject any proposal.

3. **Revise the drafts:**
   ```
   chorus_pm_update_document_draft({ proposalUuid: "<proposal-uuid>", draftUuid: "<uuid>", content: "..." })
   chorus_pm_update_task_draft({ proposalUuid: "<proposal-uuid>", draftUuid: "<uuid>", ... })
   ```

4. **Resubmit and re-run the reviewer** (Step 5 → Step 5.5 again):
   ```
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```

### Step 7: Post-Approval

When the Admin approves:
- Document drafts become real Documents
- Task drafts become real Tasks (status: `open`, ready for developers)
- The Idea's displayed status is automatically derived from Proposal and Task progress -- no manual update needed

### Step 8: Manage Task Dependencies (Optional)

After tasks are created, you can manage dependencies:

**Batch create tasks with intra-batch dependencies:**

```
chorus_create_tasks({
  projectUuid: "<project-uuid>",
  tasks: [
    { draftUuid: "draft-db", title: "Create database schema", priority: "high", storyPoints: 2 },
    { draftUuid: "draft-api", title: "Implement API endpoints", priority: "high", storyPoints: 4, dependsOnDraftUuids: ["draft-db"] },
    { title: "Write integration tests", priority: "medium", storyPoints: 2, dependsOnDraftUuids: ["draft-api"] }
  ]
})
```

**Add/remove dependencies on existing tasks:**

```
chorus_update_task({ taskUuid: "<task-B-uuid>", addDependsOn: ["<task-A-uuid>"] })
chorus_update_task({ taskUuid: "<task-B-uuid>", removeDependsOn: ["<task-A-uuid>"] })
```

Dependencies are validated: same project, no self-dependency, no cycles (DFS detection).

### Step 9: Assign Tasks to Developer Agents (Optional)

```
chorus_pm_assign_task({ taskUuid: "<task-uuid>", agentUuid: "<developer-agent-uuid>" })
```

- Task must be `open` or `assigned`
- Target agent must have `task: ["write"]` permission

---

## Document Writing Guidelines

### PRD Structure
```markdown
# PRD: <Feature Name>

## Background
Why this feature is needed.

## Requirements
### Functional Requirements
- FR-1: ...

### Non-Functional Requirements
- NFR-1: ...

## User Stories
- As a <role>, I want <action>, so that <benefit>

## Out of Scope
What is NOT included.
```

### Tech Design Structure
```markdown
# Technical Design: <Feature Name>

## Overview
High-level approach.

## Architecture
System design, component interactions.

## Data Model
Schema changes, new tables.

## API Design
New/modified endpoints.

## Module Contracts
Shared conventions across tasks: return value format, error handling pattern, cross-module call points.

## Implementation Plan
Step-by-step implementation order.

## Risks & Mitigations
Potential issues and how to address them.
```

### Task Writing Guidelines

Good tasks are:
- **Module-scoped** — One cohesive functional module per task, not a single function or file
- **Testable** — Clear, cohesive acceptance criteria are **required** on every task (at least one non-blank item; max 6; group related checks into one criterion but list key coverage, e.g. "All tests pass: service layer unit tests, API integration tests, edge case handling")
- **Sized** — 1-8 story points (hours of agent work)
- **Ordered** — Use `dependsOnDraftUuids` / `dependsOnTaskUuids` to express execution order
- **Descriptive** — Include enough context for a developer agent to start without questions. For tasks with cross-module dependencies, reference the tech design's Module Contracts in the AC
- **Integration checkpoints** — For DAGs with 4+ tasks, include at least one integration checkpoint task at a convergence point whose AC requires end-to-end execution of preceding modules together
- **Hallucination-aware** — When tasks involve external dependencies, note in the task description that developers should verify specifics (API signatures, CLI flags, config keys, model IDs, etc.) against official docs rather than relying on LLM memory

### Task Granularity

Each task should correspond to an **independently runnable and testable functional module** — not a single function, file, or API endpoint. Avoid splitting closely related functionality into separate tasks; the Chorus workflow overhead per task (claim → implement → self-test → submit → verify) adds up quickly.

**Bad → Good examples:**
- Bad: `Book Search` + `Book CRUD` (2 tasks) → Good: `Book Management` (1 task covering CRUD + Search for the same entity)
- Bad: `Chart Rendering` + `Statistics Calculation` (2 tasks) → Good: `Data Analytics` (1 task covering stats + visualization as one module)

---

## Tips

- Keep PRD focused on *what* and *why*; tech design focused on *how*
- Break large features into cohesive module-scoped tasks — but avoid over-splitting related functionality into too many tiny tasks
- Add `storyPoints` to help prioritize and estimate effort
- Keep acceptance criteria cohesive — group related verifications into one item rather than listing each check separately
- Always set up task dependency DAG — tasks without dependencies are assumed parallelizable
- When multiple tasks share data formats or call each other, define contracts in the tech design before writing task AC
- When combining multiple ideas, explain how they relate in the proposal description
- Always run the reviewer inline after submit (Step 5.5) — OpenClaw has no hook to remind you

---

## Next

- After submission, an Admin will review using `/review`
- After approval, Developers claim tasks using `/develop`
- For Idea elaboration, see `/idea`
- For platform overview, see `/chorus`
