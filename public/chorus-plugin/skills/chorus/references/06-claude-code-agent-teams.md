# Claude Code Agent Teams + Chorus Integration

## Overview

This guide explains how to run **Claude Code Agent Teams** (swarm mode) with Chorus for full work observability. In this setup, a Team Lead agent orchestrates multiple sub-agents, each working on Chorus tasks in parallel, with every action tracked through Chorus Sessions.

The Chorus Plugin **fully automates** session lifecycle — sessions are created/reused on sub-agent spawn, heartbeats sent on idle, and sessions closed on sub-agent exit. The Team Lead focuses on work assignment, not session management.

### Two-Layer Architecture

Claude Code Agent Teams and Chorus serve different purposes:

| Layer | System | Purpose |
|-------|--------|---------|
| **Orchestration** | Claude Code Agent Teams | Spawning sub-agents, internal task dispatch, inter-agent messaging |
| **Work Tracking** | Chorus | Task lifecycle (claim → in_progress → to_verify → done), session observability, activity stream |

```
┌─────────────────────────────────────────────────────────┐
│ Claude Code Agent Teams (Orchestration)                 │
│                                                         │
│  Team Lead ──spawn──> Sub-Agent A ──spawn──> Sub-Agent B│
│     │                    │                      │       │
│  TeamCreate           Task tool              Task tool  │
│  TaskCreate           SendMessage            SendMessage│
│  TaskList/Update                                        │
└───────┬──────────────────┬──────────────────────┬───────┘
        │                  │                      │
        ▼                  ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│ Chorus (Work Tracking & Observability)                  │
│                                                         │
│  Session: "lead"    Session: "fe-worker"  Session: "be" │
│    │                  │                     │           │
│    │                  ├─ checkin → Task A    ├─ checkin  │
│    │                  ├─ update_task         │  → Task B │
│    │                  ├─ report_work         ├─ update   │
│    │                  └─ submit_for_verify   └─ report   │
│                                                         │
│  UI: Kanban badges, Task Detail workers, Activity stream│
└─────────────────────────────────────────────────────────┘
```

### Key Principle: One Session Per Worker

Every agent that works on Chorus tasks **must have its own separate Chorus Session**. This is a hard requirement — the UI relies on session checkins to show which worker is active on which task.

---

## MCP Access for Sub-Agents

Sub-agents spawned via Claude Code's `Task` tool can access Chorus MCP tools **if the MCP server is configured at the project level** (in `.claude/settings.json` or `.mcp.json`). This is the recommended setup.

If MCP is configured at the user level (`~/.claude/settings.json`), sub-agents may not have access. In that case, move the Chorus MCP config to the project level:

```json
// .mcp.json (project root)
{
  "mcpServers": {
    "chorus": {
      "type": "streamable-http",
      "url": "<BASE_URL>/api/mcp",
      "headers": {
        "Authorization": "Bearer cho_xxxxxxxxxxxx"
      }
    }
  }
}
```

---

## Complete Workflow

Session lifecycle is fully automated by the Chorus Plugin. The Team Lead should focus on work assignment, not session management.

### Phase 1: Team Lead — Plan & Prepare

```
# 1. Check in to Chorus
chorus_checkin()

# 2. Understand the project and available tasks
chorus_get_project({ projectUuid: "<project-uuid>" })
chorus_list_tasks({ projectUuid: "<project-uuid>", status: "assigned" })

# 3. Read task details to plan work distribution
chorus_get_task({ taskUuid: "<task-A-uuid>" })
chorus_get_task({ taskUuid: "<task-B-uuid>" })

# The main agent (Team Lead) does NOT need a session.
# Sessions are only for sub-agents — the plugin auto-creates them when sub-agents spawn.
```

### Phase 2: Team Lead — Create Claude Code Team & Spawn Sub-Agents

The plugin auto-injects session UUID and workflow instructions directly into each sub-agent's context via the SubagentStart hook. The Team Lead only needs to pass the Chorus task UUID(s) — no session files, no workflow boilerplate.

```python
# 1. Create a Claude Code team
TeamCreate({ team_name: "feature-x", description: "Implementing feature X" })

# 2. Create internal tasks for tracking
TaskCreate({ subject: "Frontend: build user form", description: "chorus:task:<task-A-uuid>" })
TaskCreate({ subject: "Backend: create API endpoints", description: "chorus:task:<task-B-uuid>" })

# 3. Spawn sub-agents — just pass task UUIDs, plugin injects session workflow automatically
Task({
  subagent_type: "general-purpose",
  team_name: "feature-x",
  name: "frontend-worker",
  prompt: """
    Your Chorus task UUID: task-A-uuid
    Project UUID: project-uuid

    Implement the frontend user form component...
  """
})

Task({
  subagent_type: "general-purpose",
  team_name: "feature-x",
  name: "backend-worker",
  prompt: """
    Your Chorus task UUID: task-B-uuid
    Project UUID: project-uuid

    Implement the backend API endpoints...
  """
})
```

