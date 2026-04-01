#!/usr/bin/env bash
# on-session-start.sh — SessionStart hook
# Triggered on Claude Code session startup/resume.
# Calls chorus_checkin via MCP to inject agent context.
# Also scans for existing session files (metadata for hook state lookup).
#
# Output: JSON with systemMessage (user) + additionalContext (Claude)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Read event JSON from stdin (if available)
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# Resolve config: env var > userConfig (CLAUDE_PLUGIN_OPTION_*)
CHORUS_URL="${CHORUS_URL:-${CLAUDE_PLUGIN_OPTION_CHORUS_URL:-}}"
CHORUS_API_KEY="${CHORUS_API_KEY:-${CLAUDE_PLUGIN_OPTION_CHORUS_API_KEY:-}}"

# Check if Chorus environment is configured
if [ -z "$CHORUS_URL" ] || [ -z "$CHORUS_API_KEY" ]; then
  "$API" hook-output \
    "Chorus plugin: not configured. Run /plugin to set up, or export CHORUS_URL and CHORUS_API_KEY." \
    "Chorus not configured. Run /plugin to configure Chorus, or set CHORUS_URL and CHORUS_API_KEY env vars." \
    "SessionStart"
  exit 0
fi

# Call chorus_checkin via MCP
CHECKIN_RESULT=$("$API" mcp-tool "chorus_checkin" '{}' 2>/dev/null) || {
  "$API" hook-output \
    "Chorus plugin: connection failed (${CHORUS_URL})" \
    "WARNING: Unable to reach Chorus at ${CHORUS_URL}. Session lifecycle hooks will not function." \
    "SessionStart"
  exit 0
}

# Store owner info from checkin for SubagentStart hook to inject into sub-agent context
if command -v jq >/dev/null 2>&1; then
  _OWNER_NAME=$(echo "$CHECKIN_RESULT" | jq -r '.agent.owner.name // empty' 2>/dev/null) || true
  _OWNER_EMAIL=$(echo "$CHECKIN_RESULT" | jq -r '.agent.owner.email // empty' 2>/dev/null) || true
  _OWNER_UUID=$(echo "$CHECKIN_RESULT" | jq -r '.agent.owner.uuid // empty' 2>/dev/null) || true
  if [ -n "$_OWNER_UUID" ]; then
    "$API" state-set "owner_name" "$_OWNER_NAME"
    "$API" state-set "owner_email" "$_OWNER_EMAIL"
    "$API" state-set "owner_uuid" "$_OWNER_UUID"
  fi

  # Cache agent roles for TaskCompleted and Stop hooks (e.g. "developer_agent,pm_agent,admin_agent")
  _ROLES=$(echo "$CHECKIN_RESULT" | jq -r '.agent.roles | join(",") // empty' 2>/dev/null) || true
  if [ -n "$_ROLES" ]; then
    "$API" state-set "agent_roles" "$_ROLES"
  fi

  # Cache first assignment's projectUuid for Stop hook (to scope to_verify task lookup)
  _PROJECT_UUID=$(echo "$CHECKIN_RESULT" | jq -r '
    (.assignments.tasks[0].project.uuid // .assignments.ideas[0].project.uuid) // empty
  ' 2>/dev/null) || true
  if [ -n "$_PROJECT_UUID" ]; then
    "$API" state-set "project_uuid" "$_PROJECT_UUID"
  fi
fi

# Build context for Claude (additionalContext)
CONTEXT="# Chorus Plugin — Active

Chorus is connected at ${CHORUS_URL}.
Session lifecycle hooks are enabled: SubagentStart, SubagentStop, TeammateIdle, TaskCompleted.

## Checkin Result

${CHECKIN_RESULT}

## Session Management — IMPORTANT

The Chorus Plugin **fully automates** Chorus session lifecycle:
- Sub-agent spawn → Chorus session auto-created (or reused) + session UUID and workflow auto-injected into sub-agent context
- Teammate idle → Chorus session heartbeat (automatic)
- Sub-agent stop → auto checkout all tasks + Chorus session closed

**Do NOT call chorus_create_session or chorus_close_session for sub-agents.** The plugin handles this.
When spawning sub-agents, just pass Chorus TASK UUIDs in the prompt. Session UUID + workflow are auto-injected by SubagentStart hook.

For your own session (if you are a Developer agent working directly, not via sub-agents):
call chorus_list_sessions() first, then reopen or create as needed.

To link a Claude Code task to a Chorus task, include \`chorus:task:<uuid>\` in the task description.

## Notifications

When you or your sub-agents receive @mentions or other notifications:
- \`chorus_get_notifications()\` — fetches unread notifications and **auto-marks them as read**
- \`chorus_get_notifications({ autoMarkRead: false })\` — peek without marking read
- No need to call \`chorus_mark_notification_read\` separately after reading

## Project Groups

Projects are organized into Project Groups. Before creating a new project, call \`chorus_get_project_groups()\` to see existing groups and pass the \`groupUuid\` to \`chorus_admin_create_project()\` to assign the project to the correct group. Creating a project without specifying a group puts it in Ungrouped."

# Check for existing state (resumed session)
MAIN_SESSION=$("$API" state-get "main_session_uuid" 2>/dev/null) || true
if [ -n "$MAIN_SESSION" ]; then
  CONTEXT="${CONTEXT}

Resuming with existing Chorus session: ${MAIN_SESSION}"
  "$API" mcp-tool "chorus_session_heartbeat" "$(printf '{"sessionUuid":"%s"}' "$MAIN_SESSION")" >/dev/null 2>&1 || true
fi

# Plan A: Session discovery for sub-agents
SESSIONS_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus/sessions"
if [ -d "$SESSIONS_DIR" ]; then
  SESSION_FILES=$(ls "$SESSIONS_DIR"/*.json 2>/dev/null) || true
  if [ -n "$SESSION_FILES" ]; then
    SESSION_LIST="

## Pre-assigned Chorus Sessions

The following Chorus sessions were auto-created by the plugin for sub-agents.
If you are a sub-agent, find your session by matching your agent name:
"
    for f in $SESSION_FILES; do
      BASENAME=$(basename "$f" .json)
      if command -v jq &>/dev/null; then
        S_UUID=$(jq -r '.sessionUuid // empty' "$f" 2>/dev/null) || true
        S_NAME=$(jq -r '.agentName // empty' "$f" 2>/dev/null) || true
      else
        S_UUID=$(grep -o '"sessionUuid":"[^"]*"' "$f" 2>/dev/null | cut -d'"' -f4) || true
        S_NAME="$BASENAME"
      fi
      if [ -n "$S_UUID" ]; then
        SESSION_LIST="${SESSION_LIST}
- **${S_NAME:-$BASENAME}**: sessionUuid = \`${S_UUID}\`"
      fi
    done
    SESSION_LIST="${SESSION_LIST}

Use your session UUID with \`chorus_session_checkin_task\`, \`chorus_report_work\`, etc."
    CONTEXT="${CONTEXT}${SESSION_LIST}"
  fi
fi

# Build user-visible message
USER_MSG="Chorus connected at ${CHORUS_URL}"
if [ -n "$MAIN_SESSION" ]; then
  USER_MSG="${USER_MSG} (resumed session)"
fi

"$API" hook-output "$USER_MSG" "$CONTEXT" "SessionStart"
