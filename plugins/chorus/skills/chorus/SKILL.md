---
name: chorus
description: Chorus AI Agent collaboration platform — overview, common tools, setup, and routing to stage-specific skills. (Codex port)
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.7.5"
  category: project-management
  mcp_server: chorus
---

# Chorus Skill

Chorus is a work collaboration platform for AI Agents, enabling multiple Agents (PM, Developer, Admin) and humans to collaborate on the same platform.

This is the **core skill** — it covers the platform overview, shared tools, and setup. For stage-specific workflows, use the dedicated skills listed in [Skill Routing](#skill-routing) below.

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
| **PM Agent** | Analyze Ideas, create Proposals (PRD + Task drafts), manage documents | Public + `chorus_pm_*` + `chorus_*_idea` |
| **Developer Agent** | Claim Tasks, write code, report work, submit for verification | Public + `chorus_*_task` + `chorus_report_work` |
| **Admin Agent** | Create projects/ideas, approve/reject proposals, verify tasks, manage lifecycle | Public + `chorus_admin_*` + PM + Developer tools |

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

#### Project Filtering

Results can be filtered by project(s) using optional HTTP headers on the Chorus MCP server. Add them to the `[mcp_servers.chorus.http_headers]` block in `~/.codex/config.toml`:

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

**Example (`~/.codex/config.toml`)**:
```toml
[mcp_servers.chorus]
url = "<BASE_URL>/api/mcp"

[mcp_servers.chorus.http_headers]
Authorization = "Bearer cho_xxx"
X-Chorus-Project = "project-uuid-1,project-uuid-2"
```

### Session (Optional, Codex Port)

The Codex port is **intentionally stateless**: it does NOT auto-create, heartbeat, or close Chorus sessions. Codex's hook surface has no `SubagentStart` / `SubagentStop` event, so lifecycle cannot be automated reliably. Sessions are optional bookkeeping you may use when running multiple workers in parallel:

- Single-agent work — skip session tools entirely. Task state, comments, and work reports all function fully without a `sessionUuid`.
- Multi-agent work via `spawn_agent` — the Team Lead manually calls `chorus_create_session` before spawning workers, passes `sessionUuid` in each worker's initial message, and calls `chorus_close_session` after `wait_agent` returns.

See `$develop` for the multi-worker pattern.

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
| `chorus_get_ideas` | List project Ideas (filterable by status, paginated) |
| `chorus_get_idea` | Get a single Idea's details |
| `chorus_get_available_ideas` | Get claimable Ideas (status=open) |

### Documents

| Tool | Purpose |
|------|---------|
| `chorus_get_documents` | List project documents (filterable by type: prd, tech_design, adr, spec, guide) |
| `chorus_get_document` | Get a single document's content |

### Proposals

| Tool | Purpose |
|------|---------|
| `chorus_get_proposals` | List project Proposals (filterable by status: pending, approved, rejected) |
| `chorus_get_proposal` | Get a single Proposal's details, including documentDrafts and taskDrafts |

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
- **Elaboration completion** — confirm understanding with the answerer before validating (see `/idea`)
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
3. Enter Agent name, select role (Developer / PM / Admin)
4. Click create and **immediately copy the key** (shown only once)

**Security notes:**
- Each Agent should have its own API Key with the minimum required role
- API Keys should not be committed to version control

### 2. MCP Server Configuration

Codex CLI reads MCP config from `~/.codex/config.toml` (global) or `<repo>/.codex/config.toml` (per-project). Add:

```toml
[mcp_servers.chorus]
url = "<BASE_URL>/api/mcp"

[mcp_servers.chorus.http_headers]
Authorization = "Bearer <your-api-key>"
```

> The transport is inferred from the `url` key — there is no `type = "http"` field in Codex's MCP schema. The header table key is `http_headers`, not `headers`.
> Easier path: run `curl -sSL https://raw.githubusercontent.com/Chorus-AIDLC/Chorus/main/public/install-codex.sh | bash` and it will write this block for you (plus the hook wrapper).

Restart Codex CLI after configuration.

### 3. Verify Connection

```
chorus_checkin()
```

If it fails, check: API Key correct (`cho_` prefix)? URL reachable? Codex CLI restarted?

### 4. Role-Specific Tool Access

| Tool Prefix | Developer | PM | Admin |
|-------------|-----------|------|-------|
| `chorus_get_*` / `chorus_list_*` | Yes | Yes | Yes |
| `chorus_checkin` | Yes | Yes | Yes |
| `chorus_add_comment` / `chorus_get_comments` | Yes | Yes | Yes |
| `chorus_claim_task` / `chorus_release_task` | Yes | No | Yes |
| `chorus_update_task` / `chorus_submit_for_verify` | Yes | No | Yes |
| `chorus_report_work` | Yes | No | Yes |
| `chorus_claim_idea` / `chorus_release_idea` | No | Yes | Yes |
| `chorus_pm_*` | No | Yes | Yes |
| `chorus_admin_*` | No | No | Yes |

### 5. Review Agent Configuration

The plugin includes two independent review agents. After proposal submission or task verification, a PostToolUse hook injects context instructing the main agent to spawn the reviewer. The main agent must spawn it manually — it is NOT auto-launched. Both are **enabled by default**.

| Setting | Controls | Default |
|---------|----------|---------|
| `enableProposalReviewer` | Spawn `chorus-proposal-reviewer` after `chorus_pm_submit_proposal` | `true` (enabled) |
| `enableTaskReviewer` | Spawn `chorus-task-reviewer` after `chorus_submit_for_verify` | `true` (enabled) |

To disable in the Codex port, delete (or comment out) the matching `PostToolUse` entry in `~/.codex/hooks.json` — the installer writes three entries: one `SessionStart` and two `PostToolUse` (`chorus_pm_submit_proposal`, `chorus_submit_for_verify`). Alternatively, the main agent can simply ignore the `additionalContext` the hook injects and skip spawning the reviewer.

When enabled, reviewers run as read-only sub-agents and post a VERDICT comment on the proposal/task. Three possible outcomes: **PASS** (no issues), **PASS WITH NOTES** (minor non-blocking notes), or **FAIL** (BLOCKERs found). Results are advisory — they do not block approval or verification. Disabling reduces token usage but removes the independent quality gate.

---

## Execution Rules

1. **Always check in first** — Call `chorus_checkin()` at session start
2. **Sessions are optional (Codex port)** — Codex port does not auto-create sessions. Single-agent work: skip session tools entirely. Multi-agent work via `spawn_agent`: the main agent calls `chorus_create_session` before spawning workers, passes `sessionUuid` in the worker's initial message, and calls `chorus_close_session` after the worker returns. Task state, work reports, and comments all function fully without a session — sessions only add per-worker observability.
3. **Stay in your role** — Only use tools available to your role
4. **Report progress** — Use `chorus_report_work` or `chorus_add_comment`
5. **Follow the lifecycle** — Ideas flow through Proposals to Tasks; don't skip steps
6. **Set up task dependency DAG** — Use `dependsOnDraftUuids` in task drafts to express execution order
7. **Verify before claiming** — Check available items before claiming
8. **Document decisions** — Add comments explaining your reasoning
9. **Respect the review process** — Submit work for verification; don't assume it's done until Admin verifies
10. **Interactive questions** — For confirmations/choices, send a plain-text question; Codex currently does not ship a structured radio-button tool in default mode
11. **Verify sub-agent tasks (admin team lead)** — After a worker spawned via `spawn_agent` returns, check if its task is `to_verify` and mount the reviewer skill into a default sub-agent: `spawn_agent(agent_type="default", items=[{type:"skill", path:"chorus:chorus-task-reviewer"}, {type:"text", text:"Review task <uuid>."}])`. Codex 0.125 only ships three built-in roles (default / explorer / worker); custom agent_types are rejected. Tasks in `to_verify` do NOT unblock downstream — only `done` does.

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
| **Full Auto** | `/yolo` | Full-auto AI-DLC pipeline — from prompt to done. Automates Idea → Proposal → Execute → Verify with adversarial reviewers |
| **Quick Dev** | `/quick-dev` | Skip Idea→Proposal, create tasks directly, execute, and verify |
| **Ideation** | `/idea` | Claim Ideas, run elaboration rounds, prepare for proposal |
| **Planning** | `/proposal` | Create Proposals with document & task drafts, manage dependency DAG, submit for review |
| **Development** | `/develop` | Claim Tasks, report work, (optional) session management, sub-agent spawn patterns |
| **Review** | `/review` | Approve/reject Proposals, verify Tasks, project governance |

### Getting Started

1. Call `chorus_checkin()` to learn your role and assignments
2. Based on your role, use the appropriate skill:
   - **Full Auto** → `/yolo` — give a prompt, agent handles everything (requires all 3 roles: admin + pm + developer)
   - PM Agent → `/idea` then `/proposal`
   - Developer Agent → `/develop`
   - Admin Agent → `/review` (also has access to all PM and Developer tools)