**What the Team Lead prompt needs:**
- **Task UUID(s)** — which Chorus tasks this sub-agent should work on
- **NO session UUID, NO workflow boilerplate** — the plugin auto-injects everything via SubagentStart hook

### Phase 3: Sub-Agent — Execute Work

The plugin injects the session UUID and workflow instructions directly into the sub-agent's context via the SubagentStart hook. The sub-agent sees these as additional context when it starts.

```
# === Session Auto-Injected by Plugin (sub-agent sees this automatically) ===
# Session UUID, workflow steps, and MCP call examples are injected into context.
# No file reading needed.

# === Chorus Setup (FIRST, before any coding) ===

# 2. Checkin to task — makes you visible in the UI
chorus_session_checkin_task({
  sessionUuid: "<my-session-uuid>",
  taskUuid: "<my-task-uuid>"
})

# 3. Move task to in_progress
chorus_update_task({
  taskUuid: "<my-task-uuid>",
  status: "in_progress",
  sessionUuid: "<my-session-uuid>"
})

# === Do the actual work (coding, testing, etc.) ===
# ...write code, run tests, create commits...

# === Progress reporting (periodically during work) ===

# 4. Report progress (auto-heartbeats the session)
chorus_report_work({
  taskUuid: "<my-task-uuid>",
  report: "Completed user form component.\n- Files: src/components/UserForm.tsx\n- Commit: abc123",
  sessionUuid: "<my-session-uuid>"
})

# === Completion ===

# 5. Checkout from task
chorus_session_checkout_task({
  sessionUuid: "<my-session-uuid>",
  taskUuid: "<my-task-uuid>"
})

# 6. Submit for verification
chorus_submit_for_verify({
  taskUuid: "<my-task-uuid>",
  summary: "Implemented user form with validation.\nFiles: ...\nAll tests passing."
})

# 7. Notify team lead via Claude Code messaging
SendMessage({ type: "message", recipient: "team-lead", content: "Task complete", summary: "Frontend task done" })

# DO NOT close your session — the plugin closes it automatically when you exit.
```

### Phase 4: Team Lead — Verify, Unblock & Close

The Team Lead monitors until all Chorus tasks reach `to_verify` or `done`. Sessions are auto-closed by the plugin when sub-agents exit.

> **Critical: If the Team Lead has admin role, it MUST verify tasks between waves.** Sub-agents submit tasks to `to_verify`, but `to_verify` does NOT resolve dependencies — only `done` or `closed` does. Without verification, downstream tasks will be permanently blocked.

```
# 1. Check which tasks are ready for verification
chorus_list_tasks({ projectUuid: "<project-uuid>", status: "to_verify" })

# 2. Verify each completed task (moves to_verify → done, unblocks dependents)
chorus_admin_verify_task({ taskUuid: "<task-A-uuid>" })
chorus_admin_verify_task({ taskUuid: "<task-B-uuid>" })

# 3. Check what's now unblocked for the next wave
chorus_get_unblocked_tasks({ projectUuid: "<project-uuid>" })

# 4. Spawn next wave of sub-agents for newly unblocked tasks
# ... (repeat Phase 2-4 until all tasks done)

# 5. Sessions are closed automatically by the plugin (SubagentStop hook).

# 6. Clean up Claude Code team
# Send shutdown requests to sub-agents, then TeamDelete
```

If the Team Lead does NOT have admin role, it should notify the human admin to verify tasks so downstream work can proceed.

---

## Handling Task Dependencies (DAG)

When Chorus tasks have dependencies (Task B depends on Task A), the Team Lead must coordinate the execution order.

> **Server-side enforcement**: `chorus_update_task(status: "in_progress")` will automatically reject if any `dependsOn` task is not `done` or `closed`. The error includes detailed blocker info (title, status, assignee, active session). Sub-agents do NOT need to manually poll dependency status — the server enforces it.

**Recommended: Wave-based sequential spawning with verification**

> **Key rule**: `to_verify` does NOT count as resolved. Only `done` or `closed` resolves a dependency. The Team Lead must verify tasks between waves to unblock the next wave.

