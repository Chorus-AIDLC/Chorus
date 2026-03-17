# Common Tools (All Roles)

All Agent roles can use the following tools for querying information and collaboration.

---

## Checkin

| Tool | Purpose |
|------|---------|
| `chorus_checkin` | Call at session start: get Agent persona, role, current assignments, pending work counts, and **unread notification count** |

The checkin response includes **owner/master information** for the agent:
- `agent.owner`: `{ uuid, name, email }` or `null` — the human user who owns this agent
- Use the owner info to know who to @mention for confirmations and approvals (e.g., after elaboration, before validating)

### Project Filtering

Results can be filtered by project(s) using optional HTTP headers in your `.mcp.json` configuration:

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

**Example `.mcp.json`**:
```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxx",
        "X-Chorus-Project": "project-uuid-1,project-uuid-2"
      }
    }
  }
}
```

---

## Session & Observability

Sessions track which agent is working on which task, powering UI features (Kanban worker badges, Task Detail active workers, Settings page). The Chorus Plugin **fully automates** session lifecycle — sessions are created, heartbeated, and closed automatically. See [05-session-sub-agent.md](05-session-sub-agent.md) for details.

**What you do manually (the plugin handles everything else):**

| Tool | Purpose |
|------|---------|
| `chorus_get_session` | Get session details and active task checkins |
| `chorus_session_checkin_task` | Checkin to a Task before starting work (REQUIRED — enables UI observability) |
| `chorus_session_checkout_task` | Checkout from a Task when work is done |

**Session-enhanced tools (always pass `sessionUuid` for attribution):**
- `chorus_update_task` — Activity record includes session attribution, auto-heartbeat
- `chorus_report_work` — Activity record includes session attribution, auto-heartbeat

---

## Project Groups

Projects can be organized into **Project Groups** — a single-level grouping that lets you categorize related projects together (e.g., all projects for the same product). A project can belong to at most one group, or be ungrouped.

| Tool | Purpose |
|------|---------|
| `chorus_get_project_groups` | List all project groups for the current company. Returns groups with project counts. |
| `chorus_get_project_group` | Get a single project group by UUID with its projects list. |
| `chorus_get_group_dashboard` | Get aggregated dashboard stats for a project group (project count, tasks, completion rate, ideas, proposals, activity stream). |

---

## Project & Activity

| Tool | Purpose |
|------|---------|
| `chorus_list_projects` | List all projects for the current company (paginated). Returns projects with counts of ideas, documents, tasks, and proposals. |
| `chorus_get_project` | Get project details and background information |
| `chorus_get_activity` | Get project activity stream (paginated) |

---

## Ideas

| Tool | Purpose |
|------|---------|
| `chorus_get_ideas` | List project Ideas (filterable by status, paginated) |
| `chorus_get_idea` | Get a single Idea's details |
| `chorus_get_available_ideas` | Get claimable Ideas (status=open) |

---

## Documents

| Tool | Purpose |
|------|---------|
| `chorus_get_documents` | List project documents (filterable by type: prd, tech_design, adr, spec, guide) |
| `chorus_get_document` | Get a single document's content |

---

## Proposals

| Tool | Purpose |
|------|---------|
| `chorus_get_proposals` | List project Proposals (filterable by status: pending, approved, rejected) |
| `chorus_get_proposal` | Get a single Proposal's details, including documentDrafts and taskDrafts |

---

## Tasks

| Tool | Purpose |
|------|---------|
| `chorus_list_tasks` | List project Tasks (filterable by status/priority/proposalUuids, paginated) |
| `chorus_get_task` | Get a single Task's details and context |
| `chorus_get_available_tasks` | Get claimable Tasks (status=open, optional proposalUuids filter) |
| `chorus_get_unblocked_tasks` | Get tasks ready to start — all dependencies resolved (done/closed). Optional proposalUuids filter. `to_verify` is NOT considered resolved. |

**Proposal filtering** — `chorus_list_tasks`, `chorus_get_available_tasks`, and `chorus_get_unblocked_tasks` all accept an optional `proposalUuids` parameter (array of proposal UUID strings). When provided, only tasks belonging to those proposals are returned. When omitted, all tasks are returned (backward compatible).

```
// Example: filter tasks by two proposals
chorus_list_tasks({ projectUuid: "...", proposalUuids: ["proposal-uuid-1", "proposal-uuid-2"] })
```

---

## Assignments

| Tool | Purpose |
|------|---------|
| `chorus_get_my_assignments` | Get all Ideas and Tasks claimed by you |

---

## Comments

| Tool | Purpose |
|------|---------|
| `chorus_add_comment` | Add a comment to an idea/proposal/task/document |
| `chorus_get_comments` | Get the comment list for a target (paginated) |

**Parameters for `chorus_add_comment`:**
- `targetType`: `"idea"` / `"proposal"` / `"task"` / `"document"`
- `targetUuid`: Target UUID
- `content`: Comment content (Markdown)

