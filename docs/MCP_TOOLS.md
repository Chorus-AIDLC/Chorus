# Chorus MCP Tools Documentation

This document covers all tools provided by the Chorus MCP Server, including tool names, descriptions, input parameters, and output formats.

## Overview

Tool visibility is driven by a **fine-grained permission model**: 5 resources (`idea`, `proposal`, `document`, `task`, `project`) × 3 actions (`read`, `write`, `admin`) = **15 permissions**. Each gated tool declares a single **required permission**. Public tools (discover, comment, session) carry no gate and are always available.

Agents may use a **role preset** (`developer_agent`, `pm_agent`, `admin_agent`) that expands to a fixed permission set, and/or **custom permissions** added on top. The effective permission set is the union of preset + custom. See `src/lib/authz/presets.ts` for the authoritative preset mapping, `src/mcp/tools/permission-map.ts` for the tool → permission map, and [ARCHITECTURE.md §6.3](./ARCHITECTURE.md#63-permission-model) for the conceptual overview.

### Role Preset → Permission Set

| Preset | Permission Set |
|--------|----------------|
| `developer_agent` | `*:read` + `task:write` (6 perms) |
| `pm_agent` | `*:read` + `idea:write`, `proposal:write`, `document:write`, `task:write`, `project:write` (10 perms) |
| `admin_agent` | all 15 perms (`*:read` + `*:write` + `*:admin`) |

Read-only tools (`chorus_get_*`, `chorus_list_*`, `chorus_checkin`, `chorus_search*`, comments, elaboration answers, session management, `chorus_create_tasks`, `chorus_update_task`) are **public** and available to any agent regardless of preset/permissions — they are listed under "Public Tools" and "Session Tools" below without a Required Permission row.

> Note: `chorus_create_tasks` and `chorus_update_task` field edits are public because handler-level assignee / authorship guards enforce who can actually mutate state. Operational status transitions (`in_progress`, `to_verify`) still require the caller to be the task's assignee at the service layer — the permission gate is about tool visibility, not operation authorization.

### Gated Tool → Required Permission Matrix

The following table summarizes every permission-gated MCP tool. Each tool has exactly one required permission; possessing that permission (via preset or custom) is the **necessary** condition for the tool to appear in the agent's tool list. Additional handler-level guards (ownership, assignee, status) may still apply.

| Tool | Required Permission |
|------|---------------------|
| `chorus_claim_idea` | `idea:write` |
| `chorus_release_idea` | `idea:write` |
| `chorus_move_idea` | `idea:write` |
| `chorus_pm_create_idea` | `idea:write` |
| `chorus_pm_start_elaboration` | `idea:write` |
| `chorus_pm_validate_elaboration` | `idea:admin` |
| `chorus_pm_skip_elaboration` | `idea:write` |
| `chorus_pm_create_proposal` | `proposal:write` |
| `chorus_pm_validate_proposal` | `proposal:write` |
| `chorus_pm_submit_proposal` | `proposal:write` |
| `chorus_pm_add_document_draft` | `proposal:write` |
| `chorus_pm_add_task_draft` | `proposal:write` |
| `chorus_pm_update_document_draft` | `proposal:write` |
| `chorus_pm_update_task_draft` | `proposal:write` |
| `chorus_pm_remove_document_draft` | `proposal:write` |
| `chorus_pm_remove_task_draft` | `proposal:write` |
| `chorus_pm_reject_proposal` | `proposal:write` |
| `chorus_pm_revoke_proposal` | `proposal:write` |
| `chorus_pm_assign_task` | `proposal:write` |
| `chorus_pm_create_document` | `document:write` |
| `chorus_pm_update_document` | `document:write` |
| `chorus_create_report` | `document:write` |
| `chorus_claim_task` | `task:write` |
| `chorus_release_task` | `task:write` |
| `chorus_submit_for_verify` | `task:write` |
| `chorus_report_criteria_self_check` | `task:write` |
| `chorus_report_work` | `task:write` |
| `chorus_admin_create_project` | `project:write` |
| `chorus_admin_create_project_group` | `project:write` |
| `chorus_admin_update_project_group` | `project:write` |
| `chorus_admin_delete_project_group` | `project:write` |
| `chorus_admin_move_project_to_group` | `project:write` |
| `chorus_admin_approve_proposal` | `proposal:admin` |
| `chorus_admin_close_proposal` | `proposal:admin` |
| `chorus_admin_verify_task` | `task:admin` |
| `chorus_admin_reopen_task` | `task:admin` |
| `chorus_admin_close_task` | `task:admin` |
| `chorus_mark_acceptance_criteria` | `task:admin` |
| `chorus_admin_delete_task` | `task:admin` |
| `chorus_admin_delete_idea` | `idea:admin` |
| `chorus_admin_delete_document` | `document:admin` |

### Legacy Role → Tool Set View

For agents that rely on the preset alone (no custom permissions), this is the resulting tool set:

| Role | Tool Set |
|------|----------|
| Developer Agent | Public + Session + Developer (`task:write` tools) |
| PM Agent | Public + Session + PM (`idea:write` + `proposal:write` + `document:write` + `task:write` + `project:write` tools — includes Developer's `task:write` tools and `project:write` project-management tools) |
| Admin Agent | Public + Session + PM + Developer + Admin (all 15 permissions) |

## Project Filtering

Agents can filter results by project(s) using HTTP headers during MCP connection. This is useful when an agent works on multiple projects and wants to focus on a specific subset.

### Available Headers

| Header | Format | Example | Description |
|--------|--------|---------|-------------|
| `X-Chorus-Project` | Single UUID or comma-separated UUIDs | `uuid1` or `uuid1,uuid2,uuid3` | Filter by specific project(s) |
| `X-Chorus-Project-Group` | Group UUID | `group-uuid-here` | Filter by project group (includes all projects in the group) |

### Behavior

- **No header**: Returns results from all projects (default, backward compatible)
- **X-Chorus-Project**: Returns results only from specified project(s)
- **X-Chorus-Project-Group**: Returns results from all projects in the specified group
- **Priority**: `X-Chorus-Project-Group` takes precedence over `X-Chorus-Project` if both are provided

### Affected Tools

The following tools respect project filtering:
- `chorus_checkin` - Returns filtered assignments
- `chorus_get_my_assignments` - Returns filtered idea/task tracker (grouped by project)

### Usage Example

```json
// .mcp.json configuration for single project
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:8637/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxx",
        "X-Chorus-Project": "project-uuid-here"
      }
    }
  }
}

// .mcp.json configuration for multiple projects
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:8637/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxx",
        "X-Chorus-Project": "uuid1,uuid2,uuid3"
      }
    }
  }
}

// .mcp.json configuration for project group
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:8637/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxx",
        "X-Chorus-Project-Group": "group-uuid-here"
      }
    }
  }
}
```

---

## Transport (Stateless MCP)

The MCP endpoint at `POST /api/mcp` is **stateless**: each request authenticates via the `Authorization: Bearer cho_…` header and a fresh per-request server instance is built. There is no server-side session, no `Mcp-Session-Id` exchange, and no inactivity timeout — clients hit the endpoint with their API Key on every request and the server tears the instance down once the response is flushed.

What this means for clients:

- **No session lifecycle to manage**: no `initialize` → keep-alive → expire flow; no HTTP 404 "session not found" recovery path.
- **Permission set is recomputed per request**: rotating an Agent's permissions in the UI takes effect on the next MCP call without any reconnect.
- **Horizontal scaling is free**: any container can serve any request, since nothing is pinned to an instance. (Cross-instance event propagation for SSE goes through Redis when `REDIS_URL` is set — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the realtime side.)

The Agent-level **AgentSession** model (used for swarm-mode observability via `chorus_create_session` / `chorus_session_*`) is an entirely separate concept from MCP transport sessions and is documented under [Session Tools](#session-tools-all-agents) below.

---

## Public Tools

Tools available to all Agents.

### chorus_checkin

**Description**: Agent check-in. Returns agent identity (including owner info), the resource-aggregated effective permission set, an idea tracker grouped by project, and a notification summary. Recommended at session start. Side effects: updates `agent.lastActiveAt`, emits the first-checkin notification to the owner once, and marks the 5 returned recent notifications as read.

**Project Filtering**: Results can be filtered by project using HTTP headers during MCP connection:
- `X-Chorus-Project`: Single or multiple project UUIDs (comma-separated)
- `X-Chorus-Project-Group`: Project group UUID (includes all projects in the group)
- No header: Returns all projects (default behavior)

**Input**: None

**Output**:
```json
{
  "checkinTime": "ISO timestamp",
  "agent": {
    "uuid": "Agent UUID",
    "name": "Agent name",
    "permissions": {
      "idea": ["read", "write"],
      "proposal": ["read", "write"],
      "document": ["read", "write"],
      "task": ["read", "write"],
      "project": ["read"]
    },
    "persona": "Persona description",
    "systemPrompt": "System prompt (optional)",
    "owner": { "uuid": "User UUID", "name": "Owner Name", "email": "owner@example.com" }
  },
  "ideaTracker": {
    "<project-uuid>": {
      "name": "Project name",
      "ideas": [
        { "uuid": "...", "title": "...", "status": "in_progress", "proposals": 1, "tasks": 3 }
      ]
    }
  },
  "notifications": {
    "unread": 0,
    "recent": []
  }
}
```

> The legacy 0.6.x shape (`roles: ["developer"]`, `assignments`, `pending`) was replaced in 0.6.6 by the project-grouped `ideaTracker` and in 0.7.0 by the resource-aggregated `permissions` object. The old fields are no longer returned.

### chorus_list_projects

**Description**: List all projects for the current company (paginated). Returns projects with counts of ideas, documents, tasks, and proposals.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| page | number | No | Page number (default 1) |
| pageSize | number | No | Items per page (default 20) |

**Output**: `{ projects: [...], total: number }`

### chorus_get_project

**Description**: Get project details and background information

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |

**Output**: Project details JSON

### chorus_get_ideas

**Description**: Get the list of Ideas for a project. Each row includes `reportCount` — number of completion reports for the idea.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| status | string | No | Filter by status: open, elaborating, proposal_created, completed, closed |
| page | number | No | Page number (default 1) |
| pageSize | number | No | Items per page (default 20) |

**Output**:
```json
{
  "ideas": [{ ..., "reportCount": 0 }],
  "total": 10,
  "page": 1,
  "pageSize": 20
}
```

### chorus_get_idea

**Description**: Get detailed information for a single Idea. Includes `reports[]` — full content of the idea's completion reports, newest first.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Idea details JSON, with `reports: DocumentResponse[]` (full Markdown content, sorted by `createdAt` desc; empty when none).

### chorus_get_documents

**Description**: Get the list of documents for a project

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| type | string | No | Filter by type: prd, tech_design, adr, spec, guide, report |
| page | number | No | Page number |
| pageSize | number | No | Items per page |

**Output**: Document list JSON

### chorus_get_document

**Description**: Get detailed content of a single document

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| documentUuid | string | Yes | Document UUID |

**Output**: Document details JSON

### chorus_get_proposals

**Description**: Get the list of proposals and their statuses for a project

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| status | string | No | Filter by status: draft, pending, approved, rejected, revised |
| page | number | No | Page number |
| pageSize | number | No | Items per page |

**Output**: Proposal list JSON

### chorus_get_proposal

**Description**: Get a single proposal as a section-scoped view, to avoid returning oversized payloads. The `section` parameter selects which slice is returned; every response carries a `section` field echoing the view.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| section | string | No | One of `basic` \| `documents` \| `tasks` \| `full`. Default `basic`. |

**Sections**:
- `basic` (default): proposal metadata + a lightweight index of the drafts — `documentDraftIndex` (`uuid`, `type`, `title`, `contentLength`), `taskDraftIndex` (`uuid`, `title`, `priority`, `storyPoints`, `acceptanceCriteriaCount`, `dependsOnDraftUuids`), and `documentDraftCount` / `taskDraftCount`. No document content or full task descriptions.
- `documents`: proposal metadata + the full `documentDrafts` (with `content`).
- `tasks`: proposal metadata + the full `taskDrafts` (with descriptions and acceptance criteria).
- `full`: the entire proposal — both `documentDrafts` and `taskDrafts` in one payload (the pre-`section` behavior).

**Usage**: Start with `basic` to see what exists cheaply, then drill into `documents` or `tasks` using the same `proposalUuid`.

**Output**: Proposal JSON sliced to the requested `section` (with a `section` discriminator field).

### chorus_list_tasks

**Description**: List tasks for a project

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| status | string | No | Filter by status: open, assigned, in_progress, to_verify, done, closed |
| priority | string | No | Filter by priority: low, medium, high |
| proposalUuids | string[] | No | Filter tasks by proposal UUIDs |
| page | number | No | Page number |
| pageSize | number | No | Items per page |

**Output**: Task list JSON

### chorus_get_task

**Description**: Get detailed information and context for a single task

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Task details JSON including:
- `acceptanceCriteriaItems`: Array of structured acceptance criteria (each with `uuid`, `description`, `required`, `devStatus`, `devEvidence`, `status`, `evidence`, etc.)
- `acceptanceStatus`: Computed status — `"not_started"` | `"in_progress"` | `"passed"` | `"failed"`
- `acceptanceSummary`: `{ total, required, passed, failed, pending, requiredPassed, requiredFailed, requiredPending }`

### chorus_get_activity

**Description**: Get the activity stream for a project

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| page | number | No | Page number |
| pageSize | number | No | Items per page (default 50) |

**Output**: Activity list JSON

### chorus_get_my_assignments

**Description**: Get the agent's idea/task tracker, grouped by project. Output is structurally identical to `chorus_checkin.ideaTracker` (see `chorus_checkin`) — the only difference is that `chorus_get_my_assignments` returns the full set of in-progress ideas (no `maxIdeas` cap), plus a `taskTracker` for tasks.

**Project Filtering**: Results can be filtered by project using HTTP headers during MCP connection:
- `X-Chorus-Project`: Single or multiple project UUIDs (comma-separated)
- `X-Chorus-Project-Group`: Project group UUID (includes all projects in the group)
- No header: Returns all projects (default behavior)

**Filtering**: Excludes ideas with `status=closed` and ideas whose derived status is `done` (rolled-up completion based on linked proposals + tasks). Excludes tasks with `status` in `[done, closed]`.

**Input**: None

**Output**:
```json
{
  "ideaTracker": {
    "<projectUuid>": {
      "name": "Project Name",
      "ideas": [
        {
          "uuid": "...",
          "title": "...",
          "status": "in_progress",
          "proposals": 1,
          "tasks": 3
        }
      ]
    }
  },
  "taskTracker": {
    "<projectUuid>": {
      "name": "Project Name",
      "tasks": [
        {
          "uuid": "...",
          "title": "...",
          "status": "in_progress",
          "priority": "high",
          "assignedAt": "2026-05-08T01:25:58.833Z",
          "ac": { "passed": 2, "total": 5 }
        }
      ]
    }
  }
}
```

Each idea entry's `status` is the derived status (`todo` / `in_progress` / `human_conduct_required`); each task entry's `ac` reports admin-verified acceptance-criteria progress.

> **BREAKING (0.7.2)**: prior to 0.7.2 this tool returned a flat `{ ideas: [], tasks: [] }`. The new shape aligns 1:1 with `chorus_checkin.ideaTracker`.

### chorus_get_available_ideas

**Description**: Get claimable Ideas in a project (status=open)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |

**Output**: List of claimable Ideas

### chorus_get_available_tasks

**Description**: Get claimable Tasks in a project (status=open)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| proposalUuids | string[] | No | Filter tasks by proposal UUIDs |

**Output**: List of claimable Tasks

### chorus_get_unblocked_tasks

**Description**: Get unblocked tasks — tasks with status open/assigned where all dependencies are resolved (done/closed). Used to discover which tasks are ready to start. Note: `to_verify` is NOT considered resolved — only `done` and `closed` unblock dependents.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| proposalUuids | string[] | No | Filter tasks by proposal UUIDs |

**Output**:
```json
{
  "tasks": [...],
  "total": 3
}
```

Each task in the response includes the full TaskResponse format (with dependsOn, dependedBy, assignee, etc.).

---

### chorus_answer_elaboration

**Description**: Answer elaboration questions for an Idea. Submits answers for an elaboration round. When all required questions are answered, the round moves to `answered`. `roundUuid` is optional — when omitted, the service auto-locates the Idea's single active (`pending_answers`) round.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| roundUuid | string | No | Elaboration round UUID. **Optional** — when omitted, the active `pending_answers` round is auto-located. Pass explicitly to target a specific round. Fails if omitted and there is no active round, or more than one. |
| answers | array | Yes | Answers to submit |

**answers array item fields**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| questionId | string | Yes | Question ID to answer |
| selectedOptionId | string\|null | Yes | Selected option ID (null if using custom text only) |
| customText | string\|null | Yes | Custom text answer (null if using selected option only) |

**Output**: Updated Elaboration Round JSON (includes questions with their answers)

### chorus_get_elaboration

**Description**: Get the full elaboration state for an Idea, including all rounds, questions, answers, and a summary of progress.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**:
```json
{
  "ideaUuid": "...",
  "depth": "standard",
  "status": "resolved",
  "rounds": [
    {
      "uuid": "...",
      "roundNumber": 1,
      "status": "validated",
      "isAppended": false,
      "questions": [...],
      "createdAt": "ISO timestamp"
    }
  ],
  "summary": {
    "totalQuestions": 5,
    "answeredQuestions": 5,
    "validatedRounds": 1,
    "pendingRound": null
  }
}
```

---

### chorus_search_mentionables

**Description**: Search for users and agents that can be @mentioned. Returns name, type, and UUID. Use the UUID to write mentions as `@[Name](type:uuid)` in comment/description text.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | Yes | Name or keyword to search |
| limit | number | No | Max results to return (default: 10) |

**Output**:
```json
[
  { "type": "user", "uuid": "...", "name": "Yifei", "email": "yifei@...", "avatarUrl": "..." },
  { "type": "agent", "uuid": "...", "name": "Claude Dev", "roles": ["developer"] }
]
```

**Permission scoping**:
- User caller: all company users + own agents
- Agent caller: all company users + same-owner agents

---

### chorus_search

**Description**: Search across tasks, ideas, proposals, documents, projects, and project groups. Supports scoping to project groups or specific projects.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | Yes | Search query (matches title, description, content) |
| scope | enum | No | Search scope: global, group, project (default: global) |
| scopeUuid | string | No | Project group UUID (scope=group) or project UUID (scope=project) |
| entityTypes | string[] | No | Entity types to search: task, idea, proposal, document, project, project_group (default: all) |

**Output**:
```json
{
  "results": [
    {
      "entityType": "task",
      "uuid": "...",
      "title": "Task title",
      "snippet": "...excerpt around match...",
      "status": "open",
      "projectUuid": "...",
      "projectName": "Project A",
      "updatedAt": "ISO timestamp"
    }
  ],
  "counts": {
    "tasks": 5,
    "ideas": 3,
    "proposals": 2,
    "documents": 4,
    "projects": 1,
    "projectGroups": 1
  }
}
```

**Usage examples**:
- Global search: `{ query: "authentication" }`
- Search in a project group: `{ query: "authentication", scope: "group", scopeUuid: "group-uuid" }`
- Search in a specific project: `{ query: "authentication", scope: "project", scopeUuid: "project-uuid" }`
- Search only tasks and ideas: `{ query: "authentication", entityTypes: ["task", "idea"] }`

---

### chorus_get_project_groups

**Description**: List all project groups for the current company. Returns groups with project counts.

**Input**: None

**Output**:
```json
{
  "groups": [
    {
      "uuid": "Group UUID",
      "name": "Group name",
      "description": "...",
      "projectCount": 3,
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    }
  ],
  "total": 1
}
```

### chorus_get_project_group

**Description**: Get a single project group by UUID with its projects list.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| groupUuid | string | Yes | Project Group UUID |

**Output**:
```json
{
  "uuid": "Group UUID",
  "name": "Group name",
  "description": "...",
  "projectCount": 2,
  "projects": [
    { "uuid": "...", "name": "Project A", "description": "..." }
  ],
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

### chorus_get_group_dashboard

**Description**: Get aggregated dashboard stats for a project group (project count, tasks, completion rate, ideas, proposals, activity stream).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| groupUuid | string | Yes | Project Group UUID |

**Output**:
```json
{
  "group": { "uuid": "...", "name": "...", "description": "..." },
  "stats": {
    "projectCount": 3,
    "totalTasks": 15,
    "completedTasks": 8,
    "completionRate": 53,
    "openIdeas": 4,
    "activeProposals": 2
  },
  "projects": [
    { "uuid": "...", "name": "...", "taskCount": 5, "completionRate": 60 }
  ],
  "recentActivity": [...]
}
```

---

### chorus_add_comment

**Description**: Add a comment to an Idea/Proposal/Task/Document

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| targetType | enum | Yes | Target type: idea, proposal, task, document |
| targetUuid | string | Yes | Target UUID |
| content | string | Yes | Comment content |

**Output**: Created comment JSON

### chorus_get_comments

**Description**: Get the list of comments for an Idea/Proposal/Task/Document

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| targetType | enum | Yes | Target type: idea, proposal, task, document |
| targetUuid | string | Yes | Target UUID |
| page | number | No | Page number |
| pageSize | number | No | Items per page |

**Output**: Comment list JSON

### chorus_create_tasks

**Description**: Batch create tasks in a project. Public tool — available to any agent (no permission gate). Supports two modes:

- **Quick Task** (skip Idea → Proposal): omit `proposalUuid`. Ideal for bug fixes, small features, or post-delivery patches. Lifecycle: create → claim → execute → verify → done.
- **Proposal-linked** (traditional AI-DLC): pass `proposalUuid` to associate the new tasks with an approved proposal.

Supports intra-batch dependencies via `draftUuid` + `dependsOnDraftUuids`, and dependencies on existing tasks via `dependsOnTaskUuids`.

> **Acceptance criteria are required.** Every task must include `acceptanceCriteriaItems` with at least one item whose `description` is non-blank. If any task in the batch fails this check, the entire call is rejected and **no** task is created (all-or-nothing).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| proposalUuid | string | No | Associated Proposal UUID (omit for Quick Task mode) |
| tasks | array | Yes | Task list |

**tasks array item fields**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Task title |
| description | string | No | Task description |
| priority | enum | No | Priority: low, medium, high |
| storyPoints | number | No | Effort estimate (Agent hours) |
| acceptanceCriteriaItems | array | **Yes** | Structured acceptance criteria: `[{ description: string, required?: boolean }]`. At least one item with a non-blank `description` is required; an empty or all-blank array is rejected. |
| draftUuid | string | No | Temporary UUID for intra-batch `dependsOnDraftUuids` references |
| dependsOnDraftUuids | string[] | No | Intra-batch draftUuids this task depends on |
| dependsOnTaskUuids | string[] | No | Existing Task UUIDs this task depends on |

**Quick Task example**:
```json
{
  "projectUuid": "8c16d9aa-...",
  "tasks": [
    {
      "title": "Fix login button alignment",
      "description": "On the /login page the submit button is misaligned on mobile breakpoints.",
      "priority": "medium",
      "storyPoints": 0.5,
      "acceptanceCriteriaItems": [
        { "description": "Submit button is centered at the 375px mobile breakpoint", "required": true }
      ]
    }
  ]
}
```

**Proposal-linked example with intra-batch dependencies**:
```json
{
  "projectUuid": "8c16d9aa-...",
  "proposalUuid": "e35b558c-...",
  "tasks": [
    {
      "draftUuid": "draft-1",
      "title": "Add database migration",
      "priority": "high",
      "storyPoints": 1,
      "acceptanceCriteriaItems": [
        { "description": "Migration creates the new column and runs cleanly on a fresh DB", "required": true }
      ]
    },
    {
      "draftUuid": "draft-2",
      "title": "Wire up service layer",
      "dependsOnDraftUuids": ["draft-1"],
      "storyPoints": 2,
      "acceptanceCriteriaItems": [
        { "description": "Service reads/writes the new column with unit-test coverage", "required": true }
      ]
    },
    {
      "title": "Add API route",
      "dependsOnDraftUuids": ["draft-2"],
      "dependsOnTaskUuids": ["existing-task-uuid"],
      "storyPoints": 1,
      "acceptanceCriteriaItems": [
        { "description": "Route returns the new field and is covered by a route test", "required": true }
      ]
    }
  ]
}
```

**Output**:
```json
{
  "tasks": [
    { "uuid": "real-uuid-1", "title": "Add database migration" },
    { "uuid": "real-uuid-2", "title": "Wire up service layer" }
  ],
  "warnings": ["..."]
}
```
- `tasks`: One `{ uuid, title }` entry per created task, in input order.
- `warnings`: Only returned when there are issues creating dependencies (the tasks themselves are created successfully). Acceptance-criteria presence is validated up front — a missing/empty AC set rejects the whole call with `isError` rather than producing a warning.

> Note: After `chorus_admin_approve_proposal` runs, taskDrafts are auto-materialized into Tasks. Calling `chorus_create_tasks` with the same `proposalUuid` would produce duplicates — only call this for proposal-linked tasks added outside the standard draft-and-approve flow.

### chorus_create_report

**Description**: Persist an idea-completion summary as a Document with `type="report"` linked to the given Proposal. Call once, at end-of-Idea, after the last task verifies. This is a summary, not a detailed write-up — keep it short.

The Markdown `content` MUST use these three sections in this order (the server stores bytes verbatim — these headers are a constraint, not a schema):

```markdown
## Summary
1-3 sentences on what shipped. Plain prose. No bullet lists here.

## Decisions
Terse bullets — the key calls made during elaboration / proposal review and why this option not the alternative.

## Follow-ups
What's still open — link to a new Idea / blog / doc-update if tracked elsewhere; write "None" if there are no follow-ups.
```

**Required Permission**: `document:write` (the tool lives in the public-namespaced module — no `pm_` prefix — but is permission-gated; granted via the `pm_agent` / `admin_agent` presets, or via a custom permission added to a developer agent).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string (UUID) | Yes | Proposal UUID whose tasks have all reached a terminal state (`done`/`closed`) |
| title | string (1-200 chars) | Yes | Report title (e.g. `"Idea X — completion report"`) |
| content | string (non-empty Markdown) | Yes | Markdown body — Summary / Decisions / Follow-ups |
| force | boolean | No (default `false`) | When `false`, calls against a proposal that already has a report return an error and create nothing. Set `true` only to deliberately add another report to the same proposal. |

**Output**:
```json
{
  "documentUuid": "...",
  "projectUuid": "...",
  "version": 1
}
```

The created Document has `type="report"` (the tool name encodes the type — agents cannot mislabel reports), `proposalUuid` set to the provided value, and `projectUuid` resolved from the Proposal. The body is preserved byte-faithfully (modulo the Document content path's existing trailing-newline normalization). To revise a report, use `chorus_pm_update_document` (which increments `version`).

By default the tool refuses to create a second report on a proposal that already has one — the call returns an MCP error result (`isError: true`) with a message indicating that a report already exists and that `force=true` is the way to bypass. This guard fires even when the call comes from the `/yolo` Phase 5b end-step or the PostToolUse hook reminder, so duplicate completion reports per Idea become impossible regardless of caller. To intentionally author an additional report (e.g. after a major rework, separate-audience cut), pass `force: true`.

**When to author**: at the end of an Idea pipeline — once every Task linked to the Idea (across all approved Proposals) has been admin-verified to `done`. The `/yolo` skill authors a report as a mandatory end-step; the `/develop` skill prompts for one as an advisory end-step; and the Chorus plugin's PostToolUse hook injects a reminder substring after the last `chorus_admin_verify_task` of an Idea when no `report` Document yet exists.

---

## Session Tools

Available to all Agents. Used to manage Agent work sessions (e.g., sub-agent workers in swarm mode).

### Lifecycle and staleness

The persisted state space is exactly `{active, closed}`. There is no `inactive` status — staleness is a derived predicate on `lastActiveAt`, not a stored value. Default UI listings (Settings page per-agent sessions, project worker-avatar header) only show sessions matching `status='active' AND lastActiveAt > now - 1h`. MCP-facing reads (`chorus_list_sessions`, `chorus_get_session`) and the audit-trail dereferences (Activity stream) are NOT filtered — plugins and history navigation see every session regardless of age or status.

### Implicit-heartbeat contract

Every Session tool that takes a `sessionUuid` parameter and successfully resolves the session refreshes `lastActiveAt = now()` as a side effect of success — except when the session's `status='closed'`, in which case the refresh is skipped to preserve the historical timestamp. Tools covered: `chorus_get_session`, `chorus_close_session`, `chorus_reopen_session`, `chorus_session_checkin_task`, `chorus_session_checkout_task`, `chorus_session_heartbeat`. As a result, plugins do not need to send standalone heartbeats during normal operation — any other session tool call already counts as one. The `chorus_session_heartbeat` tool remains as an explicit keep-alive for idle sub-agents.

### chorus_create_session

**Description**: Create a new Agent Session (e.g., representing a sub-agent worker)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Session name (e.g., "frontend-worker") |
| description | string | No | Session description |

**Output**:
```json
{
  "uuid": "Session UUID",
  "agentUuid": "Agent UUID",
  "name": "frontend-worker",
  "description": "...",
  "status": "active",
  "lastActiveAt": "ISO timestamp",
  "createdAt": "ISO timestamp",
  "activeCheckins": []
}
```

### chorus_list_sessions

**Description**: List all Sessions for the current Agent. **Unfiltered** — returns sessions regardless of staleness or closed status (use this for plugin reuse logic and audit-trail navigation).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| status | string | No | Filter by status: `active` or `closed` |

**Output**:
```json
{
  "sessions": [...],
  "total": 3
}
```

### chorus_get_session

**Description**: Get Session details and its active Task checkins. Refreshes the session's `lastActiveAt` as a side effect of success unless the session is `closed`.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Session details JSON (includes activeCheckins list)

### chorus_close_session

**Description**: Close a Session (any status → closed). Automatically checks out all active Task checkins. Does not alter the underlying Tasks' `status`.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Updated Session JSON

### chorus_reopen_session

**Description**: Reopen a closed Session (closed → active). Used to reuse a previous session without creating a new one. `lastActiveAt` is refreshed as part of the reopen.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Updated Session JSON (status=active, lastActiveAt refreshed)

### chorus_session_checkin_task

**Description**: Check in a Session to a Task, indicating work has started. Refreshes `lastActiveAt`.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |
| taskUuid | string | Yes | Task UUID |

**Output**: Checkin record JSON

### chorus_session_checkout_task

**Description**: Check out a Session from a Task, indicating work has ended. Refreshes `lastActiveAt`.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |
| taskUuid | string | Yes | Task UUID |

**Output**: Updated checkin record JSON

### chorus_session_heartbeat

**Description**: Explicit Session heartbeat — refreshes `lastActiveAt`. Most callers don't need this since every other session tool also refreshes; it exists for idle sub-agents that want to stay visible in the Settings UI without otherwise touching the session.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Confirmation message (includes updated lastActiveAt)

---

## PM Agent Tools

Available to PM Agent and Admin Agent. Not available to Developer Agent.

### chorus_claim_idea

**Description**: Claim an Idea (open → elaborating). Claiming automatically transitions the Idea to 'elaborating' status. After claiming, start elaboration with chorus_pm_start_elaboration or skip with chorus_pm_skip_elaboration.

**Required Permission**: `idea:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Updated Idea JSON

### chorus_release_idea

**Description**: Release a claimed Idea (elaborating → open)

**Required Permission**: `idea:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Updated Idea JSON

### chorus_pm_create_proposal

**Description**: Create a proposal container (can include document drafts and task drafts)

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| title | string | Yes | Proposal title |
| description | string | No | Proposal description |
| inputType | enum | Yes | Input source type: idea, document |
| inputUuids | string[] | Yes | List of input UUIDs |
| documentDrafts | array | No | List of document drafts |
| taskDrafts | array | No | List of task drafts |

**Output**: Created Proposal JSON

### chorus_pm_validate_proposal

**Description**: Validate a Proposal's completeness before submission. Returns errors (block submission), warnings (advisory), and info (hints). Call this before `chorus_pm_submit_proposal` to preview validation issues.

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID to validate |

**Output**:
```json
{
  "valid": true,
  "issues": [
    {
      "id": "E1",
      "level": "error",
      "message": "Proposal must contain at least one PRD document draft",
      "field": null
    },
    {
      "id": "W2",
      "level": "warning",
      "message": "Task draft \"Implement API\" is missing a description",
      "field": "Implement API"
    }
  ]
}
```

**Validation checks**:
| ID | Level | Check |
|----|-------|-------|
| E1 | error | At least one PRD document draft required |
| E2 | error | Every document draft must have content >= 100 characters |
| E3 | error | At least one task draft required |
| E4 | error | inputUuids must be non-empty |
| E5 | error | All input Ideas must have elaborationStatus = 'resolved' |
| W1 | warning | At least one tech_design document draft recommended |
| W2 | warning | Every task draft should have a description |
| W3 | warning | Every task draft should have acceptance criteria |
| W4 | warning | When >= 2 tasks, at least one should declare dependencies |
| W5 | warning | Proposal description should be non-empty |
| I1 | info | Every task draft should have priority set |
| I2 | info | Every task draft should have storyPoints set |

**Usage**: Call before `chorus_pm_submit_proposal` to preview issues. Errors will block submission; warnings and info are advisory. `submitProposal` also runs this validation internally and rejects if errors are found.

### chorus_pm_submit_proposal

**Description**: Submit a Proposal for approval (draft → pending). Runs `chorus_pm_validate_proposal` internally and rejects with a formatted error if any error-level issues are found. Call `chorus_pm_validate_proposal` first to preview issues before submitting.

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |

**Output**: Updated Proposal JSON (status changes to pending)

### chorus_pm_create_document

**Description**: Create a document (PRD, technical design, ADR, etc.)

**Required Permission**: `document:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| type | enum | Yes | Document type: prd, tech_design, adr, spec, guide, report |
| title | string | Yes | Document title |
| content | string | No | Document content (Markdown) |
| proposalUuid | string | No | Associated Proposal UUID |

**Output**: Created Document JSON

### chorus_pm_update_document

**Description**: Update document content (increments version number)

**Required Permission**: `document:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| documentUuid | string | Yes | Document UUID |
| title | string | No | New title |
| content | string | No | New content (Markdown) |

**Output**: Updated Document JSON

### chorus_pm_add_document_draft

**Description**: Add a document draft to a pending Proposal container

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| type | string | Yes | Document type |
| title | string | Yes | Document title |
| content | string | Yes | Document content (Markdown) |

**Output**: Updated Proposal JSON

### chorus_pm_add_task_draft

**Description**: Add a task draft to a pending Proposal container

**Required Permission**: `proposal:write`

> **Acceptance criteria are required.** `acceptanceCriteriaItems` must contain at least one item with a non-blank `description`, or the call is rejected and no draft is added.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| title | string | Yes | Task title |
| description | string | No | Task description |
| storyPoints | number | No | Effort estimate (Agent hours) |
| priority | enum | No | Priority: low, medium, high |
| acceptanceCriteriaItems | array | **Yes** | Structured acceptance criteria: `[{ description: string, required?: boolean }]`. At least one item with a non-blank `description` is required (materialized on approval). |
| dependsOnDraftUuids | string[] | No | List of dependent taskDraft UUIDs (automatically converted to real dependencies upon approval) |

**Output**: Updated Proposal JSON

### chorus_pm_update_document_draft

**Description**: Update a document draft in a Proposal

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Document draft UUID |
| type | string | No | Document type |
| title | string | No | Document title |
| content | string | No | Document content |

**Output**: Updated Proposal JSON

### chorus_pm_update_task_draft

**Description**: Update a task draft in a Proposal

**Required Permission**: `proposal:write`

> **Partial-update semantics for acceptance criteria.** Omit `acceptanceCriteriaItems` to leave the draft's existing criteria unchanged. If you provide it, it **replaces** the existing criteria and must contain at least one item with a non-blank `description` — an empty or all-blank array is rejected (the field cannot be used to clear acceptance criteria).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Task draft UUID |
| title | string | No | Task title |
| description | string | No | Task description |
| storyPoints | number | No | Effort estimate |
| priority | enum | No | Priority |
| acceptanceCriteriaItems | array | No | Structured acceptance criteria: `[{ description: string, required?: boolean }]`. If provided, replaces existing items and must be non-empty; if omitted, existing criteria are preserved. |
| dependsOnDraftUuids | string[] | No | List of dependent taskDraft UUIDs |

**Output**: Updated Proposal JSON

### chorus_pm_remove_document_draft

**Description**: Remove a document draft from a Proposal

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Document draft UUID |

**Output**: Updated Proposal JSON

### chorus_pm_remove_task_draft

**Description**: Remove a task draft from a Proposal

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Task draft UUID |

**Output**: Updated Proposal JSON

### chorus_pm_assign_task

**Description**: Assign a task to a specified Developer Agent (task must be in open or assigned status)

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| agentUuid | string | Yes | Target Developer Agent UUID |

**Output**: Updated Task JSON

**Validation rules**:
- Task must be in open or assigned status
- Target Agent must exist and belong to the same company
- Target Agent must carry the `developer` / `developer_agent` role label (the handler still uses the role string here as an explicit "is this an executor agent?" check, distinct from the broader permission gating)

### chorus_pm_start_elaboration

**Description**: Generate an elaboration round for an Idea — the single entry point for the first round, follow-up rounds, and rounds appended after resolution. Creates structured questions for the Idea creator/stakeholder to answer, clarifying requirements before proposal creation. Callable when the Idea is `elaborating` (normal/follow-up round) **and** when it is `elaborated`/`resolved`: in the resolved case it creates an **appended round** (`isAppended: true`) that keeps the Idea `elaborated` and `elaborationStatus = resolved`, so it never blocks an in-flight Proposal. The round cap is 10. Recommended for every Idea. Structured elaboration improves Proposal quality and reduces rejection cycles.

**Required Permission**: `idea:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| depth | enum | Yes | Elaboration depth: minimal, standard, comprehensive |
| questions | array | Yes | Questions to ask (1-15 per round) |

**questions array item fields**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Unique question identifier |
| text | string | Yes | Question text |
| category | enum | Yes | Category: functional, non_functional, business_context, technical_context, user_scenario, scope |
| options | array | Yes | Answer options (2-5 required) |
| required | boolean | No | Whether the question is required (default: true) |

**options array item fields**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Option identifier |
| label | string | Yes | Option label |
| description | string | No | Option description |

**Output**: Created Elaboration Round JSON

### chorus_pm_validate_elaboration

**Description**: Mark an Idea's elaboration complete. Validates the most recent `answered` round, moves the Idea to `elaborated`, and sets `elaborationStatus = resolved` (the gating signal that lets a downstream Proposal be submitted). **Requires human confirmation before calling (except in YOLO mode).** To open a follow-up round instead, call `chorus_pm_start_elaboration` again.

**Required Permission**: `idea:admin`

> **Permission handoff:** the `pm_agent` preset grants only `idea:write`, so a PM-preset agent cannot resolve — resolving requires an `admin_agent`-preset agent (or an admin-preset key). **Assignee precondition:** the resolving actor must also be the Idea's assignee, so a separate human reviewer resolving a PM-owned Idea needs both `idea:admin` and the Idea assignment (claim/reassign first).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| roundUuid | string | No | Round to validate. **Optional** — defaults to the most recent `answered` round. |

**Output**: Resolution result JSON. The targeted round becomes `validated`, the Idea status becomes `elaborated`, and `elaborationStatus` becomes `resolved`. Fails if there is no `answered` round to resolve.

### chorus_pm_skip_elaboration

**Description**: Skip elaboration for an Idea (marks as resolved with minimal depth). Use only for trivially clear Ideas (e.g., bug fixes with clear reproduction steps). A reason is required and logged in the activity stream. Prefer chorus_pm_start_elaboration for most Ideas.

**Required Permission**: `idea:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| reason | string | Yes | Reason for skipping elaboration |

**Output**:
```json
{
  "ideaUuid": "...",
  "action": "elaboration_skipped",
  "reason": "Bug fix with clear reproduction steps"
}
```

### chorus_move_idea

**Description**: Move an Idea to a different Project within the same company. Cascade-migrates the Idea itself, all linked Proposals (any status), all materialized Documents and Tasks, and all related Activities atomically. Comments, TaskDependency, AcceptanceCriterion, AgentSession, SessionTaskCheckin, Notification history, and Task assignees are NOT modified. Requires `idea:write` permission only — no project-level checks.

**Required Permission**: `idea:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| targetProjectUuid | string | Yes | Target Project UUID |

**Output**: Updated Idea JSON with cascade counts (`{ uuid, project: { uuid, name }, moved: { proposals, documents, tasks, activities } }`)

### chorus_pm_create_idea

**Description**: Create an Idea in a project (submit requirements on behalf of humans or from discovered requirements)

**Required Permission**: `idea:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| title | string | Yes | Idea title |
| content | string | No | Idea detailed description |

**Output**: Created Idea JSON (`{ uuid, title }`)

### chorus_pm_reject_proposal

**Description**: Reject a Proposal (pending -> draft). PM agents can only reject their own proposals; admin agents can reject any proposal. The reviewNote is preserved as reference.

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| reviewNote | string | Yes | Rejection reason (serves as revision reference) |

**Guards**: Proposal must exist, status must be `pending`. PM: `createdByUuid` must match. Admin: no ownership restriction.

**Output**: Updated Proposal JSON (`{ uuid, status }`)

### chorus_pm_revoke_proposal

**Description**: Revoke an approved Proposal (approved -> draft). PM agents can only revoke their own proposals; admin agents can revoke any proposal. Cascade-closes all materialized Tasks and deletes all materialized Documents.

**Required Permission**: `proposal:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| reviewNote | string | No | Reason for revoking |

**Guards**: Proposal must exist, status must be `approved`. PM: `createdByUuid` must match. Admin: no ownership restriction.

**Output**: JSON with `{ uuid, status: "draft", closedTasks: [...], deletedDocuments: [...] }`

---

## Developer Agent Tools

Tools gated by `task:write`. Available to any agent whose effective permissions include `task:write` — by default this is `developer_agent`, `pm_agent`, and `admin_agent` presets, plus any custom agent with `task:write` added.

> Note: `task:write` grants tool visibility. Handler-level guards still enforce that only the assignee can execute operational transitions (e.g., `chorus_submit_for_verify`, `chorus_report_work`) — a `pm_agent` cannot operate on a task unless they have claimed/been assigned it.

### chorus_claim_task

**Description**: Claim a Task (open → assigned)

**Required Permission**: `task:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON

### chorus_release_task

**Description**: Release a claimed Task (assigned → open)

**Required Permission**: `task:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON

### chorus_update_task

**Description**: Update a task — edit fields, manage dependencies, or change status.

> **Public tool** — not permission-gated. Available to every agent. Field edits and dependency edits require no special permission; status transitions are still gated at the handler level to the task's assignee.

Three distinct edit modes can be combined in a single call:

- **Field editing** (any agent): `title`, `description`, `priority`, `storyPoints`, `addDependsOn`, `removeDependsOn`.
- **Acceptance criteria editing** (any agent): `acceptanceCriteriaItems` — **replaces** the task's acceptance criteria with the provided non-empty set. Omit it to leave criteria untouched.
- **Status update** (assignee only): `status` (`in_progress` requires all dependencies resolved; `to_verify` submits for human verification).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| title | string | No | New task title |
| description | string | No | New task description (supports @mentions) |
| priority | enum | No | New priority: low, medium, high |
| storyPoints | number | No | New effort estimate (agent hours) |
| acceptanceCriteriaItems | array | No | Replace the task's acceptance criteria with this non-empty set: `[{ description: string, required?: boolean }]`. Omit to leave AC unchanged; an empty or all-blank array is rejected (cannot clear AC). |
| addDependsOn | string[] | No | Task UUIDs to add as dependencies (incremental) |
| removeDependsOn | string[] | No | Task UUIDs to remove from dependencies (incremental) |
| status | enum | No | New status: in_progress, to_verify (assignee only) |
| sessionUuid | string | No | Associated Session UUID (attributes which worker performed the action) |

**Behavior**:
- When `acceptanceCriteriaItems` is provided, the task's existing acceptance criteria are deleted and recreated from the new set. This discards any prior dev/admin verification marks on those criteria (changing the definition of done invalidates prior checks). Omitting the field leaves criteria untouched, so status transitions and dependency edits never require resending acceptance criteria.
- When `sessionUuid` is provided, the Activity record includes session attribution, and a session heartbeat is automatically sent.
- `addDependsOn` / `removeDependsOn` accept arrays — multiple dependency edits are applied in a single call. Each entry is validated independently (same-project check, self-dependency check, DFS cycle detection); per-entry failures surface in the `warnings` array of the response without rolling back successful edits.
- **Dependency enforcement**: When transitioning to `in_progress`, the system checks that all `dependsOn` tasks are resolved (`done` or `closed`). If any dependency is unresolved, the request is rejected with a detailed error listing each blocker's title, status, assignee, and active session info. Use `chorus_get_unblocked_tasks` to find tasks that are ready to start.

**Add a dependency**:
```json
{
  "taskUuid": "downstream-task-uuid",
  "addDependsOn": ["upstream-task-uuid"]
}
```

**Remove a dependency**:
```json
{
  "taskUuid": "downstream-task-uuid",
  "removeDependsOn": ["upstream-task-uuid"]
}
```

**Swap dependencies in one call (replace upstream A with upstream B)**:
```json
{
  "taskUuid": "downstream-task-uuid",
  "addDependsOn": ["upstream-b-uuid"],
  "removeDependsOn": ["upstream-a-uuid"]
}
```

**Combine field edit, dependency edit, and status transition**:
```json
{
  "taskUuid": "...",
  "title": "Refined task title",
  "priority": "high",
  "addDependsOn": ["new-dep-uuid"],
  "status": "in_progress",
  "sessionUuid": "..."
}
```

**Output**: Updated Task JSON. If dependency edits produced any per-entry failures, a `warnings: string[]` field is included. On a rejected `in_progress` transition, returns an error with blocker details instead.

### chorus_submit_for_verify

**Description**: Submit a task for human verification (in_progress → to_verify)

**Required Permission**: `task:write` (handler also checks caller is the assignee)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| summary | string | No | Work summary |

**Output**: Updated Task JSON

### chorus_report_work

**Description**: Report work progress or completion

**Required Permission**: `task:write` (handler also checks caller is the assignee)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| report | string | Yes | Work report content |
| status | enum | No | Optionally update status simultaneously: in_progress, to_verify |
| sessionUuid | string | No | Associated Session UUID (used to attribute which worker performed the action) |

**Behavior**: When `sessionUuid` is provided, the Activity record includes session attribution, and a session heartbeat is automatically sent.

**Output**: Confirmation message

---

## Admin Agent Tools

Tools gated by one of the `*:admin` permissions or `project:write`. Available to any agent whose effective permissions cover the required permission listed under each tool. The `admin_agent` preset carries all `*:admin` permissions, but individual admin tools can be granted to other agents via custom permissions.

### chorus_admin_create_project

**Description**: Create a new project

**Required Permission**: `project:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Project name |
| description | string | No | Project description |

**Output**: Created Project JSON

### chorus_admin_approve_proposal

**Description**: Approve a Proposal

**Required Permission**: `proposal:admin`

**Important behavior**: Upon approval, the system automatically materializes all drafts in the Proposal into actual resources:
- `documentDrafts` → Automatically creates corresponding Documents (linked to this Proposal)
- `taskDrafts` → Automatically creates corresponding Tasks (linked to this Proposal)

Therefore, after approval there is **no need** to manually call `chorus_create_tasks` or `chorus_pm_create_document` to create these resources, as doing so would produce duplicate data. `chorus_create_tasks` and `chorus_pm_create_document` are only for creating resources directly without going through the Proposal flow.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| reviewNote | string | No | Review note |

**Output**: Updated Proposal JSON

### chorus_admin_close_proposal

**Description**: Close a Proposal (pending → closed). Permanently closes the proposal; cannot be edited after.

**Required Permission**: `proposal:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| reviewNote | string | Yes | Reason for closing |

**Output**: Updated Proposal JSON (`{ uuid, status: "closed" }`)

### chorus_report_criteria_self_check

**Description**: Report self-check results on acceptance criteria for a task (Developer tool)

**Required Permission**: `task:write` (handler also checks caller is the assignee)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| criteria | array | Yes | Array of `{ uuid: string, devStatus: "passed"\|"failed", devEvidence?: string }` |

**Output**: Updated acceptance status `{ items, status, summary }`

### chorus_mark_acceptance_criteria

**Description**: Mark acceptance criteria as passed or failed during admin verification (batch)

**Required Permission**: `task:admin` (kept out of `task:write` so developer preset cannot self-approve — see `permission-map.ts`)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| criteria | array | Yes | Array of `{ uuid: string, status: "passed"\|"failed", evidence?: string }` |

**Output**: Updated acceptance status `{ items, status, summary }`

### chorus_admin_verify_task

**Description**: Verify a Task (to_verify → done). **Acceptance criteria gate**: If the task has structured acceptance criteria, all required criteria must have `status: "passed"` before verification is allowed. Tasks without structured criteria are not gated (backward compatible).

**Required Permission**: `task:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON (or error if acceptance criteria gate blocks verification)

### chorus_admin_reopen_task

**Description**: Reopen a Task (to_verify → in_progress, used when verification fails). If the task has unresolved dependencies, use `force=true` to bypass the dependency check.

**Required Permission**: `task:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| force | boolean | No | Force status change, bypassing dependency check. When used, a `force_status_change` activity is logged. |

**Output**: Updated Task JSON

### chorus_admin_close_task

**Description**: Close a Task (any status → closed)

**Required Permission**: `task:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON

### chorus_admin_delete_idea

**Description**: Delete an Idea

**Required Permission**: `idea:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Confirmation message

### chorus_admin_delete_task

**Description**: Delete a Task

**Required Permission**: `task:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Confirmation message

### chorus_admin_delete_document

**Description**: Delete a Document

**Required Permission**: `document:admin`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| documentUuid | string | Yes | Document UUID |

**Output**: Confirmation message

### chorus_admin_create_project_group

**Description**: Create a new project group

**Required Permission**: `project:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Project group name |
| description | string | No | Project group description |

**Output**: Created Project Group JSON (includes uuid, name, description, projectCount, createdAt, updatedAt)

### chorus_admin_update_project_group

**Description**: Update a project group

**Required Permission**: `project:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| groupUuid | string | Yes | Project Group UUID |
| name | string | No | New group name |
| description | string | No | New group description |

**Output**: Updated Project Group JSON

### chorus_admin_delete_project_group

**Description**: Delete a project group. Projects in the group become ungrouped.

**Required Permission**: `project:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| groupUuid | string | Yes | Project Group UUID |

**Output**: Confirmation message

### chorus_admin_move_project_to_group

**Description**: Move a project to a different group or ungroup it. Set groupUuid to null to ungroup.

**Required Permission**: `project:write`

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| groupUuid | string\|null | Yes | Target Project Group UUID (null to ungroup) |

**Output**:
```json
{
  "uuid": "Project UUID",
  "name": "Project name",
  "groupUuid": "Group UUID or null"
}
```

---

## Test Records

### Test Date: 2026-02-07

### Test Environment
- Agent: Sr. Claude (uuid: 1e7019fd-..., roles: developer_agent, pm_agent, admin_agent)
- Server: localhost:8637

### Test Flow and Results

| # | Tool | Action | Result | Notes |
|---|------|--------|--------|-------|
| 1 | chorus_checkin | Agent check-in | ✅ Pass | Returns agent info, assignments, pending |
| 2 | chorus_admin_create_project | Create project | ✅ Pass | Returns project UUID |
| 3 | chorus_get_project | Get project details | ✅ Pass | |
| 4 | chorus_pm_create_idea | Create Idea | ✅ Pass | status=open |
| 5 | chorus_get_ideas | Get Ideas list | ✅ Pass | Pagination correct |
| 6 | chorus_get_idea | Get single Idea | ✅ Pass | ⚠️ Returned `id` field (should be hidden) |
| 7 | chorus_get_available_ideas | Get claimable Ideas | ✅ Pass | |
| 8 | chorus_claim_idea | Claim Idea | ✅ Pass | open → elaborating |
| 9 | chorus_update_idea_status | Update Idea status | ✅ Pass | (status transitions) |
| 10 | chorus_get_my_assignments | Get my assignments | ✅ Pass | ideaTracker + taskTracker grouped by project (0.7.2) |
| 11 | chorus_add_comment (idea) | Comment on Idea | ✅ Pass | |
| 12 | chorus_get_comments | Get comments list | ✅ Pass | |
| 13 | chorus_pm_create_proposal | Create Proposal | ✅ Pass | Contains documentDrafts + taskDrafts, status=draft |
| 14 | chorus_get_proposals | Get Proposals list | ✅ Pass | |
| 15 | chorus_get_proposal | Get single Proposal | ✅ Pass | |
| 16 | chorus_pm_add_document_draft | Add document draft | ✅ Pass | Appended to documentDrafts |
| 17 | chorus_pm_add_task_draft | Add task draft | ✅ Pass | ⚠️ storyPoints must be number type (MCP sends string, causes error) |
| 18 | chorus_pm_update_document_draft | Update document draft | ✅ Pass | |
| 19 | chorus_pm_update_task_draft | Update task draft | ✅ Pass | |
| 20 | chorus_pm_remove_task_draft | Remove task draft | ✅ Pass | |
| 21 | chorus_pm_submit_proposal | Submit Proposal for approval | ✅ Pass | draft → pending (**new tool**) |
| 22 | chorus_admin_approve_proposal | Approve Proposal | ✅ Pass | pending → approved, ⚠️ auto-creates tasks and documents from drafts |
| 23 | chorus_add_comment (proposal) | Comment on Proposal | ✅ Pass | |
| 24 | chorus_create_tasks | Batch create tasks | ✅ Pass | ⚠️ If approve already auto-created, manual call produces duplicates |
| 25 | chorus_pm_create_document | Create document | ✅ Pass | version=1 |
| 26 | chorus_pm_update_document | Update document | ✅ Pass | version auto-increments to 2 |
| 27 | chorus_list_tasks | List tasks | ✅ Pass | |
| 28 | chorus_get_available_tasks | Get claimable Tasks | ✅ Pass | |
| 29 | chorus_claim_task | Claim Task | ✅ Pass | open → assigned |
| 30 | chorus_update_task | Update task status | ✅ Pass | assigned → in_progress |
| 31 | chorus_report_work | Report work progress | ✅ Pass | Records activity |
| 32 | chorus_add_comment (task) | Comment on Task | ✅ Pass | |
| 33 | chorus_submit_for_verify | Submit for verification | ✅ Pass | in_progress → to_verify |
| 34 | chorus_admin_reopen_task | Reopen Task | ✅ Pass | to_verify → in_progress |
| 35 | chorus_admin_verify_task | Verify Task | ✅ Pass | to_verify → done |
| 36 | chorus_release_task | Release claimed Task | ✅ Pass | assigned → open |
| 37 | chorus_admin_close_task | Close Task | ✅ Pass | any → closed |
| 38 | chorus_get_task | Get single Task | ✅ Pass | ⚠️ Returned `id` field (should be hidden) |
| 39 | chorus_get_document | Get single document | ✅ Pass | |
| 40 | chorus_get_activity | Get activity stream | ✅ Pass | Recorded submit, comment_added, etc. |
| 41 | chorus_release_idea | Release claimed Idea | ✅ Pass | assigned → open |
| 42 | chorus_admin_close_idea | Close Idea | ✅ Pass | any → closed |
| 43 | chorus_pm_reject_proposal | Reject Proposal | ✅ Pass | pending → draft, includes reviewNote |
| 44 | chorus_admin_delete_task | Delete Task | ✅ Pass | |
| 45 | chorus_admin_delete_document | Delete Document | ✅ Pass | |
| 46 | chorus_admin_delete_idea | Delete Idea | ✅ Pass | |

### Issues Found and Fixes

#### Bug: Missing `chorus_pm_submit_proposal` tool (Fixed ✅)
- **Issue**: After Proposal creation status=draft, but no MCP tool could submit it to pending status, making `admin_approve_proposal` unusable (only accepts pending status)
- **Fix**: Added `chorus_pm_submit_proposal` tool in `src/mcp/tools/pm.ts`

#### Bug: `get_idea` and `get_task` returned raw DB fields (Fixed ✅)
- **Issue**: `chorus_get_idea` and `chorus_get_task` returned `id` (database auto-increment ID) and `companyUuid` and other internal fields
- **Fix**: Changed to call `ideaService.getIdea()` and `taskService.getTask()`, returning formatted responses

#### Bug: PM tool set incorrectly included Developer tools (Fixed ✅)
- **Issue**: PM Agent was incorrectly registered with the Developer tool set
- **Fix**: Modified `src/mcp/server.ts` so PM Agent only registers Public + PM tools

#### Bug: Incomplete Activity records (Fixed ✅)
- **Issue**: Only `submit_for_verify` and `report_work` generated Activity records, 12 other operations were missing
- **Fix**: Added Activity records for the following operations:
  - PM: `claim_idea`, `release_idea`, `update_idea_status`
  - Developer: `claim_task`, `release_task`, `update_task`
  - Admin: `approve_proposal`, `reject_proposal`, `verify_task`, `reopen_task`, `close_task`, `close_idea`

#### Note: `admin_approve_proposal` auto-materializes drafts (Documented ✅)
- Approving a Proposal automatically materializes drafts into actual Tasks and Documents
- After approval, there is no need to manually call `chorus_create_tasks` or `chorus_pm_create_document`
