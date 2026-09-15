#!/usr/bin/env bash
# on-subagent-start.sh — SubagentStart hook
# Triggered SYNCHRONOUSLY when a sub-agent (teammate) is spawned.
#
# Name resolution: the session name is the event's own agent_type (the value the
# spawning Task call passed as subagent_type), falling back to worker-<agentId8>.
#
# Spawn gate: claims a per-spawn pending file written by PreToolUse:Task using
# atomic mv (only one process can successfully mv a given file). The file only
# proves the spawn was a real Task call — it never carries the name.
#
# Session reuse logic:
#   1. List existing sessions via MCP
#   2. If a session with the same name exists and is active → reuse
#   3. If it exists but is closed → reopen
#   4. If not found → create new
#
# Writes minimal session metadata file for other hooks (TeammateIdle, SubagentStop).
# Injects session UUID + workflow directly into sub-agent context via additionalContext.
# Output: JSON with systemMessage (user) + additionalContext (sub-agent)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Check environment
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
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

# Export the CC session id (same for every hook in this session) so state and
# the pending/claimed/sessions dirs resolve to this session's global partition.
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID

# Resolve the global per-session state dir once (fail-soft to the old layout).
# shellcheck source=chorus-paths.sh
[ -f "${SCRIPT_DIR}/chorus-paths.sh" ] && { . "${SCRIPT_DIR}/chorus-paths.sh" 2>/dev/null || true; }
CHORUS_STATE_DIR="${CHORUS_STATE_DIR:-${CLAUDE_PROJECT_DIR:-.}/.chorus}"

# Extract agent info from event.
# agent_type is the same value the spawning Task call passed as subagent_type,
# so it is the session name source (see SESSION_NAME below).
AGENT_ID=$(echo "$EVENT" | jq -r '.agent_id // .agentId // empty' 2>/dev/null) || true
AGENT_TYPE=$(echo "$EVENT" | jq -r '.agent_type // .agentType // empty' 2>/dev/null) || true

# Skip non-worker agent types (read-only agents don't need sessions).
# This list MUST stay identical to the skip list in on-pre-spawn-agent.sh.
case "$(printf '%s' "$AGENT_TYPE" | tr '[:upper:]' '[:lower:]')" in
  explore|plan|haiku|claude-code-guide|statusline-setup|chorus:proposal-reviewer|chorus:task-reviewer)
    exit 0
    ;;
esac