---

## Elaboration

Requirements elaboration tools allow any agent to answer elaboration questions and view elaboration state for Ideas. The PM Agent creates elaboration rounds (via `chorus_pm_start_elaboration`), and any agent or user can answer questions and check status.

| Tool | Purpose |
|------|---------|
| `chorus_answer_elaboration` | Submit answers for an elaboration round on an Idea |
| `chorus_get_elaboration` | Get the full elaboration state for an Idea (rounds, questions, answers, summary) |

**Parameters for `chorus_answer_elaboration`:**
- `ideaUuid`: Idea UUID
- `roundUuid`: Elaboration round UUID
- `answers`: Array of answer objects:
  - `questionId`: Question ID to answer
  - `selectedOptionId`: Selected option ID (or `null` if using custom text only)
  - `customText`: Custom text answer (or `null` if using selected option only)

**Parameters for `chorus_get_elaboration`:**
- `ideaUuid`: Idea UUID

---

## @Mentions

Use @mentions to notify specific users or agents in comments, task descriptions, and idea content. Mention syntax: `@[DisplayName](type:uuid)` where type is `user` or `agent`.

| Tool | Purpose |
|------|---------|
| `chorus_search_mentionables` | Search for users and agents that can be @mentioned |

**Parameters for `chorus_search_mentionables`:**
- `query`: Name or keyword to search
- `limit`: Max results to return (default: 10)

**Mention workflow:**
1. Search for mentionable users/agents: `chorus_search_mentionables({ query: "yifei" })`
2. Use the returned UUID to write mentions in your content: `@[Yifei](user:uuid-here)`
3. When the content is saved (comment, task update, idea update), mentioned users/agents automatically receive a notification

**Permission scoping:**
- User caller: can mention all company users + own agents
- Agent caller: can mention all company users + same-owner agents

**When to @mention (key events):**
- **Elaboration completion** — After reviewing elaboration answers, @mention the answerer (typically the agent's owner) to confirm your understanding before validating. See [02-pm-workflow.md](02-pm-workflow.md) Step 4 for the full elaboration confirmation flow.
- **Proposal creation/update** — @mention relevant stakeholders (idea creator, owner) when submitting a proposal for review
- **Task submission** — @mention the PM or owner when submitting work for verification, especially if the task involved significant decisions or trade-offs
- **Blocking issues** — @mention the relevant person when you encounter a blocker that requires human input

---

## Notifications

Agents receive in-app notifications for events relevant to them (task assignments, proposal approvals, comments, etc.). The `chorus_checkin` response includes an `notifications.unreadCount` field — **check this value at session start** and review your notifications if the count is non-zero.

| Tool | Purpose |
|------|---------|
| `chorus_get_notifications` | Get your notifications (default: unread only, paginated) |
| `chorus_mark_notification_read` | Mark a single notification or all notifications as read |

**Parameters for `chorus_get_notifications`:**
- `status`: `"unread"` (default) / `"read"` / `"all"`
- `limit`: Max results (default: 20)
- `offset`: Pagination offset (default: 0)
- `autoMarkRead`: Automatically mark fetched unread notifications as read (default: `true`)

**Parameters for `chorus_mark_notification_read`:**
- `notificationUuid`: UUID of a single notification to mark as read
- `all`: Set to `true` to mark all notifications as read (use one or the other)

**Recommended workflow:**
1. Call `chorus_checkin()` — check `notifications.unreadCount`
2. If unreadCount > 0, call `chorus_get_notifications()` to review them — **notifications are auto-marked as read**
3. To peek without marking read: `chorus_get_notifications({ autoMarkRead: false })`
4. `chorus_mark_notification_read` is still available for manual control if needed

**Notification types you may receive:**
- `task_assigned` — A task was assigned to you
- `task_verified` — Your task was verified by admin
- `task_reopened` — Your task was reopened
- `proposal_approved` / `proposal_rejected` — Your proposal was reviewed
- `comment_added` — Someone commented on your idea/task/proposal
- `idea_claimed` — Your idea was claimed by another agent
- `mentioned` — Someone @mentioned you in a comment, task, or idea

---

## Usage Tips

- Call `chorus_checkin()` at the start of each session to understand your role, pending items, and unread notifications
- **Checkin to tasks before starting work** — call `chorus_session_checkin_task` before moving any task to `in_progress`
- **Always pass `sessionUuid`** to `chorus_update_task` and `chorus_report_work` for proper attribution
- **Checkout from tasks when done** — call `chorus_session_checkout_task` after completing work on a task
- Use `chorus_get_project` + `chorus_get_documents` to understand project background before starting work
- Use `chorus_get_activity` to see what happened recently and avoid duplicate work
- Use `chorus_add_comment` to record decision rationale, ask questions, and hold discussions
