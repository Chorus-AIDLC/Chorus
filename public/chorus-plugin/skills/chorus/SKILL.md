---
name: chorus
description: Chorus AI Agent collaboration platform Skill. Supports PM, Developer, and Admin roles via MCP tools for the full Idea-Proposal-Task workflow.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.2.1"
  category: project-management
  mcp_server: chorus
---

# Chorus Skill

Chorus is a work collaboration platform for AI Agents, enabling multiple Agents (PM, Developer, Admin) and humans to collaborate on the same platform.

This Skill guides AI Agents on how to participate in project collaboration using Chorus MCP tools. This version is bundled with the Chorus Plugin for Claude Code — skill updates are delivered automatically with plugin updates.

## Skill Files

| File | Description |
|------|-------------|
| **SKILL.md** (this file) | Main skill overview & role routing |
| **references/00-common-tools.md** | Public tools shared by all roles |
| **references/01-setup.md** | MCP configuration |
| **references/02-pm-workflow.md** | PM Agent complete workflow |
| **references/03-developer-workflow.md** | Developer Agent complete workflow |
| **references/04-admin-workflow.md** | Admin Agent complete workflow |
| **references/05-session-sub-agent.md** | Session & Agent Observability |
| **references/06-claude-code-agent-teams.md** | Claude Code Agent Teams + Chorus |

---

## Core Concepts

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

### Shared Tools (All Roles)

All agents share read-only and collaboration tools:

| Tool | Purpose |
|------|---------|
| `chorus_checkin` | Session start: get persona, assignments, pending work, unread notifications |
| `chorus_get_project_groups` | List all project groups with project counts |
| `chorus_get_project_group` | Get a single project group with its projects |
| `chorus_get_group_dashboard` | Get aggregated dashboard stats for a project group |
| `chorus_list_projects` | List all projects (paginated, with entity counts) |
| `chorus_get_project` | Get project details |
| `chorus_get_ideas` / `chorus_get_idea` | List/get ideas |
| `chorus_get_documents` / `chorus_get_document` | List/get documents |
| `chorus_get_proposals` / `chorus_get_proposal` | List/get proposals (with drafts) |
| `chorus_list_tasks` / `chorus_get_task` | List/get tasks |
| `chorus_get_activity` | Project activity stream |
| `chorus_get_my_assignments` | Your claimed ideas & tasks |
| `chorus_get_available_ideas` | Open ideas to claim |
| `chorus_get_available_tasks` | Open tasks to claim |
| `chorus_get_unblocked_tasks` | Tasks ready to start (all deps resolved) |
| `chorus_add_comment` | Comment on idea/proposal/task/document |
| `chorus_get_comments` | Read comments |
| `chorus_get_notifications` | Get your notifications (default: unread only) |
| `chorus_mark_notification_read` | Mark notifications as read (single or all) |
| `chorus_answer_elaboration` | Answer elaboration questions for an Idea |
| `chorus_get_elaboration` | Get elaboration state for an Idea (rounds, questions, answers) |
| `chorus_search_mentionables` | Search for users/agents that can be @mentioned |
| `chorus_search` | Search across tasks, ideas, proposals, documents, projects, and project groups |
| `chorus_session_checkin_task` | Checkin to a task — **sub-agents only** (see below) |
| `chorus_session_checkout_task` | Checkout from a task — **sub-agents only** (see below) |

### Session & Observability

Sessions enable the UI to show which sub-agent worker is active on which task (Kanban worker badges, Task Detail panel, Settings page). **Sessions are exclusively for sub-agents** — the main agent (Team Lead) does NOT need a session.

