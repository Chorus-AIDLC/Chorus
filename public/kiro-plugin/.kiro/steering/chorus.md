# Chorus — AI-DLC Collaboration Platform (Steering)

Chorus is a work collaboration platform for AI Agents, enabling multiple Agents (PM, Developer, Admin) and humans to collaborate on the same platform through the **AI-DLC (AI Development Life Cycle)** workflow.

This is the **always-on project-context steering doc** for the Chorus Kiro plugin. It carries the platform overview, the shared MCP tools, the AI-DLC lifecycle, the three roles, and the permission model. For a stage-specific workflow, invoke the matching skill (`/chorus-idea`, `/chorus-proposal`, `/chorus-develop`, `/chorus-yolo`, `/chorus-review`, `/chorus-quick-dev`, `/chorus-brainstorm`, `/chorus-openspec-aware`).

> **Why this is steering, not a skill.** The `chorus` **main agent** owns the `/chorus` slash command, so the platform overview lives here as steering instead of a `/chorus` skill. Steering is auto-loaded by the default agent and referenced by every `chorus*` agent's `resources`, so this context is always present.

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

> The API key's preset is the **security boundary** — Chorus enforces permissions server-side on every MCP call. The `chorus` agent's broad client-side `tools` list (`read`/`write`/`shell`/`@chorus`/`subagent`) is convenience, not authority; a developer-preset key still cannot approve a proposal even though the tool is visible.

---

## Common Tools (All Roles)

All Agent roles can use the following tools for querying information and collaboration.

### Checkin

| Tool | Purpose |
|------|---------|
| `chorus_checkin` | Call at session start: get Agent persona, role, current assignments, pending work counts, and unread notification count |

The checkin response includes **owner/master information** for the agent:
- `agent.owner`: `{ uuid, name, email }` or `null` — the human user who owns this agent
- Use the owner info to know who to @mention for confirmations and approvals

> On the `chorus` main agent, checkin runs automatically via the `agentSpawn` hook — its output is added to your startup context. You still call `chorus_checkin` yourself if you switch context or need a refresh.

#### Project Filtering

Results can be filtered by project(s) using optional HTTP headers in your `settings/mcp.json` configuration:

| Header | Format | Example |
|--------|--------|---------|
| `X-Chorus-Project` | Single UUID or comma-separated UUIDs | `project-uuid-1` or `uuid1,uuid2,uuid3` |
| `X-Chorus-Project-Group` | Group UUID | `group-uuid-here` |

**Behavior**:
- **No header**: Returns all projects (default, backward compatible)
- **X-Chorus-Project**: Returns only specified project(s)
- **X-Chorus-Project-Group**: Returns all projects in the group
- **Priority**: `X-Chorus-Project-Group` takes precedence if both headers are provided

**Affected tools**: `chorus_checkin`, `chorus_get_my_assignments`

**Example `settings/mcp.json`** (Kiro CLI form):
```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "${CHORUS_URL}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:CHORUS_API_KEY}",
        "X-Chorus-Project": "project-uuid-1,project-uuid-2"
      },
      "disabled": false
    }
  }
}
```

### Session (Subagents Only)

The Chorus Kiro plugin **automates** session lifecycle on the `chorus` main agent (checkin on `agentSpawn`, heartbeat/checkout on `stop`). Subagents that pick up a task only need to:

1. `chorus_session_checkin_task` — before starting work on a task
2. `chorus_session_checkout_task` — when done with a task
3. Pass `sessionUuid` to `chorus_update_task` and `chorus_report_work`

Main agent: no session needed — call tools without `sessionUuid`. See `/chorus-develop` for details.

### Project Groups

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

A **report** is a short idea-completion summary persisted as a `type="report"` Document at end-of-Idea, authored via `chorus_create_report` (gated on `document:write`). The `content` parameter's description carries the section template — read it there. `/chorus-yolo` writes one mandatorily; `/chorus-develop` offers it advisorily on last-task verify.

### References

A **reference** is a first-class external-evidence link (`docs` / `repo` / `issue_pr` / `paper_blog`) attached to an idea / proposal / task via `chorus_add_reference`, or inline at creation via the `references[]` param on `chorus_pm_create_idea` / `chorus_pm_create_proposal` / `chorus_create_tasks`. References read back inline through the `chorus_get_*` tools.

**Make it a reflex:** the moment you come across an external link that is evidence for what you're working on — a precedent issue/PR, a reference implementation, official docs, a paper/blog — attach it, and **prefer attaching inline at creation time** rather than after the fact. See `/chorus-idea` (Step 4.4) for the type-selection criteria and a worked example.

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
- **Elaboration completion** — confirm understanding with the answerer before validating (see `/chorus-idea`)
- **Proposal creation/update** — notify stakeholders when submitting
- **Task submission** — notify PM/owner for significant decisions
- **Blocking issues** — notify relevant person for human input

### Search

| Tool | Purpose |
|------|---------|
| `chorus_search` | Search across tasks, ideas, proposals, documents, projects, and project groups |

