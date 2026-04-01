#!/usr/bin/env bash
# on-task-completed.sh — TaskCompleted hook
# Triggered when a Claude Code task is marked completed.
# Checks for a Chorus task UUID in the task metadata/description (chorus:task:<uuid>).
# If found, checks out the session from that task via MCP.
#
# Output: JSON with systemMessage (user) when a checkout happens

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Resolve config: env var > userConfig (CLAUDE_PLUGIN_OPTION_*)
CHORUS_URL="${CHORUS_URL:-${CLAUDE_PLUGIN_OPTION_CHORUS_URL:-}}"
CHORUS_API_KEY="${CHORUS_API_KEY:-${CLAUDE_PLUGIN_OPTION_CHORUS_API_KEY:-}}"

# Check environment
if [ -z "$CHORUS_URL" ] || [ -z "$CHORUS_API_KEY" ]; then
  exit 0
fi

# Read event JSON from stdin
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract task info
TASK_DESCRIPTION=$(echo "$EVENT" | jq -r '.task_description // .taskDescription // .description // empty' 2>/dev/null) || true
TASK_SUBJECT=$(echo "$EVENT" | jq -r '.task_subject // .taskSubject // .subject // empty' 2>/dev/null) || true
AGENT_ID=$(echo "$EVENT" | jq -r '.agent_id // .agentId // empty' 2>/dev/null) || true

# Look for chorus:task:<uuid> pattern in description or subject
CHORUS_TASK_UUID=""

for text in "$TASK_DESCRIPTION" "$TASK_SUBJECT"; do
  if [ -n "$text" ]; then
    MATCH=$(echo "$text" | grep -oP 'chorus:task:([0-9a-f-]{36})' | head -1 | sed 's/chorus:task://') || true
    if [ -n "$MATCH" ]; then
      CHORUS_TASK_UUID="$MATCH"
      break
    fi
  fi
done

if [ -z "$CHORUS_TASK_UUID" ]; then
  # No Chorus task linked — silent exit
  exit 0
fi

# Find the session for this agent
SESSION_UUID=""

if [ -n "$AGENT_ID" ]; then
  SESSION_UUID=$("$API" state-get "session_${AGENT_ID}" 2>/dev/null) || true
fi

if [ -n "$SESSION_UUID" ] && [ -n "$CHORUS_TASK_UUID" ]; then
  # Checkout from the Chorus task via MCP
  "$API" mcp-tool "chorus_session_checkout_task" \
    "$(printf '{"sessionUuid":"%s","taskUuid":"%s"}' "$SESSION_UUID" "$CHORUS_TASK_UUID")" \
    >/dev/null 2>&1 || {
    "$API" hook-output \
      "Chorus: failed to checkout from task ${CHORUS_TASK_UUID:0:8}..." \
      "WARNING: Failed to checkout from Chorus task ${CHORUS_TASK_UUID}." \
      "TaskCompleted"
    exit 0
  }

  "$API" hook-output \
    "Chorus: checked out from task ${CHORUS_TASK_UUID:0:8}..." \
    "Auto-checked out from Chorus task ${CHORUS_TASK_UUID} (via metadata bridge chorus:task:<uuid>)." \
    "TaskCompleted"
else
  # No session found — can't checkout
  exit 0
fi
