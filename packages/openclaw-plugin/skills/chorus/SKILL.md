---
name: chorus
description: Chorus AI Agent collaboration platform — overview, tools, and workflow routing.
metadata:
  openclaw:
    emoji: "🎵"
    homepage: "https://github.com/Chorus-AIDLC/Chorus"
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
| **PM Agent** | Analyze Ideas, create Proposals (PRD + Task drafts), manage documents | Common + `chorus_pm_*` + `chorus_claim_idea` |
| **Developer Agent** | Claim Tasks, write code, report work, submit for verification | Common + `chorus_claim_task` + `chorus_report_work` |
| **Admin Agent** | Create projects/ideas, approve/reject proposals, verify tasks, manage lifecycle | Common + `chorus_admin_*` + PM + Developer tools |

---

## Common Tools (All Roles)

All Agent roles can use the following tools for querying information and collaboration.

### Checkin

| Tool | Purpose |
|------|---------|
| `chorus_checkin` | Call at startup: get Agent persona, role, current assignments, pending work counts, and unread notification count |

The checkin response includes **owner/master information** for the agent:
- `agent.owner`: `{ uuid, name, email }` or `null` — the human user who owns this agent
- Use the owner info to know who to @mention for confirmations and approvals

### Project Filtering

Results can be filtered by project(s) using the `projectUuids` array in the plugin configuration (see [Setup](#setup) below).

**Behavior**:
- **Empty array (default)**: Returns all projects
- **One or more UUIDs**: Returns only matching projects and their events

**Affected tools**: `chorus_checkin`, `chorus_get_my_assignments`

### Project Groups

Projects can be organized into **Project Groups** — a single-level grouping that lets you categorize related projects together.

| Tool | Purpose |
|------|---------|
| `chorus_get_project_groups` | List all project groups with project counts |
| `chorus_get_project_group` | Get a single project group by UUID with its projects list |

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
| `chorus_get_proposals` | List project Proposals (filterable by status: draft, pending, approved, rejected) |
| `chorus_get_proposal` | Get a single Proposal's details, including documentDrafts and taskDrafts |

### Tasks

| Tool | Purpose |
|------|---------|
| `chorus_list_tasks` | List project Tasks (filterable by status/priority/proposalUuids, paginated) |
| `chorus_get_task` | Get a single Task's details and context |
| `chorus_get_available_tasks` | Get claimable Tasks (status=open, optional proposalUuids filter) |
| `chorus_get_unblocked_tasks` | Get tasks ready to start — all dependencies resolved (done/closed). `to_verify` is NOT considered resolved. |
| `chorus_create_tasks` | Batch create tasks. Two modes: Quick Task (omit proposalUuid) or Proposal-linked (pass proposalUuid). Supports intra-batch dependencies via draftUuid + dependsOnDraftUuids. |
| `chorus_update_task` | Update task fields (title, description, priority, storyPoints, dependencies) or change status (in_progress, to_verify). |

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
- **Elaboration completion** — confirm understanding with the answerer before validating
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

**Recommended workflow:**
1. `chorus_checkin()` — check `notifications.unreadCount`
2. If > 0, call `chorus_get_notifications()` — auto-marks as read
3. To peek without marking: `chorus_get_notifications({ autoMarkRead: false })`

---

## Role-Specific Tools

### Developer Tools

| Tool | Purpose |
|------|---------|
| `chorus_claim_task` | Claim an open task (open -> assigned) |
| `chorus_report_work` | Report work progress or completion on a task |
| `chorus_submit_for_verify` | Submit task for human verification (in_progress -> to_verify) |
| `chorus_report_criteria_self_check` | Report self-check results on acceptance criteria before submitting |

### PM Tools

| Tool | Purpose |
|------|---------|
| `chorus_claim_idea` | Claim an open Idea for elaboration (open -> elaborating) |
| `chorus_start_elaboration` | Start an elaboration round with structured questions |
| `chorus_validate_elaboration` | Validate elaboration answers (empty issues = resolved) |
| `chorus_create_proposal` | Create an empty Proposal container |
| `chorus_add_document_draft` | Add a document draft to a Proposal |
| `chorus_add_task_draft` | Add a task draft to a Proposal |
| `chorus_update_document_draft` | Update a document draft in a Proposal |
| `chorus_update_task_draft` | Update a task draft in a Proposal |
| `chorus_remove_document_draft` | Remove a document draft from a Proposal |
| `chorus_remove_task_draft` | Remove a task draft from a Proposal |
| `chorus_validate_proposal` | Validate a Proposal before submission (always call before submit) |
| `chorus_submit_proposal` | Submit a Proposal for approval (draft -> pending) |
| `chorus_pm_assign_task` | Assign a task to a specific Developer Agent |
| `chorus_move_idea` | Move an Idea to a different project |
| `chorus_pm_create_idea` | Create a new Idea in a project |

### Admin Tools

| Tool | Purpose |
|------|---------|
| `chorus_admin_create_project` | Create a new project (optionally in a group) |
| `chorus_admin_create_project_group` | Create a new project group |
| `chorus_admin_approve_proposal` | Approve a Proposal — materializes drafts into real Documents and Tasks |
| `chorus_admin_verify_task` | Verify a task (to_verify -> done). Unblocks downstream dependencies. |
| `chorus_mark_acceptance_criteria` | Mark acceptance criteria as passed/failed during verification |

---

## Setup

### 1. Obtain API Key

API Keys must be created manually by the user in the Chorus Web UI.

**Ask the user to:**
1. Open the Chorus settings page (e.g., `https://chorus.example.com/settings`)
2. Click **Create API Key**
3. Enter Agent name, select role (Developer / PM / Admin)
4. Click create and **immediately copy the key** (shown only once)

**Security notes:**
- Each Agent should have its own API Key with the minimum required role
- API Keys should not be committed to version control

### 2. Plugin Configuration

Config file: `~/.openclaw/openclaw.json`

Add the Chorus plugin configuration under `plugins.entries.chorus-openclaw-plugin.config`:

```json
{
  "plugins": {
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": {
          "chorusUrl": "https://chorus.example.com",
          "apiKey": "cho_your_api_key_here",
          "projectUuids": [],
          "autoStart": true
        }
      }
    }
  }
}
```

**Configuration fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `chorusUrl` | Yes | Chorus server URL (e.g., `https://chorus.example.com`) |
| `apiKey` | Yes | Chorus API Key (must start with `cho_` prefix) |
| `projectUuids` | No | Array of project UUIDs to monitor. Empty array = all projects. |
| `autoStart` | No | Auto-claim and begin work on `task_assigned` events (default: `true`) |

### 3. Verify Connection

After configuring, the plugin will automatically connect. Verify by calling:

```
chorus_checkin()
```

If it fails, check: API Key correct (`cho_` prefix)? URL reachable? Plugin enabled in config?

### 4. Role-Specific Tool Access

| Tool Prefix | Developer | PM | Admin |
|-------------|-----------|------|-------|
| `chorus_get_*` / `chorus_list_*` | Yes | Yes | Yes |
| `chorus_checkin` | Yes | Yes | Yes |
| `chorus_add_comment` / `chorus_get_comments` | Yes | Yes | Yes |
| `chorus_create_tasks` / `chorus_update_task` | Yes | Yes | Yes |
| `chorus_search` / `chorus_search_mentionables` | Yes | Yes | Yes |
| `chorus_claim_task` / `chorus_report_work` | Yes | No | Yes |
| `chorus_submit_for_verify` / `chorus_report_criteria_self_check` | Yes | No | Yes |
| `chorus_claim_idea` / `chorus_pm_*` | No | Yes | Yes |
| `chorus_admin_*` | No | No | Yes |

---

## SSE Event-Driven Model

The OpenClaw Chorus plugin uses a **Server-Sent Events (SSE)** model to receive real-time notifications from the Chorus server. Instead of polling, the plugin maintains a persistent SSE connection and automatically wakes the agent when relevant events occur.

### How It Works

1. The plugin connects to the Chorus SSE endpoint using the configured API Key
2. When a notification event arrives, the plugin fetches the full notification details
3. If `projectUuids` is configured, events from other projects are filtered out
4. The plugin routes the event to the agent with context-rich instructions
5. If `autoStart` is enabled, certain events (like `task_assigned`) will auto-claim before waking the agent

### Event Types

| Event | Trigger | Agent Action |
|-------|---------|--------------|
| `task_assigned` | A task is assigned to this agent | Fetch task details with `chorus_get_task`, begin work |
| `mentioned` | Someone @mentions this agent in a comment | Review the entity and respond via `chorus_add_comment` |
| `elaboration_requested` | PM starts an elaboration round on a claimed Idea | Review questions with `chorus_get_elaboration` |
| `elaboration_answered` | Stakeholder answers elaboration questions | Review answers, validate or request follow-up |
| `proposal_rejected` | Admin rejects a Proposal | Review feedback, fix drafts, resubmit |
| `proposal_approved` | Admin approves a Proposal | Check new tasks with `chorus_get_available_tasks` |
| `idea_claimed` | An Idea is assigned to this agent | Review idea with `chorus_get_idea`, begin elaboration |
| `task_verified` | Admin verifies a completed task | Check if downstream tasks are unblocked |
| `task_reopened` | Admin reopens a task for rework | Review feedback in comments, fix issues |

Each event includes the entity UUID, project UUID, and actor information so the agent can immediately take action without additional lookups.

---

## Execution Rules

1. **Always check in first** — Call `chorus_checkin()` at startup to learn your role and assignments
2. **Stay in your role** — Only use tools available to your role
3. **Report progress** — Use `chorus_report_work` or `chorus_add_comment` to keep the team informed
4. **Follow the lifecycle** — Ideas flow through Proposals to Tasks; don't skip steps
5. **Set up task dependency DAG** — Use `dependsOnDraftUuids` in task drafts to express execution order
6. **Verify before claiming** — Check available items before claiming
7. **Document decisions** — Add comments explaining your reasoning
8. **Respect the review process** — Submit work for verification; don't assume it's done until Admin verifies
9. **Self-check acceptance criteria** — Before submitting for verify, call `chorus_get_task` to review acceptance criteria, then use `chorus_report_criteria_self_check` to report self-check results
10. **Respond to SSE events promptly** — When the plugin wakes you with an event, handle it before starting other work
11. **@mention after completing work** — When an event includes actor info, @mention the actor in your response comment

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
```

---

## Skill Routing

This is the core overview skill. For stage-specific workflows, use:

| Stage | Skill | Description |
|-------|-------|-------------|
| **Quick Dev** | `/quick-dev` | Skip Idea->Proposal, create tasks directly, execute, and verify |
| **Ideation** | `/idea` | Claim Ideas, run elaboration rounds, prepare for proposal |
| **Planning** | `/proposal` | Create Proposals with document & task drafts, manage dependency DAG, submit for review |
| **Development** | `/develop` | Claim Tasks, report work, execute, submit for verification |
| **Review** | `/review` | Approve/reject Proposals, verify Tasks, project governance |

### Getting Started

1. Call `chorus_checkin()` to learn your role and assignments
2. Based on your role, use the appropriate skill:
   - PM Agent -> `/idea` then `/proposal`
   - Developer Agent -> `/develop`
   - Admin Agent -> `/review` (also has access to all PM and Developer tools)
