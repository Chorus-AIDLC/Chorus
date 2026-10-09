---
name: proposal
description: Chorus Proposal workflow on Hermes — create proposals with document and task drafts, manage dependency DAG, validate, submit, and run the read-only proposal reviewer via delegate_task.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.22.1"
  category: project-management
  mcp_server: chorus
---

# Proposal Skill

This skill covers the **Planning** stage of the AI-DLC workflow: creating Proposals that contain document drafts (PRD, tech design) and task drafts with dependency DAGs, then submitting them for Admin review.

---

## Overview

After an Idea's elaboration is resolved (see the idea skill, `skill_view("chorus:idea")`), the PM Agent creates a Proposal — a container that holds document drafts and task drafts. On Admin approval, these drafts materialize into real Documents and Tasks.

```
Elaboration resolved --> Create Proposal --> Add drafts --> Validate --> Submit --> Reviewer --> Admin review
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

**Shared tools** (checkin, query, comment, search, notifications): see the overview skill (`skill_view("chorus:chorus")`)

---

## Workflow

### Step 0: Reuse Evidence and Check New Factual Gaps

Read the confirmed input Idea(s) or Documents, current specifications, References and recent context before drafting. Reuse existing findings first; invoke the research skill (`skill_view("chorus:research")`, shared rules) only for a new factual design gap or explicit user request, subject to explicit skip. Supply the Proposal stage, focused question, existing evidence and budget. Do not automatically repeat Idea research, including on a resumed planning wake; this route also applies to form/MCP-created inputs without a research flag.

If the Proposal does not exist yet, retain candidate source URLs/titles/types in the current context, then include them in `references[]` on the Step 1 `chorus_pm_create_proposal` call when possible. Read `chorus_get_proposal` afterward to obtain actual `references[].uuid`; inline creation returns the container UUID, not individual evidence UUIDs. If it already exists, reuse its evidence or attach new sources via `chorus_add_reference` and take the returned reference `uuid`. Only then write citations such as `[1](ref:<actual-reference-uuid>)` beside supported statements in the design/specifications. Never invent UUIDs or substitute the Proposal UUID.

In OpenSpec/spec-lite modes, resolve the existing spec mode and locator as below, update authoritative local files with findings and real citations, then mirror file bytes using `chorus mcp call … --arg-file content=<file>` via `terminal` (or, when `chorus` is not on `PATH`, the native MCP tool with `content` set to the exact file contents read via `read_file`). No hand-typed MCP document `content`; spec-lite's durable `spec.md` remains local-only. Free-form mode keeps its normal draft-saving path. Empty/partial results preserve unknowns and continue preparation. Research does not submit, approve, or bypass revision restrictions; pending/approved proposals retain their existing revision gates. A Tracker research-only instruction returns through the Idea route instead of entering this drafting workflow.

### Step 1: Create an Empty Proposal

**Resolve the spec mode (Step 1.5) BEFORE this create.** In OpenSpec and spec-lite modes the container's `description` MUST carry a locator line (`OpenSpec change slug: <slug>` or `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`), and `description` can only be set at creation — decide the mode + slug/dated-path first and include that line in this single call. Do NOT create a bare container and then realize you needed it. Free-form mode omits any locator line.

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

> **A theme cannot be a proposal input** — `chorus_pm_create_proposal` rejects any input idea with `isContainer = true`. Derive a child idea from the theme and write the proposal on the child instead. (See the theme-ideas section of the idea skill, `skill_view("chorus:idea")`.)

### Step 1.5: Select spec mode

The spec mode is **already computed for you** by the Chorus Hermes plugin — do NOT re-derive it. Its `pre_llm_call` check-in (first turn of each session, and again after /reset or context compression) resolves the mode with the plugin's `spec_mode.py` (explicit `CHORUS_SPEC_MODE` wins; otherwise `openspec` when an `openspec/` directory and the `openspec` CLI are both present in the working directory; otherwise `lite`) and injects it as the `## Spec Mode` section of your context: it states `CHORUS_SPEC_MODE=<lite|openspec|off>` + a routing note. (No `## Spec Mode` in context, e.g. you are a `delegate_task` child? See `openspec-aware` §1 manual fallback via `skill_view("chorus:openspec-aware")` — never hand-roll the rule.) Act on that value:

- If the section says the mode **cannot be honored** (explicit `CHORUS_SPEC_MODE=openspec` but OpenSpec unusable — config-conflict or install-hint reason), **halt** and surface it; do not fall back.
- Otherwise branch on the resolved mode:

