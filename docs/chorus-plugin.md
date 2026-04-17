# Chorus Plugin for Claude Code

## Overview

The Chorus Plugin packages the Chorus Skill with **Hooks** for automatic session lifecycle management. Hooks guarantee execution at specific Claude Code lifecycle events, removing the dependency on Claude "remembering" to manage sessions.

### Architecture: Hook + Skill Division

```
Hooks (automatic, no intelligence needed):
  SessionStart  → chorus checkin + session discovery (inject context)
  SubagentStart → create Chorus session + write session file (SYNC)
  TeammateIdle  → session heartbeat
  SubagentStop  → auto-checkout all tasks + close Chorus session
  TaskCompleted → checkout via metadata bridge

Skill + MCP (requires LLM judgment):
  Task claiming, checkin_task, status updates, report_work, proposals
```

### Sub-agent Session Discovery (Plan A)

Sub-agents discover their Chorus session UUID without Team Lead intervention:

```
Team Lead spawns sub-agent "frontend-worker"
  │
  ├─ [Hook: SubagentStart] fires SYNCHRONOUSLY before sub-agent runs
  │   ├─ Creates Chorus session via MCP
  │   ├─ Writes .chorus/sessions/frontend-worker.json
  │   └─ Output to Team Lead: "Session UUID: xxx"
  │
  └─ Sub-agent starts
      ├─ [Hook: SessionStart] fires (if applicable)
      │   └─ Scans .chorus/sessions/ → outputs "Your session: xxx"
      │
      └─ OR: Sub-agent reads .chorus/sessions/frontend-worker.json
          (instructed by skill docs or Team Lead prompt)
```

The sub-agent gets its session UUID via **two redundant paths**:
1. **SessionStart hook** scans session files and outputs them as context
2. **File read** — the sub-agent reads `.chorus/sessions/<my-name>.json` directly

### Auto-cleanup on Sub-agent Exit (Plan D)

When a sub-agent exits, the SubagentStop hook automatically:
1. Queries the Chorus session for active task checkins
2. Checks out from every checked-in task
3. Closes the Chorus session
4. Removes the session file and state entries

This means sub-agents **never leave behind dangling checkins or open sessions**.

## Installation

### 1. Configure Environment

Set the following environment variables (e.g., in `.env` or your shell profile):

```bash
export CHORUS_URL="https://chorus.example.com"   # or http://localhost:3000
export CHORUS_API_KEY="cho_your_api_key_here"
```

### 2. Install Skill + Plugin

See the install instructions in `public/chorus-plugin/skills/chorus/SKILL.md` for skill details. The skill is bundled with the plugin and delivered automatically with plugin updates.

For **local development** within this repo, the skill is already symlinked:
```
.claude/skills/chorus → ../../public/chorus-plugin/skills/chorus
```

### 3. Load the Plugin

For external users who downloaded via the install script:
```bash
CHORUS_URL=<url> CHORUS_API_KEY=cho_xxx claude --plugin-dir .chorus-plugin
```

For local development within this repo:
```bash
CHORUS_URL=http://localhost:3000 CHORUS_API_KEY=cho_xxx claude --plugin-dir public/chorus-plugin
```

### 4. MCP Server

The plugin includes a `.mcp.json` template that configures the Chorus MCP server. It uses `$CHORUS_URL` and `$CHORUS_API_KEY` from the environment.

## File Layout

```
public/chorus-plugin/                # Plugin root
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── bin/                             # Hook scripts
│   ├── chorus-api.sh               # Shared API + state + session file helpers
│   ├── on-session-start.sh         # SessionStart: checkin + session discovery
│   ├── on-subagent-start.sh        # SubagentStart: create session + write file (SYNC)
│   ├── on-subagent-stop.sh         # SubagentStop: checkout tasks + close + cleanup
│   ├── on-teammate-idle.sh         # TeammateIdle: heartbeat
│   └── on-task-completed.sh        # TaskCompleted: checkout via metadata bridge
├── skills/chorus/                   # Skill files
│   ├── SKILL.md
│   ├── package.json
│   └── references/                  # Role-specific workflow docs
└── .mcp.json

.claude/skills/
└── chorus → ../../public/chorus-plugin/skills/chorus  (symlink, local dev)

Runtime state (gitignored):
.chorus/
├── state.json                       # Hook state: agent→session mappings
└── sessions/                        # Per-agent session files (Plan A)
    ├── frontend-worker.json
    └── backend-worker.json
```

## Hooks

### SessionStart

**Trigger:** Claude Code session starts or resumes.

**Behavior:**
1. Checks if `CHORUS_URL` and `CHORUS_API_KEY` are set
2. Calls `chorus_checkin` via MCP to verify connectivity and inject agent context
3. Outputs hook status and usage hints
4. If resuming with existing state, sends a heartbeat
5. **Session discovery (Plan A):** Scans `.chorus/sessions/` for pre-created session files and outputs them. If the current agent is a sub-agent, it can identify its own session by name.

### SubagentStart

**Trigger:** A sub-agent (teammate) is spawned via the Task tool.

**SYNCHRONOUS** — completes before the sub-agent starts executing.

**Behavior:**
1. Reads `agent_id`, `agent_name`, and `agent_type` from the event
2. Skips non-worker types (Explore, Plan, haiku, etc.)
3. Creates a Chorus session via MCP (`chorus_create_session`)
4. Stores mappings in `state.json` (by agent_id and agent_name)
5. **Writes session file** to `.chorus/sessions/<agent_name>.json` with full session info
6. Outputs session UUID and file path to Team Lead's context