if [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Claim a pending file written by PreToolUse:Task (on-pre-spawn-agent.sh).
# Each pending file represents one expected sub-agent spawn.
#
# The pending file is a SPAWN GATE, not a name channel: it only proves this
# SubagentStart corresponds to a real Task spawn. Neither its filename nor its
# contents influence the session name, so plain FIFO claiming is safe even when a
# mixed parallel batch pairs this agent with another spawn's file.
#
# Claim strategy: FIFO by modification time, atomic mv (only one process can
# succeed per file). If no pending file can be claimed, this is one of Claude
# Code's internal/cleanup agents (they bypass PreToolUse:Task) → skip.
PENDING_DIR="${CHORUS_STATE_DIR}/pending"
CLAIMED_DIR="${CHORUS_STATE_DIR}/claimed"
mkdir -p "$CLAIMED_DIR" 2>/dev/null || true

CLAIMED_FILE=""

if [ -d "$PENDING_DIR" ]; then
  for candidate in $(ls -tr "$PENDING_DIR" 2>/dev/null); do
    if mv "${PENDING_DIR}/${candidate}" "${CLAIMED_DIR}/${AGENT_ID}" 2>/dev/null; then
      CLAIMED_FILE="${CLAIMED_DIR}/${AGENT_ID}"
      break
    fi
    # mv failed → another process claimed it first, try next
  done
fi

# No pending file claimed → internal/cleanup agent → skip session creation
if [ -z "$CLAIMED_FILE" ]; then
  exit 0
fi

# Session name comes from this event's own agent_type (the same value the Task
# call passed as subagent_type). Falls back to an agent-id-derived name only when
# agent_type is empty — never a placeholder like "unknown-<digits>".
SESSION_NAME="${AGENT_TYPE:-worker-${AGENT_ID:0:8}}"

# Sanitized form for on-disk filenames only. Namespaced types such as
# chorus:code-reviewer are not skipped, so they reach this path and must not put
# a ":" or "/" into a path. The name sent to Chorus, the state keys and the
# injected workflow text all keep the raw agent_type.
SESSION_NAME_FILE=$(printf '%s' "$SESSION_NAME" | tr -c '[:alnum:]._-' '_')
[ -z "$SESSION_NAME_FILE" ] && SESSION_NAME_FILE="worker-${AGENT_ID:0:8}"

# === Session reuse: list existing sessions, find by name ===
SESSION_UUID=""
SESSION_ACTION=""  # "reused" | "reopened" | "created"

SESSIONS_LIST=$("$API" mcp-tool "chorus_list_sessions" '{}' 2>/dev/null) || true

if [ -n "$SESSIONS_LIST" ]; then
  # Find a session with matching name
  # The list may be an array or an object with a sessions array
  MATCH=$(echo "$SESSIONS_LIST" | jq -r --arg name "$SESSION_NAME" '
    (if type == "array" then . else (.sessions // []) end)
    | map(select(.name == $name))
    | sort_by(.updatedAt // .createdAt)
    | last
    // empty
  ' 2>/dev/null) || true

  if [ -n "$MATCH" ] && [ "$MATCH" != "null" ]; then
    MATCH_UUID=$(echo "$MATCH" | jq -r '.uuid // empty' 2>/dev/null) || true
    MATCH_STATUS=$(echo "$MATCH" | jq -r '.status // empty' 2>/dev/null) || true

    if [ -n "$MATCH_UUID" ]; then
      if [ "$MATCH_STATUS" = "active" ]; then
        # Active session found — reuse directly
        SESSION_UUID="$MATCH_UUID"
        SESSION_ACTION="reused"
        # Send heartbeat to refresh lastActiveAt
        "$API" mcp-tool "chorus_session_heartbeat" \
          "$(printf '{"sessionUuid":"%s"}' "$SESSION_UUID")" >/dev/null 2>&1 || true
      elif [ "$MATCH_STATUS" = "closed" ] || [ "$MATCH_STATUS" = "inactive" ]; then
        # Closed/inactive session — reopen
        REOPEN_RESPONSE=$("$API" mcp-tool "chorus_reopen_session" \
          "$(printf '{"sessionUuid":"%s"}' "$MATCH_UUID")" 2>/dev/null) || true
        REOPEN_UUID=$(echo "$REOPEN_RESPONSE" | jq -r '.uuid // empty' 2>/dev/null) || true
        if [ -n "$REOPEN_UUID" ]; then
          SESSION_UUID="$REOPEN_UUID"
          SESSION_ACTION="reopened"
        fi
      fi
    fi
  fi
fi

# === No existing session found — create new ===
if [ -z "$SESSION_UUID" ]; then
  RESPONSE=$("$API" mcp-tool "chorus_create_session" \
    "$(printf '{"name":"%s","description":"Auto-created by Chorus plugin for sub-agent %s (type: %s)"}' \
      "$SESSION_NAME" "$AGENT_ID" "${AGENT_TYPE:-unknown}")" 2>/dev/null) || {
    "$API" hook-output \
      "Chorus: failed to create session for '${SESSION_NAME}'" \
      "WARNING: Failed to create Chorus session for sub-agent '${SESSION_NAME}'. Session lifecycle will not be tracked." \
      "SubagentStart"
    exit 0
  }

  SESSION_UUID=$(echo "$RESPONSE" | jq -r '.uuid // empty' 2>/dev/null) || true

  if [ -z "$SESSION_UUID" ]; then
    SESSION_UUID=$(echo "$RESPONSE" | grep -oP '"uuid"\s*:\s*"([0-9a-f-]{36})"' | head -1 | grep -oP '[0-9a-f-]{36}') || true
  fi

  if [ -z "$SESSION_UUID" ]; then
    "$API" hook-output \
      "Chorus: session for '${SESSION_NAME}' — UUID not found in response" \
      "WARNING: Could not extract session UUID from response for sub-agent '${SESSION_NAME}'." \
      "SubagentStart"
    exit 0
  fi

  SESSION_ACTION="created"
fi

# === State: store mapping for other hooks (TeammateIdle, SubagentStop) ===
"$API" state-set "session_${AGENT_ID}" "$SESSION_UUID"
"$API" state-set "agent_for_session_${SESSION_UUID}" "$AGENT_ID"
"$API" state-set "session_${SESSION_NAME}" "$SESSION_UUID"
"$API" state-set "name_for_agent_${AGENT_ID}" "$SESSION_NAME"

# === Holder refcount: register this agent as a holder of the session NAME ===
# Because the name is the repeating agent_type, two parallel sub-agents of the
# same type converge on ONE session (reuse-by-name above). on-subagent-stop.sh
# removes its own entry here and only tears the shared session down when no other
# holder remains — otherwise the first sibling to exit would close the session,
# check the other sibling's task out and delete state its sibling still reads.
# Registered on every path (created / reused / reopened). The directory component
# uses the SAME sanitization as the sessions/<name>.json filename — a namespaced
# type such as chorus:code-reviewer must never put a ":" or "/" into a path.
HOLDERS_DIR="${CHORUS_STATE_DIR}/holders/${SESSION_NAME_FILE}"
mkdir -p "$HOLDERS_DIR" 2>/dev/null || true
: > "${HOLDERS_DIR}/${AGENT_ID}" 2>/dev/null || true

# === Session file: minimal metadata for other hooks (TeammateIdle, SubagentStop) ===
SESSIONS_DIR="${CHORUS_STATE_DIR}/sessions"
mkdir -p "$SESSIONS_DIR" 2>/dev/null || true

cat > "${SESSIONS_DIR}/${SESSION_NAME_FILE}.json" <<SESSIONEOF
{
  "sessionUuid": "${SESSION_UUID}",
  "agentId": "${AGENT_ID}",
  "agentName": "${SESSION_NAME}",
  "agentType": "${AGENT_TYPE:-unknown}",
  "sessionAction": "${SESSION_ACTION}",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
SESSIONEOF

# === Owner info: read from state (stored by on-session-start.sh from checkin response) ===
OWNER_SECTION=""
OWNER_UUID=$("$API" state-get "owner_uuid" 2>/dev/null) || true
if [ -n "$OWNER_UUID" ]; then
  OWNER_NAME=$("$API" state-get "owner_name" 2>/dev/null) || true
  OWNER_EMAIL=$("$API" state-get "owner_email" 2>/dev/null) || true
  OWNER_SECTION="
## Owner Info

Your owner (the human who created your API key): ${OWNER_NAME} (${OWNER_EMAIL}), UUID: ${OWNER_UUID}
Use this info when you need to @mention your owner in comments."
fi

# === Output: inject workflow directly into sub-agent context via additionalContext ===
WORKFLOW="## Chorus Session (Auto-injected by plugin)

Your Chorus session UUID is: ${SESSION_UUID}
Your session name is: ${SESSION_NAME}
The plugin manages session lifecycle (heartbeat, close). Do NOT call chorus_create_session or chorus_close_session.

### Workflow — follow these steps for each task:

**Before starting:**
1. Check in: chorus_session_checkin_task({ sessionUuid: \"${SESSION_UUID}\", taskUuid: \"<TASK_UUID>\" })
2. Start work: chorus_update_task({ taskUuid: \"<TASK_UUID>\", status: \"in_progress\", sessionUuid: \"${SESSION_UUID}\" })

**While working:**
3. Report progress: chorus_report_work({ taskUuid: \"<TASK_UUID>\", report: \"...\", sessionUuid: \"${SESSION_UUID}\" })

**After completing:**
4. Self-check acceptance criteria (if the task has structured criteria):
   Call chorus_get_task to see acceptanceCriteriaItems, then self-check each criterion as passed.
   For required criteria, keep working until all pass. Only mark optional criteria as failed if out of scope.
   chorus_report_criteria_self_check({ taskUuid: \"<TASK_UUID>\", criteria: [{ uuid: \"<CRITERION_UUID>\", devStatus: \"passed\", devEvidence: \"...\" }] })
5. Check out: chorus_session_checkout_task({ sessionUuid: \"${SESSION_UUID}\", taskUuid: \"<TASK_UUID>\" })
6. Submit: chorus_submit_for_verify({ taskUuid: \"<TASK_UUID>\", summary: \"...\" })

**IMPORTANT — include this in your final response to the main agent:**
When you finish and return your summary, you MUST end it with:
\`\`\`
[Chorus post-completion] Task '<TASK_TITLE>' (<TASK_UUID>) submitted for verify.
Next steps for main agent:
1. REVIEW — spawn chorus:task-reviewer agent, then read its VERDICT comment
2. ACT ON VERDICT: PASS/PASS WITH NOTES → mark AC passed + verify task. FAIL → reopen task and fix BLOCKERs.
3. If you do not have the task:admin permission, stop and ask the user to review and verify this task
\`\`\`
This ensures the main agent knows to run review and verification.

Replace <TASK_UUID> with the actual Chorus task UUID from your prompt.${OWNER_SECTION}"

"$API" hook-output \
  "Chorus session ${SESSION_ACTION}: '${SESSION_NAME}' (${SESSION_UUID:0:8}...)" \
  "$WORKFLOW" \
  "SubagentStart"