- **resolved = spec-lite** → load the `spec-lite` skill (`skill_view("chorus:spec-lite")`) and follow it: pick `$SLUG` (a **capability**, not one change). Ensure the durable `.chorus/specs/<slug>/spec.md` exists (local-only, **no Chorus ids**; use the `spec-lite` skill's inline durable-spec template) and update it in place. Create this change's **dated folder** `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` with its **synced** Chorus-typed docs (`prd.md` primary, optional `tech_design.md`…; use the `spec-lite` skill's inline dated-folder document template). Put the literal locator line `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` in the **Step 1 create** `description`, then mirror **each** dated-folder `<type>.md` to its persistent Document (`chorus_pm_add_document_draft --arg-file` first time, `chorus_pm_update_document --arg-file` after) via `chorus mcp call … --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/<type>.md` (run through `terminal`; see `skill_view("chorus:chorus-cli")`). **`spec.md` is never mirrored.** Skip Step 2 below. (Tasks via `chorus_pm_add_task_draft`; no `tasks.md`.)

- **resolved = OpenSpec** (the `## Spec Mode` section shows `CHORUS_OPENSPEC_ACTIVE=1` — i.e. `CHORUS_SPEC_MODE=openspec` *or* unset, with OpenSpec usable) → follow the `openspec-aware` skill §3 (`skill_view("chorus:openspec-aware")`). Pick `$SLUG`, scaffold `openspec/changes/<slug>/`, author `proposal.md` / `design.md` / `specs/<capability>/spec.md` locally, then put the literal line `OpenSpec change slug: <slug>` in the **Step 1 create** `description`, and mirror each local file into a document draft.

  > **⛔ Mandatory in OpenSpec mode:** mirror calls fill `content` from the local file — prefer `chorus mcp call … --arg-file content=<file>` run via `terminal`; when `chorus` is not on `PATH`, fall back to calling the native MCP tool (`mcp__chorus__chorus_pm_add_document_draft` / `mcp__chorus__chorus_pm_update_document_draft`) with `content` set to the exact bytes of the file as returned by `read_file` — see `openspec-aware` §3.6. Do **not** call `chorus_pm_add_document_draft` with a hand-typed or paraphrased `content` field. Re-typing thousands of lines burns 20k+ content tokens per proposal and breaks byte-equality (`openspec-aware` §2 Rule 1). Skip Step 2 when in OpenSpec mode — the file-fill flow replaces it for documents.

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

When validation passes:

```
chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
```

This changes the status from `draft` to `pending`. An Admin will review it (see `skill_view("chorus:review")`).

Add a comment explaining your reasoning:

```
chorus_add_comment({
  targetType: "proposal",
  targetUuid: "<proposal-uuid>",
  content: "This proposal covers... Key decisions: ..."
})
```

### Step 5.5: Run the Proposal Reviewer

The Chorus Hermes plugin's `transform_tool_result` hook appends a reminder to the `chorus_pm_submit_proposal` result: run the independent, read-only `chorus-proposal-reviewer` before admin approval. Run it as a `delegate_task` child:

```
delegate_task(
  goal="[chorus-reviewer:proposal] Review Chorus proposal <proposal-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:proposal]\nFirst call skill_view(\"chorus:chorus-proposal-reviewer\") and follow it.\nProposal UUID: <proposal-uuid>\nProject UUID: <project-uuid>\nMax review rounds: 3\nFirst read existing comments to determine the round number; post VERDICT as a comment.\nRepo: <abs path>"
)
```

- The marker `[chorus-reviewer:proposal]` MUST be the first line of `context` (keep it in `goal` too). The plugin uses it to run the child under the read-only reviewer guard: Chorus write tools other than `chorus_add_comment` are blocked, as are `write_file`, `patch`, `terminal`, `execute_code`, and `delegate_task`.
- The child starts with an isolated context and knows nothing of this conversation. Put everything it needs (proposal/project UUIDs, round cap, repo path, any local spec file paths it should `read_file`) in `context`.
- `delegate_task` blocks until the reviewer finishes and returns its summary; nothing needs tracking or closing.

After it returns, read the comments with `chorus_get_comments({ targetType: "proposal", targetUuid: "<proposal-uuid>" })` and find THIS round's `VERDICT:` line — the comment posted after you dispatched the reviewer, not an older round's:

- **VERDICT: PASS** — No issues. Proceed to `chorus_admin_approve_proposal` (if you hold `proposal:admin` and the human has delegated approval to you; otherwise leave it for the Admin).
- **VERDICT: PASS WITH NOTES** — Minor notes. Still approve.
- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject with `chorus_pm_reject_proposal`, fix, resubmit (Step 6), and run the reviewer again — up to the 3-round cap.

### Step 6: Handle Feedback

After submission, the `chorus-proposal-reviewer` (Step 5.5) posts a VERDICT comment. If the VERDICT is **FAIL**, or an Admin rejects the proposal, you need to revise and resubmit.

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

4. **Resubmit:**
   ```
   chorus_pm_submit_proposal({ proposalUuid: "<proposal-uuid>" })
   ```
   Then run the reviewer again (Step 5.5) for the next round.

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

# Optional: pin the task to a specific (agent, host, cwd) AgentInstance
chorus_pm_assign_task({ taskUuid: "<task-uuid>", agentUuid: "<developer-agent-uuid>", instanceUuid: "<agent-instance-uuid>" })
```

- Task must be `open` or `assigned`
- Target agent must have `task: ["write"]` permission
- Pass `instanceUuid` to pin the task to a specific online instance (assigns as `agent_instance`); omit it for a plain `agent` assignment that inherits the root idea's pinned instance at wake time

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

---

## Next

- After submission, an Admin will review using the review skill (`skill_view("chorus:review")`)
- After approval, Developers claim tasks using the develop skill (`skill_view("chorus:develop")`)
- For Idea elaboration, see `skill_view("chorus:idea")`
- For platform overview, see `skill_view("chorus:chorus")`
