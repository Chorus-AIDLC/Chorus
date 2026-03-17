# Chorus MCP Tools Documentation

This document covers all tools provided by the Chorus MCP Server, including tool names, descriptions, input parameters, and output formats.

## Overview

The Chorus MCP Server provides different tool sets based on Agent roles:

| Role | Tool Set |
|------|----------|
| Developer Agent | Public + Session + Developer |
| PM Agent | Public + Session + PM |
| Admin Agent | Public + Session + Admin + PM + Developer |

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
- `chorus_get_my_assignments` - Returns filtered ideas and tasks

### Usage Example

```json
// .mcp.json configuration for single project
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
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
      "url": "http://localhost:3000/api/mcp",
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
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxx",
        "X-Chorus-Project-Group": "group-uuid-here"
      }
    }
  }
}
```

---

## Public Tools

Tools available to all Agents.

### chorus_checkin

**Description**: Agent check-in. Returns agent identity (including owner/master info), roles, assigned work, and pending counts. Recommended at session start.

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
    "roles": ["developer"],
    "persona": "Persona description",
    "systemPrompt": "System prompt (optional)",
    "owner": { "uuid": "User UUID", "name": "Owner Name", "email": "owner@example.com" }
  },
  "assignments": {
    "ideas": [...],
    "tasks": [...]
  },
  "pending": {
    "ideasCount": 0,
    "tasksCount": 0
  },
  "notifications": {
    "unreadCount": 0
  }
}
```

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

**Description**: Get the list of Ideas for a project

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
  "ideas": [...],
  "total": 10,
  "page": 1,
  "pageSize": 20
}
```

### chorus_get_idea

**Description**: Get detailed information for a single Idea

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Idea details JSON

### chorus_get_documents

**Description**: Get the list of documents for a project

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| type | string | No | Filter by type: prd, tech_design, adr, etc. |
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

**Description**: Get detailed information for a single proposal, including document drafts and task drafts

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |

**Output**: Proposal details JSON (includes documentDrafts and taskDrafts)

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

**Description**: Get all Ideas and Tasks assigned to the current Agent

**Project Filtering**: Results can be filtered by project using HTTP headers during MCP connection:
- `X-Chorus-Project`: Single or multiple project UUIDs (comma-separated)
- `X-Chorus-Project-Group`: Project group UUID (includes all projects in the group)
- No header: Returns all projects (default behavior)

**Input**: None

**Output**:
```json
{
  "ideas": [...],
  "tasks": [...]
}
```

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

**Description**: Answer elaboration questions for an Idea. Submits answers for a specific elaboration round. When all required questions are answered, the round moves to validation.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| roundUuid | string | Yes | Elaboration round UUID |
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

---

## Session Tools

Available to all Agents. Used to manage Agent work sessions (e.g., sub-agent workers in swarm mode).

### chorus_create_session

**Description**: Create a new Agent Session (e.g., representing a sub-agent worker)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Session name (e.g., "frontend-worker") |
| description | string | No | Session description |
| expiresAt | string | No | Expiration time (ISO timestamp) |

**Output**:
```json
{
  "uuid": "Session UUID",
  "agentUuid": "Agent UUID",
  "name": "frontend-worker",
  "description": "...",
  "status": "active",
  "lastActiveAt": "ISO timestamp",
  "expiresAt": null,
  "createdAt": "ISO timestamp",
  "activeCheckins": []
}
```

### chorus_list_sessions

**Description**: List all Sessions for the current Agent

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| status | string | No | Filter by status: active, inactive, closed |

**Output**:
```json
{
  "sessions": [...],
  "total": 3
}
```

### chorus_get_session

**Description**: Get Session details and its active Task checkins

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Session details JSON (includes activeCheckins list)

### chorus_close_session

**Description**: Close a Session (active/inactive → closed). Automatically checks out all active Task checkins.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Updated Session JSON

### chorus_reopen_session

**Description**: Reopen a closed Session (closed → active). Used to reuse a previous session without creating a new one.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |

**Output**: Updated Session JSON (status=active, lastActiveAt refreshed)

### chorus_session_checkin_task

**Description**: Check in a Session to a Task, indicating work has started

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |
| taskUuid | string | Yes | Task UUID |

**Output**: Checkin record JSON

### chorus_session_checkout_task

**Description**: Check out a Session from a Task, indicating work has ended

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionUuid | string | Yes | Session UUID |
| taskUuid | string | Yes | Task UUID |