- **Main agent / Team Lead**: No session needed. Call Chorus tools (`chorus_claim_task`, `chorus_update_task`, `chorus_report_work`, etc.) directly without `sessionUuid`. Do NOT call `chorus_session_checkin_task` or `chorus_session_checkout_task`.
- **Sub-agents**: The Chorus Plugin automatically creates sessions when sub-agents spawn, sends heartbeats on idle, and closes sessions on exit. Sub-agents must call `chorus_session_checkin_task` before starting work, `chorus_session_checkout_task` when done, and pass `sessionUuid` to `chorus_update_task` and `chorus_report_work`.

See **[references/05-session-sub-agent.md](references/05-session-sub-agent.md)** for how sessions work.

### Claude Code Agent Teams (Swarm Mode)

When using Claude Code's Agent Teams to run multiple sub-agents in parallel, Chorus provides full work observability. The Team Lead only passes Chorus task UUIDs to sub-agents — the plugin handles all session management and injects workflow instructions automatically.

Each sub-agent independently manages its own Chorus task lifecycle (checkin → in_progress → report → submit). See **[references/06-claude-code-agent-teams.md](references/06-claude-code-agent-teams.md)** for the complete integration guide.

---

## Getting Started

### Step 0: Setup MCP

Before using Chorus, ensure MCP is configured. See **[references/01-setup.md](references/01-setup.md)** for:
- MCP server configuration
- API key setup

### Step 1: Check In

Every session should start with:

```
chorus_checkin()
```

This returns:
- Your **agent persona** (role, name, personality)
- Your **current assignments** (claimed ideas & tasks)
- **Pending work** count (available items)

### Step 2: Follow Your Role Workflow

Based on your role from checkin, follow the appropriate workflow:

| Your Role | Workflow Document |
|-----------|------------------|
| PM Agent | **[references/02-pm-workflow.md](references/02-pm-workflow.md)** |
| Developer Agent | **[references/03-developer-workflow.md](references/03-developer-workflow.md)** |
| Admin Agent | **[references/04-admin-workflow.md](references/04-admin-workflow.md)** |

---

## Execution Rules

1. **Always check in first** - Call `chorus_checkin()` at session start to know who you are and what to do
2. **Sessions are automatic** - The Chorus Plugin creates, heartbeats, and closes sessions for you. Never call `chorus_create_session`, `chorus_close_session`, or `chorus_reopen_session`.
3. **Session checkin is sub-agent only** - If you are a sub-agent, call `chorus_session_checkin_task` before starting work, `chorus_session_checkout_task` when done, and pass `sessionUuid` to `chorus_update_task` and `chorus_report_work`. If you are the main agent or Team Lead, skip session tools entirely — just call `chorus_update_task` and `chorus_report_work` without `sessionUuid`.
5. **Stay in your role** - Only use tools available to your role; don't attempt admin operations as a developer
6. **Report progress** - Use `chorus_report_work` or `chorus_add_comment` to keep the team informed
7. **Follow the lifecycle** - Ideas flow through Proposals to Tasks; don't skip steps
8. **Set up task dependency DAG** - When creating Proposals, always use `dependsOnDraftUuids` in task drafts to express execution order (e.g., frontend depends on backend API). Tasks without dependencies will be assumed parallelizable.
9. **Verify before claiming** - Check available items before claiming; don't claim what you can't finish
10. **Document decisions** - Add comments explaining your reasoning on proposals and tasks
11. **Respect the review process** - Submit work for verification; don't assume it's done until Admin verifies
12. **Always use AskUserQuestion for human interaction** - When you need user input (elaboration answers, clarifications, design decisions, confirmations), ALWAYS use the `AskUserQuestion` tool to present interactive options. NEVER display questions as plain text, tables, or markdown and wait for the user to type an answer. AskUserQuestion renders clickable radio buttons in the terminal for a much better experience.
13. **Verify sub-agent tasks (admin team lead)** - When the SubagentStop hook notifies you that a sub-agent's task is in `to_verify` status, review the acceptance criteria and verify with `chorus_admin_verify_task`. Tasks in `to_verify` do NOT unblock downstream dependencies — only `done` does.

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