### SubagentStop

**Trigger:** A sub-agent exits.

**Behavior:**
1. Reads `agent_id` and `agent_name` from the event
2. Looks up the session UUID from state
3. **Auto-checkout (Plan D):** Queries `chorus_get_session` for active task checkins, then calls `chorus_session_checkout_task` for each
4. Closes the Chorus session via MCP
5. Cleans up state entries and session file

### TeammateIdle

**Trigger:** A teammate goes idle (between turns).

**Behavior:**
1. Reads `agent_id` or `teammate_name` from the event
2. Looks up the session UUID from state (by agent_id or name)
3. Sends a heartbeat via `chorus_session_heartbeat`

This prevents Chorus sessions from being marked inactive during long-running agent team operations.

### TaskCompleted

**Trigger:** A Claude Code task is marked completed.

**Behavior:**
1. Reads task info from the event
2. Searches for `chorus:task:<uuid>` pattern in the task description/subject
3. If found, checks out the corresponding session from that Chorus task

## State File

The plugin stores session mapping state in `$CLAUDE_PROJECT_DIR/.chorus/state.json`. This file is automatically created and should be gitignored.

**Format:**
```json
{
  "main_session_uuid": "abc-123-...",
  "session_<agent_id>": "<chorus-session-uuid>",
  "session_<agent_name>": "<chorus-session-uuid>",
  "agent_for_session_<session-uuid>": "<agent-id>"
}
```

## Session Files (Plan A)

Per-agent session files live in `$CLAUDE_PROJECT_DIR/.chorus/sessions/<agent_name>.json`:

```json
{
  "sessionUuid": "abc-123-def-456",
  "agentId": "agent_abc123",
  "agentName": "frontend-worker",
  "agentType": "general-purpose",
  "chorusUrl": "http://localhost:3000",
  "createdAt": "2026-02-16T01:00:00Z"
}
```

These files are:
- **Created** by SubagentStart hook (synchronously, before sub-agent runs)
- **Read** by SessionStart hook (output as context) and by sub-agents directly
- **Deleted** by SubagentStop hook (cleanup on exit)

## Metadata Bridge

To link a Claude Code task with a Chorus task, include the pattern `chorus:task:<uuid>` in the Claude Code task description. For example:

```
TaskCreate:
  subject: "Implement login API"
  description: "Build the /api/login endpoint. chorus:task:a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

When the Claude Code task is completed, the `TaskCompleted` hook will automatically check out from the linked Chorus task.

## chorus-api.sh Commands

| Command | Description |
|---------|-------------|
| `checkin` | Check connectivity with Chorus backend |
| `mcp-tool <name> [args_json]` | Call any MCP tool via JSON-RPC |
| `state-get <key>` | Read a value from state.json |
| `state-set <key> <value>` | Write a value to state.json |
| `state-delete <key>` | Delete a key from state.json |
| `session-read <name>` | Read a session file for a named agent |
| `session-list` | List all pre-created session files as JSON |

## What Hooks Automate vs. What LLM Still Does

| Operation | Who | How |
|-----------|-----|-----|
| Create Chorus session | **Hook** (SubagentStart) | Automatic, sync |
| Session heartbeat | **Hook** (TeammateIdle) | Automatic, async |
| Close Chorus session | **Hook** (SubagentStop) | Automatic, async |
| Checkout all tasks on exit | **Hook** (SubagentStop) | Automatic, async |
| Checkout on CC task done | **Hook** (TaskCompleted) | Automatic, needs `chorus:task:<uuid>` |
| Discover session UUID | **Hook** (SessionStart) + **file** | Automatic via session files |
| Checkin to a task | **LLM** | `chorus_session_checkin_task` |
| Move task status | **LLM** | `chorus_update_task` |
| Report work | **LLM** | `chorus_report_work` (needs LLM to summarize) |
| Submit for verify | **LLM** | `chorus_submit_for_verify` (needs judgment) |
| Claim/release tasks | **LLM** | `chorus_claim_task` / `chorus_release_task` |

## Prerequisites

- `curl` — for REST API calls
- `jq` — for JSON parsing (recommended; basic fallback available without it)
- `CHORUS_URL` and `CHORUS_API_KEY` environment variables

## Troubleshooting

### Hook not firing

1. Verify the plugin is loaded: `claude --plugin-dir public/chorus-plugin` (or `.chorus-plugin` for external installs)
2. Check that `hooks.json` is valid JSON
3. Ensure hook scripts are executable (`chmod +x bin/*.sh`)

### "CHORUS_URL is not set"

Set the environment variables before starting Claude Code:
```bash
export CHORUS_URL="http://localhost:3000"
export CHORUS_API_KEY="cho_your_key"
```

### Session not created for sub-agent

The hook skips read-only agent types (Explore, Plan, haiku). Only worker agents (general-purpose, Bash) get Chorus sessions.

### Sub-agent can't find its session

1. Check that `.chorus/sessions/<agent-name>.json` exists
2. Verify SubagentStart hook ran (check Team Lead's context for "Chorus session auto-created" message)
3. Ensure the sub-agent name matches the filename

### State file not updating

Check that `$CLAUDE_PROJECT_DIR` is set and writable. The state file is at `$CLAUDE_PROJECT_DIR/.chorus/state.json`.

### Heartbeat failures

If heartbeats fail silently, check:
1. Network connectivity to Chorus
2. API key validity (keys expire if rotated)
3. Session may have been manually closed