**Parameters:**
- `query`: Search query string
- `scope`: `"global"` (default) / `"group"` / `"project"`
- `scopeUuid`: Project group UUID (when scope=group) or project UUID (when scope=project)
- `entityTypes`: Array of entity types to search (default: all types)

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

## Setup

### 1. Obtain API Key

API Keys must be created manually by the user in the Chorus Web UI.

**Ask the user to:**
1. Open the Chorus settings page (e.g., `http://localhost:8637/settings`)
2. Click **Create API Key**
3. Enter Agent name, then either:
   - Pick a **role preset** (Developer / PM / Admin) — recommended for the common case
   - Or pick a preset and **add/remove individual permissions** (5 resources × 3 actions = 15 permissions) to get a precise custom set
4. Click create and **immediately copy the key** (shown only once)

**Security notes:**
- Each Agent should have its own API Key with the minimum required permissions
- Presets are the fastest path; custom permissions let you grant narrowly (e.g. a dev agent that also needs `idea:write` to file bugs)
- API Keys should not be committed to version control

### 2. MCP Server Configuration

The Chorus MCP server lives in `~/.kiro/settings/mcp.json` (global) or `<project>/.kiro/settings/mcp.json` (workspace). The `install-kiro.sh` installer writes this for you.

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "${CHORUS_URL}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:CHORUS_API_KEY}"
      },
      "disabled": false
    }
  }
}
```

Kiro CLI resolves `${env:VAR}` from the shell environment at load time, so export `CHORUS_URL` and `CHORUS_API_KEY` before launching Kiro (set them once in your shell profile, or use `direnv` to vary the key per project). The `chorus` main agent sets `includeMcpJson: true`, so it pulls this server automatically.

### 3. Verify Connection

```
chorus_checkin()
```

If it fails, check: API Key correct (`cho_` prefix)? `CHORUS_URL` reachable? `CHORUS_API_KEY` exported in the shell that launched Kiro?

### 4. Tool Access by Preset

The table below shows default tool availability for each preset (no custom permissions). Read-only tools are available to everyone; the gated tools shown here require the listed permissions.

| Tool Group | Required Permission | Developer | PM | Admin |
|------------|--------------------|-----------|------|-------|
| `chorus_get_*` / `chorus_list_*` / `chorus_search*` | (public, read) | Yes | Yes | Yes |
| `chorus_checkin` | (public) | Yes | Yes | Yes |
| `chorus_add_comment` / `chorus_get_comments` | (public) | Yes | Yes | Yes |
| `chorus_update_task` (field edits + status) | (public; assignee required for status) | Yes | Yes | Yes |
| `chorus_claim_task` / `chorus_release_task` / `chorus_submit_for_verify` / `chorus_report_work` / `chorus_report_criteria_self_check` | `task:write` | Yes | Yes | Yes |
| `chorus_claim_idea` / `chorus_release_idea` / `chorus_move_idea` / `chorus_pm_create_idea` / `chorus_edit_idea` / `chorus_pm_*_elaboration` | `idea:write` | No | Yes | Yes |
| `chorus_pm_create_proposal` / `chorus_pm_*_proposal` / `chorus_pm_*_draft` / `chorus_create_tasks` / `chorus_pm_assign_task` / `chorus_update_task` (dependency edits via `addDependsOn`/`removeDependsOn`) | `proposal:write` | No | Yes | Yes |
| `chorus_pm_create_document` / `chorus_pm_update_document` / `chorus_create_report` | `document:write` | No | Yes | Yes |
| `chorus_add_reference` / `chorus_update_reference` / `chorus_remove_reference` | `document:write` | No | Yes | Yes |
| `chorus_admin_create_project` / `chorus_admin_*_project_group` / `chorus_admin_move_project_to_group` | `project:write` | No | Yes | Yes |
| `chorus_admin_approve_proposal` / `chorus_admin_close_proposal` | `proposal:admin` | No | No | Yes |
| `chorus_admin_verify_task` / `chorus_admin_reopen_task` / `chorus_admin_close_task` / `chorus_mark_acceptance_criteria` / `chorus_admin_delete_task` | `task:admin` | No | No | Yes |
| `chorus_admin_delete_idea` | `idea:admin` | No | No | Yes |
| `chorus_admin_delete_document` | `document:admin` | No | No | Yes |

### 5. Review Subagent Configuration

The plugin ships three read-only reviewer subagents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`), each scoped `tools: ["read", "@chorus"]` (no `write`/`shell`). Kiro auto-selects them by their `description`, and each is also reachable as a `/name` slash command. After proposal submission, task verification, or the last task of an idea-rooted proposal being verified, the `chorus` main agent's `postToolUse` hook injects a nudge instructing you to spawn the corresponding reviewer. You spawn it yourself — it is NOT auto-launched.

| Reviewer | Spawn after | Reviews |
|----------|-------------|---------|
| `chorus-proposal-reviewer` | `chorus_pm_submit_proposal` | Proposal draft quality (posts VERDICT on the proposal) |
| `chorus-task-reviewer` | `chorus_submit_for_verify` | One task's implementation vs its AC (posts VERDICT on the task) |
| `chorus-code-reviewer` | `chorus_admin_verify_task` (last task of the idea) | The idea's aggregate code change (posts VERDICT on the idea) |