**Output**: Updated checkin record JSON

### chorus_session_heartbeat

**Description**: Session heartbeat, updates lastActiveAt. Active sessions with no heartbeat for 1 hour are automatically marked as inactive.

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

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Updated Idea JSON

### chorus_release_idea

**Description**: Release a claimed Idea (elaborating → open)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Updated Idea JSON

### chorus_update_idea_status

**Description**: Update Idea status (only the assignee can perform this). Valid statuses: open, elaborating, proposal_created, completed, closed. Claiming auto-transitions to elaborating; use this tool for proposal_created (after Proposal submission) or completed (after approval).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| status | enum | Yes | New status: proposal_created, completed |

**Output**: Updated Idea JSON

### chorus_pm_create_proposal

**Description**: Create a proposal container (can include document drafts and task drafts)

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

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |

**Output**: Updated Proposal JSON (status changes to pending)

### chorus_pm_create_document

**Description**: Create a document (PRD, technical design, ADR, etc.)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| type | enum | Yes | Document type: prd, tech_design, adr, spec, guide |
| title | string | Yes | Document title |
| content | string | No | Document content (Markdown) |
| proposalUuid | string | No | Associated Proposal UUID |

**Output**: Created Document JSON

### chorus_pm_create_tasks

**Description**: Batch create tasks (can be associated with a Proposal, supports intra-batch dependencies)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| proposalUuid | string | No | Associated Proposal UUID |
| tasks | array | Yes | Task list |

**tasks array item fields**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Task title |
| description | string | No | Task description |
| priority | enum | No | Priority: low, medium, high |
| storyPoints | number | No | Effort estimate (Agent hours) |
| acceptanceCriteria | string | No | Acceptance criteria (Markdown, legacy) |
| acceptanceCriteriaItems | array | No | Structured acceptance criteria: `[{ description: string, required?: boolean }]` |
| draftUuid | string | No | Temporary UUID for intra-batch dependsOnDraftUuids references |
| dependsOnDraftUuids | string[] | No | List of intra-batch draftUuids this task depends on |
| dependsOnTaskUuids | string[] | No | List of existing Task UUIDs this task depends on |

**Output**:
```json
{
  "tasks": [...],
  "count": 3,
  "draftToTaskUuidMap": { "draft-1": "real-uuid-1", ... },
  "warnings": ["..."]
}
```
- `draftToTaskUuidMap`: Only returned when any task provides a draftUuid
- `warnings`: Only returned when there are issues creating dependencies (tasks themselves are created successfully)

### chorus_pm_update_document

**Description**: Update document content (increments version number)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| documentUuid | string | Yes | Document UUID |
| title | string | No | New title |
| content | string | No | New content (Markdown) |

**Output**: Updated Document JSON

### chorus_pm_add_document_draft

**Description**: Add a document draft to a pending Proposal container

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

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| title | string | Yes | Task title |
| description | string | No | Task description |
| storyPoints | number | No | Effort estimate (Agent hours) |
| priority | enum | No | Priority: low, medium, high |
| acceptanceCriteria | string | No | Acceptance criteria (Markdown, legacy) |
| acceptanceCriteriaItems | array | No | Structured acceptance criteria: `[{ description: string, required?: boolean }]` |
| dependsOnDraftUuids | string[] | No | List of dependent taskDraft UUIDs (automatically converted to real dependencies upon approval) |

**Output**: Updated Proposal JSON

### chorus_pm_update_document_draft

**Description**: Update a document draft in a Proposal

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

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Task draft UUID |
| title | string | No | Task title |
| description | string | No | Task description |
| storyPoints | number | No | Effort estimate |
| priority | enum | No | Priority |
| acceptanceCriteria | string | No | Acceptance criteria |
| dependsOnDraftUuids | string[] | No | List of dependent taskDraft UUIDs |

**Output**: Updated Proposal JSON

### chorus_pm_remove_document_draft

**Description**: Remove a document draft from a Proposal

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Document draft UUID |

**Output**: Updated Proposal JSON

### chorus_pm_remove_task_draft

**Description**: Remove a task draft from a Proposal

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| draftUuid | string | Yes | Task draft UUID |

**Output**: Updated Proposal JSON

### chorus_add_task_dependency

**Description**: Add a task dependency (taskUuid depends on dependsOnTaskUuid). Includes same-project validation, self-dependency check, and DFS cycle detection.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID (downstream task) |
| dependsOnTaskUuid | string | Yes | Dependent Task UUID (upstream task) |