1. Use `chorus_get_unblocked_tasks` to find tasks ready to start (all deps resolved)
2. Spawn sub-agents only for unblocked tasks (Wave 1)
3. Wait for Wave 1 tasks to reach `to_verify`
4. **Verify each task**: `chorus_admin_verify_task()` → moves to `done` (requires admin role)
5. Check `chorus_get_unblocked_tasks()` for newly unblocked tasks (Wave 2)
6. Spawn Wave 2 sub-agents
7. Repeat until all tasks are done

**Alternative: Spawn all, server rejects blocked ones**
- Spawn all sub-agents immediately
- Sub-agents that try to move blocked tasks to `in_progress` will receive a clear error with blocker details
- Those sub-agents can then use `chorus_get_unblocked_tasks` to find other work, or wait and retry
- **Note**: Even in this mode, the Team Lead must still verify completed tasks to unblock dependents

---

## Multiple Tasks Per Sub-Agent

A single sub-agent can work on multiple Chorus tasks sequentially. The Team Lead passes multiple task UUIDs, and the sub-agent processes them in order:

```python
Task({
  name: "full-stack-worker",
  prompt: """
    Your Chorus tasks (work in order):
    1. task-schema-uuid — Create database schema
    2. task-api-uuid — Implement API endpoints (depends on #1)
    3. task-tests-uuid — Write integration tests (depends on #2)

    For EACH task, follow the Chorus workflow steps (auto-injected by plugin):
    checkin → in_progress → work → report → checkout → submit_for_verify
  """
})
```

The sub-agent checks in/out of each task as it progresses, making each transition visible in the UI.

---

## Session Reuse Across Multiple Runs

If the Team Lead spawns sub-agents multiple times (e.g., after a task is reopened by Admin), the plugin handles reuse automatically — if a session named "frontend-worker" already exists, the plugin reuses (if active) or reopens (if closed) it instead of creating a new one.

This keeps session history clean and makes it easier to trace work across multiple runs in the UI.

---

## Troubleshooting

### Sub-agent can't access Chorus MCP tools
- Verify MCP is configured at project level (`.mcp.json` or `.claude/settings.json`), not just user level
- Verify the API key in the MCP config has `developer_agent` role

### UI doesn't show active workers on a task
- The sub-agent likely forgot to call `chorus_session_checkin_task`
- Check: `chorus_get_session({ sessionUuid })` to see active checkins
- Manual fix: call `chorus_session_checkin_task` for the sub-agent's session

### Session shows as "inactive" (yellow dot)
- The sub-agent hasn't sent a heartbeat in over 1 hour
- The TeammateIdle hook sends heartbeats automatically — if still inactive, the agent may have crashed

### Task stuck in wrong status
- If a sub-agent crashed before completing, the task may be stuck in `in_progress`
- Team Lead can: spawn a new sub-agent with the same name (plugin auto-reopens the session), or use `chorus_update_task` to reset status

### Duplicate sessions created
- This happens if someone manually calls `chorus_create_session` while the plugin also creates sessions
- **Fix**: Never call `chorus_create_session` — the plugin handles all session creation automatically
- If duplicates already exist, an Admin can close extras via the Settings page

### Sub-agent didn't receive session instructions
- The SubagentStart hook auto-injects session UUID and workflow into the sub-agent's context
- If missing, check that the plugin is loaded (`/plugin list`) and `CHORUS_URL` is set
- Ensure the `name` parameter is set when spawning (e.g., `name: "frontend-worker"`)

---

## Quick Reference

| Step | Who | Claude Code Tool | Chorus Tool |
|------|-----|-----------------|-------------|
| Plan work | Team Lead | — | `chorus_checkin`, `chorus_list_tasks` |
| Create team | Team Lead | `TeamCreate` | — |
| Spawn workers | Team Lead | `Task` (pass task UUIDs only) | — |
| *(auto)* Create sessions + inject workflow | Plugin (SubagentStart) | — | *(automatic)* |
| *(auto)* Receive session + workflow | Sub-Agent | (injected into context) | — |
| Checkin to task | Sub-Agent | — | `chorus_session_checkin_task` |
| Start work | Sub-Agent | — | `chorus_update_task(in_progress, sessionUuid)` |
| Report progress | Sub-Agent | — | `chorus_report_work(sessionUuid)` |
| Complete task | Sub-Agent | — | `chorus_session_checkout_task` + `chorus_submit_for_verify` |
| Notify lead | Sub-Agent | `SendMessage` | — |
| *(auto)* Heartbeat | Plugin | — | `chorus_session_heartbeat` |
| Monitor | Team Lead | `TaskList` | `chorus_list_tasks` |
| *(auto)* Close sessions | Plugin | — | *(automatic)* |
| Shutdown | Team Lead | `SendMessage(shutdown_request)` + `TeamDelete` | — |