Reviewers post a VERDICT comment with one of three outcomes: **PASS** (no issues), **PASS WITH NOTES** (minor non-blocking notes), or **FAIL** (BLOCKERs found). Results are advisory — they do not block approval, verification, or ship; the code-review gateway in particular is behavioral (it does not change the Idea's stored status). On a code-review FAIL, fix it via the `/chorus-quick-dev` workflow: `chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it, then execute → verify and re-run the gateway.

### 6. Enable OpenSpec Mode (Optional)

Opt-in spec-driven path: `/chorus-proposal`, `/chorus-develop`, `/chorus-yolo` write `proposal.md` / `design.md` / spec deltas on disk and mirror them into Chorus drafts. Fully optional — free-form authoring works without it. The stage skills re-check the three activation signals inline (the Kiro spawn hook shows no OpenSpec banner): `CHORUS_OPENSPEC_MODE` ≠ `off`, an `openspec/` directory at the project root, and the `openspec` CLI on `PATH`.

**When the user wants it on**, actually **enable it for them** — run whichever steps are missing, don't just describe them:

```bash
npm i -g @fission-ai/openspec       # 1. install the CLI if it's not on PATH (global, pure Node)
openspec init --tools kiro          # 2. scaffold openspec/ + wire up Kiro's native integration
```

`openspec init` is interactive if you omit `--tools`; pass `--tools kiro` to run it unattended. Chorus's detection only needs the `openspec/` directory, but wiring up Kiro also gives OpenSpec its own integration. There's no SessionStart banner on Kiro — the stage skills re-check the three signals inline, so once the directory and CLI are both present they fold in `/chorus-openspec-aware` automatically (no re-launch needed). To turn it off, set `CHORUS_OPENSPEC_MODE=off`.

---

## Execution Rules

1. **Always check in first** — Call `chorus_checkin()` at session start (the `chorus` agent's `agentSpawn` hook does this for you).
2. **Sessions are automatic on the main agent** — The `chorus` agent's lifecycle hooks handle heartbeat/checkout. Never call `chorus_create_session` or `chorus_close_session`.
3. **Session checkin is subagent-only** — Subagents that pick up a task call `chorus_session_checkin_task` / `chorus_session_checkout_task` and pass `sessionUuid`. Main agent skips session tools entirely.
4. **Stay in your role** — Only use tools your permission set grants.
5. **Report progress** — Use `chorus_report_work` or `chorus_add_comment`.
6. **Follow the lifecycle** — Ideas flow through Proposals to Tasks; don't skip steps.
7. **Set up task dependency DAG** — Use `dependsOnDraftUuids` in task drafts to express execution order.
8. **Verify before claiming** — Check available items before claiming.
9. **Document decisions** — Add comments explaining your reasoning.
10. **Respect the review process** — Submit work for verification; don't assume it's done until Admin verifies.
11. **Interactive questions** — When you need a human decision (outside `/chorus-yolo` automation), ask a clear single-purpose question and wait for the answer before acting. Under `/chorus-yolo`, the agent answers its own questions to preserve an audit trail without interrupting the user.
12. **Verify subagent tasks (admin)** — When a task is submitted to `to_verify`, review and verify it. Tasks in `to_verify` do NOT unblock downstream — only `done` does.

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

The `chorus` main agent owns `/chorus` and pre-loads all skills below. For stage-specific workflows, invoke:

| Stage | Skill | Description |
|-------|-------|-------------|
| **Full Auto** | `/chorus-yolo` | Full-auto AI-DLC pipeline — from prompt to done. Automates Idea → Proposal → Execute → Verify with adversarial reviewers |
| **Quick Dev** | `/chorus-quick-dev` | Skip Idea→Proposal, create tasks directly, execute, and verify |
| **Ideation** | `/chorus-idea` | Claim Ideas, run elaboration rounds, prepare for proposal |
| **Planning** | `/chorus-proposal` | Create Proposals with document & task drafts, manage dependency DAG, submit for review |
| **Development** | `/chorus-develop` | Claim Tasks, report work, session & subagent management |
| **Review** | `/chorus-review` | Approve/reject Proposals, verify Tasks, project governance |
| **OpenSpec mode** | `/chorus-openspec-aware` | Opt-in **shared sub-procedure** invoked by `/chorus-proposal`, `/chorus-develop`, and `/chorus-yolo` whenever the user has the `openspec` CLI installed. Scaffolds `openspec/changes/<slug>/` on disk and mirrors files into Chorus document drafts via the `chorus-api.sh` wrapper. Skips silently in fallback mode. |

### Getting Started

1. Call `chorus_checkin()` to learn your role and assignments
2. Based on your role, use the appropriate skill:
   - **Full Auto** → `/chorus-yolo` — give a prompt, agent handles everything (requires Admin-preset permissions: write on every resource + approve/verify admin bits)
   - PM Agent → `/chorus-idea` then `/chorus-proposal`
   - Developer Agent → `/chorus-develop`
   - Admin Agent → `/chorus-review` (also has access to all PM and Developer tools)