**Output**: Created dependency JSON
```json
{
  "taskUuid": "...",
  "dependsOnUuid": "...",
  "createdAt": "ISO timestamp"
}
```

**Error scenarios**:
- Self-dependency: `A task cannot depend on itself`
- Task not found: `Task not found` / `Dependency task not found`
- Cross-project: `Tasks must belong to the same project`
- Cycle detected: `Adding this dependency would create a cycle`

### chorus_remove_task_dependency

**Description**: Remove a task dependency

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| dependsOnTaskUuid | string | Yes | Dependency Task UUID to remove |

**Output**:
```json
{
  "success": true,
  "taskUuid": "...",
  "dependsOnTaskUuid": "..."
}
```

### chorus_pm_assign_task

**Description**: Assign a task to a specified Developer Agent (task must be in open or assigned status)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| agentUuid | string | Yes | Target Developer Agent UUID |

**Output**: Updated Task JSON

**Validation rules**:
- Task must be in open or assigned status
- Target Agent must exist and belong to the same company
- Target Agent must have the developer or developer_agent role

### chorus_pm_start_elaboration

**Description**: Start an elaboration round for an Idea. Creates structured questions for the Idea creator/stakeholder to answer, clarifying requirements before proposal creation. Recommended for every Idea. Structured elaboration improves Proposal quality and reduces rejection cycles.

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

**Description**: Validate answers from an elaboration round. If no issues are found, the elaboration is marked as resolved. If issues exist, optionally provide follow-up questions for a new round.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| roundUuid | string | Yes | Elaboration round UUID |
| issues | array | Yes | List of issues found (empty array = all valid) |
| followUpQuestions | array | No | Follow-up questions for a new round (only if issues found) |

**issues array item fields**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| questionId | string | Yes | Question ID with the issue |
| type | enum | Yes | Issue type: contradiction, ambiguity, incomplete |
| description | string | Yes | Issue description |

**followUpQuestions array item fields**: Same as `questions` in `chorus_pm_start_elaboration`.

**Output**: Validation result JSON. If issues are empty, elaboration status changes to `resolved`. If follow-up questions are provided, a new round is created with status `pending_answers`.

### chorus_pm_skip_elaboration

**Description**: Skip elaboration for an Idea (marks as resolved with minimal depth). Use only for trivially clear Ideas (e.g., bug fixes with clear reproduction steps). A reason is required and logged in the activity stream. Prefer chorus_pm_start_elaboration for most Ideas.

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

**Description**: Move an Idea to a different project within the same company. Also moves linked draft/pending Proposals.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |
| targetProjectUuid | string | Yes | Target Project UUID |

**Output**: Updated Idea JSON (`{ uuid, project: { uuid, name } }`)

### chorus_pm_create_idea

**Description**: Create an Idea in a project (submit requirements on behalf of humans or from discovered requirements)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| projectUuid | string | Yes | Project UUID |
| title | string | Yes | Idea title |
| content | string | No | Idea detailed description |

**Output**: Created Idea JSON (`{ uuid, title }`)

---

## Developer Agent Tools

Available to Developer Agent and Admin Agent. Not available to PM Agent.

### chorus_claim_task

**Description**: Claim a Task (open → assigned)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON

### chorus_release_task

**Description**: Release a claimed Task (assigned → open)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON

### chorus_update_task

**Description**: Update task status (only the assignee can perform this)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| status | enum | Yes | New status: in_progress, to_verify |
| sessionUuid | string | No | Associated Session UUID (used to attribute which worker performed the action) |

**Behavior**:
- When `sessionUuid` is provided, the Activity record includes session attribution, and a session heartbeat is automatically sent.
- **Dependency enforcement**: When transitioning to `in_progress`, the system checks that all `dependsOn` tasks are resolved (`done` or `closed`). If any dependency is unresolved, the request is rejected with a detailed error listing each blocker's title, status, assignee, and active session info. Use `chorus_get_unblocked_tasks` to find tasks that are ready to start.

**Output**: Updated Task JSON (or error with blocker details if dependencies are unresolved)

### chorus_submit_for_verify

**Description**: Submit a task for human verification (in_progress → to_verify)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| summary | string | No | Work summary |

**Output**: Updated Task JSON

### chorus_report_work

**Description**: Report work progress or completion

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

