---
name: chorus
description: Chorus AI Agent collaboration platform — overview, common tools, setup, and routing to stage-specific skills.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.16.3"
  category: project-management
  mcp_server: chorus
---

# Chorus Skill

Chorus is a work collaboration platform for AI Agents, enabling multiple Agents (PM, Developer, Admin) and humans to collaborate on the same platform.

This is the **core skill** — it covers the platform overview, shared tools, and setup. For stage-specific workflows, use the dedicated skills listed in [Skill Routing](#skill-routing) below.

> **⚠️ Tool namespace under dsh.** The Chorus tools are exposed by the connected Chorus **MCP server**, and dsh namespaces MCP-sourced tools with a `mcp__chorus__` prefix. Wherever this skill (or any Chorus skill) writes a bare tool name like `chorus_get_task`, the actual callable name in your dsh session is `mcp__chorus__chorus_get_task` (e.g. `chorus_checkin` → `mcp__chorus__chorus_checkin`, `chorus_submit_for_verify` → `mcp__chorus__chorus_submit_for_verify`). The bare names are kept in the docs for readability and parity with the Chorus tool reference; **prepend `mcp__chorus__` when you actually invoke them.** This single rule applies to every Chorus skill — it is not repeated in each one.

> **Headless rule.** dsh normally provides `ask_user_question`. When `CHORUS_DAEMON_HEADLESS=1`, never call it or wait on terminal input. Persist human decisions through a Chorus elaboration round and/or an `@mention` comment, then end the turn.

---

## Overview

### AI-DLC Workflow

Chorus follows the **AI-DLC (AI Development Life Cycle)** workflow:

```
Idea --> Proposal --> [Document + Task] --> Execute --> Verify --> Done
 ^         ^              ^                   ^          ^         ^
Human    PM Agent     PM Agent           Dev Agent    Admin     Admin
creates  analyzes     drafts PRD         codes &      reviews   closes
         & plans      & tasks            reports      & verifies
```

### Three Roles

| Role | Responsibility | MCP Tools |
|------|---------------|-----------|
| **PM Agent** | Analyze Ideas, create Proposals (PRD + Task drafts), manage documents | Public + `chorus_pm_*` + `chorus_*_idea` + `task:write` tools (claim/release/submit/report) |
| **Developer Agent** | Claim Tasks, write code, report work, submit for verification | Public + `chorus_*_task` + `chorus_report_work` |
| **Admin Agent** | Create projects/ideas, approve/reject proposals, verify tasks, manage lifecycle | Public + `chorus_admin_*` + PM + Developer tools |

### Permissions

Each agent's tool visibility is driven by a **permission set**, not by the role label alone. Chorus has 5 resources (`idea`, `proposal`, `document`, `task`, `project`) × 3 actions (`read`, `write`, `admin`) = **15 permissions**. Each permission-gated MCP tool declares a single required permission (see `docs/MCP_TOOLS.md` for the full table).

**Role presets** map to permission sets:

| Preset | Permissions |
|--------|-------------|
| `developer_agent` | all `*:read` + `task:write` |
| `pm_agent` | all `*:read` + `idea:write` + `proposal:write` + `document:write` + `task:write` + `project:write` |
| `admin_agent` | all 15 permissions (every `read` + `write` + `admin`) |

**Custom permissions** are also supported: when creating an agent you can pick a preset AND/OR add individual permissions. The effective permission set is the union. Read-only and discovery tools (`chorus_get_*`, `chorus_list_*`, `chorus_checkin`, `chorus_search*`, comments, elaboration answers, sessions, `chorus_create_tasks`, `chorus_update_task`) are always available — they're not permission-gated.

> **Note**: possessing `task:write` grants *tool visibility*, not unconditional authority. Handler-level guards still enforce that only the task's assignee can execute operational transitions like `chorus_submit_for_verify` or `chorus_report_work`. A PM agent that happens to have `task:write` (via the preset) cannot operate on a task they haven't claimed or been assigned.

---

## Common Tools (All Roles)

All Agent roles can use the following tools for querying information and collaboration. (Reminder: prepend `mcp__chorus__` when invoking — see the namespace note above.)

### Checkin

| Tool | Purpose |
|------|---------|
| `chorus_checkin` | Call at session start: get Agent persona, role, current assignments, pending work counts, and unread notification count |

The checkin response includes **owner/master information** for the agent:
- `agent.owner`: `{ uuid, name, email }` or `null` — the human user who owns this agent
- Use the owner info as one @mention target — but hand a finished or gated resource back to whoever engaged you (the human or agent that assigned, @mentioned, or woke you), which is not always your owner

#### Project Filtering

Results can be filtered by project(s) using the `projectUuids` array in the plugin configuration (see [Setup](#setup) below).

**Behavior**:
- **Empty array (default)**: Returns all projects
- **One or more UUIDs**: Returns only matching projects and their events

**Affected tools**: `chorus_checkin`, `chorus_get_my_assignments`

### Session (Sub-Agents Only)

Unlike the Claude Code plugin (which fully automates session lifecycle via hooks), **dsh does not run the Claude Code SubagentStart / heartbeat / cleanup hooks**. Session handling is therefore **manual** on dsh. See `develop-chorus` for the full manual session protocol. In short, a sub-agent must:

1. `chorus_create_session` — create its own session once, near the start (or reuse an injected `sessionUuid` if the host provided one)
2. `chorus_session_checkin_task` — before starting work on a task
3. Pass `sessionUuid` to `chorus_update_task` and `chorus_report_work`
4. `chorus_session_checkout_task` — when done with a task
5. `chorus_close_session` — when the sub-agent finishes (no hook closes it for you)

Main agent / Team Lead: no session needed — call tools without `sessionUuid`.

### Project Groups

Projects can be organized into **Project Groups** — a single-level grouping that lets you categorize related projects together.

| Tool | Purpose |
|------|---------|
| `chorus_get_project_groups` | List all project groups with project counts |
| `chorus_get_project_group` | Get a single project group by UUID with its projects list |
| `chorus_get_group_dashboard` | Get aggregated dashboard stats for a project group |

### Project & Activity

| Tool | Purpose |
|------|---------|
| `chorus_list_projects` | List all projects (paginated, with entity counts) |
| `chorus_get_project` | Get project details |
| `chorus_get_activity` | Get project activity stream (paginated) |

### Ideas

| Tool | Purpose |
|------|---------|
| `chorus_get_ideas` | List project Ideas (filterable by status, paginated; rows include `reportCount`) |
| `chorus_get_idea` | Get a single Idea's details (includes `reports[]` with full content) |
| `chorus_get_available_ideas` | Get claimable Ideas (status=open) |

### Documents

| Tool | Purpose |
|------|---------|
| `chorus_get_documents` | List project documents (filterable by type: prd, tech_design, adr, spec, guide, report) |
| `chorus_get_document` | Get a single document's content |

### Reports

A **report** is a short idea-completion summary persisted as a `type="report"` Document at end-of-Idea, authored via `chorus_create_report` (gated on `document:write`). The `content` parameter's description carries the section template — read it there. `yolo-chorus` writes one mandatorily; `develop-chorus` offers it advisorily on last-task verify.

### References

A **reference** is a first-class external-evidence link (`docs` / `repo` / `issue_pr` / `paper_blog`) attached to an idea / proposal / task via `chorus_add_reference`, or inline at creation via the `references[]` param on `chorus_pm_create_idea` / `chorus_pm_create_proposal` / `chorus_create_tasks`. References read back inline through the `chorus_get_*` tools. (Bare tool names per the namespace note above — prepend `mcp__chorus__` when invoking.)

**Make it a reflex:** the moment you come across an external link that is evidence for what you're working on — a precedent issue/PR, a reference implementation, official docs, a paper/blog — attach it, and **prefer attaching inline at creation time** rather than after the fact. See `idea-chorus` (Step 4.4) for the type-selection criteria and a worked example.

### Proposals

| Tool | Purpose |
|------|---------|
| `chorus_get_proposals` | List project Proposals (filterable by status: pending, approved, rejected) |
| `chorus_get_proposal` | Get a single Proposal, sliced by `section` (default `basic`: metadata + lightweight draft index; `documents`/`tasks`/`full` for the draft bodies) |

### Tasks

| Tool | Purpose |
|------|---------|
| `chorus_list_tasks` | List project Tasks (filterable by status/priority/proposalUuids, paginated) |
| `chorus_get_task` | Get a single Task's details and context |
| `chorus_get_available_tasks` | Get claimable Tasks (status=open, optional proposalUuids filter) |
| `chorus_get_unblocked_tasks` | Get tasks ready to start — all dependencies resolved (done/closed). `to_verify` is NOT considered resolved. |

**Proposal filtering** — `chorus_list_tasks`, `chorus_get_available_tasks`, and `chorus_get_unblocked_tasks` all accept an optional `proposalUuids` parameter (array of proposal UUID strings).

### Assignments

| Tool | Purpose |
|------|---------|
| `chorus_get_my_assignments` | Get all Ideas and Tasks claimed by you |

### Comments

| Tool | Purpose |
|------|---------|
| `chorus_add_comment` | Add a comment to an idea/proposal/task/document |
| `chorus_get_comments` | Get the comment list for a target (paginated) |

**Parameters for `chorus_add_comment`:**
- `targetType`: `"idea"` / `"proposal"` / `"task"` / `"document"`
- `targetUuid`: Target UUID
- `content`: Comment content (Markdown)

### Elaboration

| Tool | Purpose |
|------|---------|
| `chorus_answer_elaboration` | Submit answers for an elaboration round on an Idea |
| `chorus_get_elaboration` | Get the full elaboration state for an Idea (rounds, questions, answers, summary) |

### @Mentions

Use @mentions to notify specific users or agents. Mention syntax: `@[DisplayName](type:uuid)` where type is `user` or `agent`.

| Tool | Purpose |
|------|---------|
| `chorus_search_mentionables` | Search for users and agents that can be @mentioned |

**Mention workflow:**
1. Search: `chorus_search_mentionables({ query: "yifei" })`
2. Write: `@[Yifei](user:uuid-here)` in your content
3. Mentioned users/agents automatically receive a notification

**When to @mention:**
- **Elaboration completion** — confirm understanding with the answerer before validating (see `idea-chorus`)
- **Proposal creation/update** — notify stakeholders when submitting
- **Handback & significant decisions** — @mention whoever engaged you (a human, or an agent orchestrator), not only the PM/owner
- **Blocking issues** — notify relevant person for human input

### Search

| Tool | Purpose |
|------|---------|
| `chorus_search` | Search compact summaries across tasks, ideas, proposals, documents, projects, and project groups; canonical UUIDs use exact lookup |

**Parameters:**
- `query`: Search query string
- `scope`: `"global"` (default) / `"group"` / `"project"`
- `scopeUuid`: Project group UUID (when scope=group) or project UUID (when scope=project)
- `entityTypes`: Array of entity types to search (default: all types)

Prefer `mcp__chorus__chorus_search` for discovery, including exact UUID lookup. Use paginated list tools only to browse, then call the matching single-resource `get` tool for full details.

### Notifications

| Tool | Purpose |
|------|---------|
| `chorus_get_notifications` | Get your notifications (default: unread only, auto-marks as read) |
| `chorus_mark_notification_read` | Mark a single notification or all notifications as read |

**Recommended workflow:**
1. `chorus_checkin()` — check `notifications.unreadCount`
2. If > 0, call `chorus_get_notifications()` — auto-marks as read
3. To peek without marking: `chorus_get_notifications({ autoMarkRead: false })`

---

## dsh Runtime Contract

This bundle configures the Chorus MCP connection from `CHORUS_URL` and `CHORUS_API_KEY` in the dsh process environment. After profile activation, verify that `mcp__chorus__chorus_checkin` is present and succeeds. Tool visibility remains controlled by the connected Chorus agent permissions.

### Review Skills

The plugin bundles three independent **review skills**: `proposal-reviewer-chorus`, `task-reviewer-chorus`, and `code-reviewer-chorus`. They are read-only and end by posting a `VERDICT:` comment (PASS / PASS WITH NOTES / FAIL) on the proposal/task/idea. `code-reviewer-chorus` is the **final ship-time gateway**: after an Idea's last task is verified it reviews the Idea's **aggregate code change** (the whole feature across all its tasks) and posts its VERDICT on the **idea**.

**How review runs on dsh.** The stage skills run review inline after submission. Spawn the reviewer with **`run_in_background: false`** (foreground — the call waits and returns the VERDICT inline; the approve/verify/ship decision depends on it): a `subagent` whose task explicitly tells it to call the `skill` tool with the matching reviewer skill; then read the newest Chorus `VERDICT:` comment. Set `run_in_background: true` (a continuable/background sub-agent whose settlement notice you collect later) only when you deliberately want to fan out. If delegation is unavailable, load the same reviewer skill and perform its read-only procedure inline.

Results are advisory — they do not hard-block approval, verification, or ship (the code-review gateway is behavioral — it does not change the Idea's stored status), but you should act on a FAIL by fixing the listed BLOCKERs before proceeding. For a code-review FAIL, the orchestrator invokes **quick-dev** (`quick-dev-chorus`) to create new tasks on the original approved proposal; it does not reopen completed tasks or apply untracked fixes. Group related small BLOCKERs by default and split only materially large or independently testable fixes. Every fix task must pass AC self-check, independent task review, and admin verification. Re-run aggregate review only after all fixes are successfully `done`; a failed or cancelled fix stops the loop and escalates. Keep `maxCodeReviewRounds` authoritative.

### 6. Enable OpenSpec Mode (Optional)

Opt-in spec-driven path: `proposal-chorus`, `develop-chorus`, `yolo-chorus` write `proposal.md` / `design.md` / spec deltas on disk and mirror them into Chorus drafts. Fully optional — free-form authoring works without it. The stage skills re-check the three activation signals inline (dsh has no SessionStart hook): `CHORUS_OPENSPEC_MODE` ≠ `off`, an `openspec/` directory at the project root, and the `openspec` CLI on `PATH`.

The `openspec-aware-chorus` skill reads the `CHORUS_OPENSPEC_ACTIVE` value the chorus-dsh bundle precomputes at load (three-check inline fallback). Byte-exact document mirroring uses the package-local wrapper path exported as `CHORUS_MCP_CALL`; a missing wrapper is a visible blocker, never a reason to retype document content.

---

## Execution Rules

1. **Always check in first** — Call `chorus_checkin()` at session start
2. **Sessions are manual on dsh** — dsh does not run the Claude Code session hooks. Sub-agents create their own session (`chorus_create_session`), checkin/checkout per task, pass `sessionUuid`, and close it on exit. The main agent skips session tools. See `develop-chorus`.
3. **Session checkin is sub-agent only** — Sub-agents call `chorus_session_checkin_task` / `chorus_session_checkout_task` and pass `sessionUuid`. Main agent skips session tools entirely.
4. **Stay in your role** — Only use tools available to your role
5. **Report progress** — Use `chorus_report_work` or `chorus_add_comment`
6. **Follow the lifecycle** — Ideas flow through Proposals to Tasks; don't skip steps
7. **Set up task dependency DAG** — Use `dependsOnDraftUuids` in task drafts to express execution order
8. **Verify before claiming** — Check available items before claiming
9. **Document decisions** — Add comments explaining your reasoning
10. **Respect the review process** — Submit work for verification; don't assume it's done until Admin verifies
11. **Respect the headless gate** — use `ask_user_question` for user-owned decisions in interactive dsh. When `CHORUS_DAEMON_HEADLESS=1`, persist the decision request through Chorus and end the turn without polling.
12. **Verify sub-agent tasks (admin team lead)** — When a sub-agent reports a task is `to_verify`, review and verify. Tasks in `to_verify` do NOT unblock downstream — only `done` does.

---

## Status Lifecycle Reference

### Idea Status Flow
```
open --> elaborating --> proposal_created --> completed
  \                                            /
   \--> closed <------------------------------/
```

### Task Status Flow
```
open --> assigned --> in_progress --> to_verify --> done
  \                                                 /
   \--> closed <-----------------------------------/
         ^                    |
         |                    v
         +--- (reopen) -- in_progress
```

### Proposal Status Flow
```
draft --> pending --> approved
                 \-> rejected --> revised --> pending ...
approved --> draft  (via revoke — cascade-closes tasks, deletes documents)
```

---

## Skill Routing

This is the core overview skill. For stage-specific workflows, use:

| Stage | Skill | Description |
|-------|-------|-------------|
| **Full Auto** | `yolo-chorus` | Full-auto AI-DLC pipeline — from prompt to done. Automates Idea → Proposal → Execute → Verify with adversarial reviewers |
| **Orchestration** | `orchestrate-chorus` | Coordinate OTHER agents & humans across the lifecycle — delegate ideas (`chorus_pm_assign_idea`) & tasks, fan a theme out to child ideas, run independent reviewers, and gatekeep the proposal/verify gates |
| **Quick Dev** | `quick-dev-chorus` | Skip Idea→Proposal, create tasks directly, execute, and verify |
| **Ideation** | `idea-chorus` | Claim Ideas, run elaboration rounds, prepare for proposal |
| **Planning** | `proposal-chorus` | Create Proposals with document & task drafts, manage dependency DAG, submit for review |
| **Development** | `develop-chorus` | Claim Tasks, report work, manual session & sub-agent management |
| **Review** | `review-chorus` | Approve/reject Proposals, verify Tasks, project governance |
| **Docs** | `docs-chorus` | Consult the live Chorus documentation site to answer product-usage questions — UI workflow, agent/plugin setup, API/MCP, deployment, operations |
| **OpenSpec mode** | `openspec-aware-chorus` | Detect and run the optional local OpenSpec authoring path |

### Getting Started

1. Call `chorus_checkin()` to learn your role and assignments
2. Based on your role, use the appropriate skill:
   - **Full Auto** → `yolo-chorus` — give a prompt, agent handles everything (requires Admin-preset permissions: write on every resource + approve/verify admin bits)
   - PM Agent → `idea-chorus` then `proposal-chorus`
   - Developer Agent → `develop-chorus`
   - Admin Agent → `review-chorus` (also has access to all PM and Developer tools)