Available only to Admin Agent. Used to perform approval, verification, and project management operations on behalf of humans.

### chorus_admin_create_project

**Description**: Create a new project

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Project name |
| description | string | No | Project description |

**Output**: Created Project JSON

### chorus_admin_approve_proposal

**Description**: Approve a Proposal

**Important behavior**: Upon approval, the system automatically materializes all drafts in the Proposal into actual resources:
- `documentDrafts` → Automatically creates corresponding Documents (linked to this Proposal)
- `taskDrafts` → Automatically creates corresponding Tasks (linked to this Proposal)

Therefore, after approval there is **no need** to manually call `chorus_pm_create_tasks` or `chorus_pm_create_document` to create these resources, as doing so would produce duplicate data. `chorus_pm_create_tasks` and `chorus_pm_create_document` are only for creating resources directly without going through the Proposal flow.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| reviewNote | string | No | Review note |

**Output**: Updated Proposal JSON

### chorus_admin_reject_proposal

**Description**: Reject a Proposal

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| proposalUuid | string | Yes | Proposal UUID |
| reviewNote | string | Yes | Rejection reason (required) |

**Output**: Updated Proposal JSON

### chorus_report_criteria_self_check

**Description**: Report self-check results on acceptance criteria for a task (Developer tool)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| criteria | array | Yes | Array of `{ uuid: string, devStatus: "passed"\|"failed", devEvidence?: string }` |

**Output**: Updated acceptance status `{ items, status, summary }`

### chorus_mark_acceptance_criteria

**Description**: Mark acceptance criteria as passed or failed during admin verification (batch)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| criteria | array | Yes | Array of `{ uuid: string, status: "passed"\|"failed", evidence?: string }` |

**Output**: Updated acceptance status `{ items, status, summary }`

### chorus_admin_verify_task

**Description**: Verify a Task (to_verify → done). **Acceptance criteria gate**: If the task has structured acceptance criteria, all required criteria must have `status: "passed"` before verification is allowed. Tasks without structured criteria are not gated (backward compatible).

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON (or error if acceptance criteria gate blocks verification)

### chorus_admin_reopen_task

**Description**: Reopen a Task (to_verify → in_progress, used when verification fails). If the task has unresolved dependencies, use `force=true` to bypass the dependency check.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |
| force | boolean | No | Force status change, bypassing dependency check. When used, a `force_status_change` activity is logged. |

**Output**: Updated Task JSON

### chorus_admin_close_task

**Description**: Close a Task (any status → closed)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Updated Task JSON

### chorus_admin_close_idea

**Description**: Close an Idea (any status → closed)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Updated Idea JSON

### chorus_admin_delete_idea

**Description**: Delete an Idea

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| ideaUuid | string | Yes | Idea UUID |

**Output**: Confirmation message

### chorus_admin_delete_task

**Description**: Delete a Task

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| taskUuid | string | Yes | Task UUID |

**Output**: Confirmation message

### chorus_admin_delete_document

**Description**: Delete a Document

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| documentUuid | string | Yes | Document UUID |

**Output**: Confirmation message

### chorus_admin_create_project_group

**Description**: Create a new project group (Admin exclusive)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Project group name |
| description | string | No | Project group description |

**Output**: Created Project Group JSON (includes uuid, name, description, projectCount, createdAt, updatedAt)

### chorus_admin_update_project_group

**Description**: Update a project group (Admin exclusive)

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| groupUuid | string | Yes | Project Group UUID |
| name | string | No | New group name |
| description | string | No | New group description |

**Output**: Updated Project Group JSON

### chorus_admin_delete_project_group

**Description**: Delete a project group (Admin exclusive). Projects in the group become ungrouped.

**Input**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| groupUuid | string | Yes | Project Group UUID |

**Output**: Confirmation message

### chorus_admin_move_project_to_group

**Description**: Move a project to a different group or ungroup it (Admin exclusive). Set groupUuid to null to ungroup.

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
- Server: localhost:3000

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
| 10 | chorus_get_my_assignments | Get my assignments | ✅ Pass | ideas and tasks lists |
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
| 24 | chorus_pm_create_tasks | Batch create tasks | ✅ Pass | ⚠️ If approve already auto-created, manual call produces duplicates |
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
| 43 | chorus_admin_reject_proposal | Reject Proposal | ✅ Pass | pending → rejected, includes reviewNote |
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
- After approval, there is no need to manually call `pm_create_tasks` or `pm_create_document`
