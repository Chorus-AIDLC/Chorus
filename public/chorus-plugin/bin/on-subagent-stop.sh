#!/usr/bin/env bash
# on-subagent-stop.sh — SubagentStop hook
# Triggered when a sub-agent (teammate) exits.
# Plan D: Auto-checkout from all checked-in tasks, then close the Chorus session.
# Cleans up state and session files.
#
# Output: JSON with systemMessage (user) + additionalContext (Claude)

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

# Extract agent ID from event
# Note: SubagentStop only provides agent_id and agent_type — NOT the name.
# We look up the name from state (stored by SubagentStart).
AGENT_ID=$(echo "$EVENT" | jq -r '.agent_id // .agentId // empty' 2>/dev/null) || true

if [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Lookup session UUID and agent name from state
SESSION_UUID=$("$API" state-get "session_${AGENT_ID}" 2>/dev/null) || true
AGENT_NAME=$("$API" state-get "name_for_agent_${AGENT_ID}" 2>/dev/null) || true

if [ -z "$SESSION_UUID" ]; then
  exit 0
fi

# === Plan D: Auto-checkout from all checked-in tasks ===
CHECKOUT_COUNT=0
SESSION_DETAIL=$("$API" mcp-tool "chorus_get_session" "$(printf '{"sessionUuid":"%s"}' "$SESSION_UUID")" 2>/dev/null) || true

if [ -n "$SESSION_DETAIL" ]; then
  TASK_UUIDS=$(echo "$SESSION_DETAIL" | jq -r '
    .checkins[]? | select(.checkoutAt == null) | .taskUuid // empty
  ' 2>/dev/null) || true

  if [ -z "$TASK_UUIDS" ]; then
    TASK_UUIDS=$(echo "$SESSION_DETAIL" | jq -r '
      .sessionTaskCheckins[]? | select(.checkoutAt == null) | .taskUuid // empty
    ' 2>/dev/null) || true
  fi

  for TASK_UUID in $TASK_UUIDS; do
    if [ -n "$TASK_UUID" ]; then
      "$API" mcp-tool "chorus_session_checkout_task" \
        "$(printf '{"sessionUuid":"%s","taskUuid":"%s"}' "$SESSION_UUID" "$TASK_UUID")" \
        >/dev/null 2>&1 || true
      CHECKOUT_COUNT=$((CHECKOUT_COUNT + 1))
    fi
  done
fi

# Close the Chorus session via MCP
CLOSE_OK=true
"$API" mcp-tool "chorus_close_session" "$(printf '{"sessionUuid":"%s"}' "$SESSION_UUID")" >/dev/null 2>&1 || CLOSE_OK=false

# Clean up state
"$API" state-delete "session_${AGENT_ID}" 2>/dev/null || true
"$API" state-delete "agent_for_session_${SESSION_UUID}" 2>/dev/null || true
"$API" state-delete "name_for_agent_${AGENT_ID}" 2>/dev/null || true
if [ -n "$AGENT_NAME" ]; then
  "$API" state-delete "session_${AGENT_NAME}" 2>/dev/null || true
fi

# Clean up session file
SESSIONS_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus/sessions"
if [ -n "$AGENT_NAME" ] && [ -f "${SESSIONS_DIR}/${AGENT_NAME}.json" ]; then
  rm -f "${SESSIONS_DIR}/${AGENT_NAME}.json"
fi

# Clean up claimed file (written by SubagentStart)
CLAIMED_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus/claimed"
if [ -n "$AGENT_ID" ] && [ -f "${CLAIMED_DIR}/${AGENT_ID}" ]; then
  rm -f "${CLAIMED_DIR}/${AGENT_ID}"
fi

# === Auto-dispatch: discover unblocked tasks ===
UNBLOCKED_INFO=""
if [ "$CLOSE_OK" = true ] && [ -n "$SESSION_DETAIL" ]; then
  # Extract projectUuid from the session's checked-out tasks or session detail
  PROJECT_UUID=""

  # Try to get projectUuid from the tasks we just checked out
  FIRST_TASK_UUID=$(echo "$SESSION_DETAIL" | jq -r '
    (.checkins // .sessionTaskCheckins // [])[] | .taskUuid // empty
  ' 2>/dev/null | head -1) || true

  if [ -n "$FIRST_TASK_UUID" ]; then
    TASK_DETAIL=$("$API" mcp-tool "chorus_get_task" "$(printf '{"taskUuid":"%s"}' "$FIRST_TASK_UUID")" 2>/dev/null) || true
    if [ -n "$TASK_DETAIL" ]; then
      PROJECT_UUID=$(echo "$TASK_DETAIL" | jq -r '.project.uuid // empty' 2>/dev/null) || true
    fi
  fi

  if [ -n "$PROJECT_UUID" ]; then
    UNBLOCKED_RESULT=$("$API" mcp-tool "chorus_get_unblocked_tasks" "$(printf '{"projectUuid":"%s"}' "$PROJECT_UUID")" 2>/dev/null) || true
    if [ -n "$UNBLOCKED_RESULT" ]; then
      UNBLOCKED_COUNT=$(echo "$UNBLOCKED_RESULT" | jq -r '.total // 0' 2>/dev/null) || true
      if [ "${UNBLOCKED_COUNT:-0}" -gt 0 ]; then
        UNBLOCKED_SUMMARY=$(echo "$UNBLOCKED_RESULT" | jq -r '
          .tasks[] | "- [\(.status)] \(.title) (uuid: \(.uuid), priority: \(.priority))"
        ' 2>/dev/null) || true
        UNBLOCKED_INFO="
=== UNBLOCKED TASKS (ready for assignment) ===
${UNBLOCKED_COUNT} task(s) are now unblocked and ready to be claimed/assigned:
${UNBLOCKED_SUMMARY}

Use chorus_get_unblocked_tasks for full details. Consider assigning these to available agents."
      fi
    fi
  fi
fi

# === Verify reminder: check if sub-agent's task(s) need admin verification ===
VERIFY_INFO=""
if [ -n "${TASK_DETAIL:-}" ]; then
  TASK_STATUS=$(echo "$TASK_DETAIL" | jq -r '.status // empty' 2>/dev/null) || true
  TASK_TITLE=$(echo "$TASK_DETAIL" | jq -r '.title // empty' 2>/dev/null) || true

  if [ "$TASK_STATUS" = "to_verify" ]; then
    AGENT_ROLES=$("$API" state-get "agent_roles" 2>/dev/null) || true
    IS_ADMIN="false"
    case ",$AGENT_ROLES," in
      *,admin_agent,*) IS_ADMIN="true" ;;
    esac

    if [ "$IS_ADMIN" = "true" ]; then
      AC_TOTAL=$(echo "$TASK_DETAIL" | jq -r '.acceptanceSummary.required // 0' 2>/dev/null) || true
      ADMIN_PASSED=$(echo "$TASK_DETAIL" | jq -r '.acceptanceSummary.requiredPassed // 0' 2>/dev/null) || true
      DEV_PASSED=$(echo "$TASK_DETAIL" | jq -r '
        [.acceptanceCriteriaItems[]? | select(.required == true and .devStatus == "passed")] | length
      ' 2>/dev/null) || true

      # Downstream dependencies
      DEPENDED_BY_COUNT=$(echo "$TASK_DETAIL" | jq -r '.dependedBy | length // 0' 2>/dev/null) || true
      DOWNSTREAM_NOTE=""
      if [ "${DEPENDED_BY_COUNT:-0}" -gt 0 ]; then
        DEPENDED_BY_LIST=$(echo "$TASK_DETAIL" | jq -r '.dependedBy[] | "  - \(.title) (\(.status))"' 2>/dev/null) || true
        DOWNSTREAM_NOTE=" Verifying will unblock ${DEPENDED_BY_COUNT} downstream task(s):
${DEPENDED_BY_LIST}"
      fi

      # Case 1: Admin already marked all AC → auto-verify
      if [ "${AC_TOTAL:-0}" -gt 0 ] && [ "$AC_TOTAL" = "$ADMIN_PASSED" ]; then
        VERIFY_RESULT=$("$API" mcp-tool "chorus_admin_verify_task" \
          "$(printf '{"taskUuid":"%s"}' "$FIRST_TASK_UUID")" 2>/dev/null) || true
        VERIFY_OK=$(echo "$VERIFY_RESULT" | jq -r '.status // empty' 2>/dev/null) || true
        if [ "$VERIFY_OK" = "done" ]; then
          VERIFY_INFO="
=== AUTO-VERIFIED ===
Task '${TASK_TITLE}' (${FIRST_TASK_UUID}) — admin AC all passed, auto-verified to done.${DOWNSTREAM_NOTE}"
        fi

      # Case 2: Dev self-check all passed, admin not reviewed → remind
      elif [ "${AC_TOTAL:-0}" -gt 0 ] && [ "${DEV_PASSED:-0}" = "$AC_TOTAL" ]; then
        VERIFY_INFO="
=== VERIFY NEEDED ===
Task '${TASK_TITLE}' (${FIRST_TASK_UUID}) — dev self-check passed all ${AC_TOTAL} required criteria (admin: ${ADMIN_PASSED}/${AC_TOTAL}). Please review with chorus_get_task, mark AC with chorus_mark_acceptance_criteria, then chorus_admin_verify_task.${DOWNSTREAM_NOTE}"

      # Case 3: Dev self-check incomplete → warn
      elif [ "${AC_TOTAL:-0}" -gt 0 ]; then
        VERIFY_INFO="
=== VERIFY WARNING ===
Task '${TASK_TITLE}' (${FIRST_TASK_UUID}) — dev self-check INCOMPLETE (${DEV_PASSED}/${AC_TOTAL}). Work may be unfinished. Review with chorus_get_task, consider chorus_admin_reopen_task.${DOWNSTREAM_NOTE}"

      # Case 4: No structured AC → generic reminder
      else
        VERIFY_INFO="
=== VERIFY NEEDED ===
Task '${TASK_TITLE}' (${FIRST_TASK_UUID}) is in to_verify status. Please review and call chorus_admin_verify_task or chorus_admin_reopen_task.${DOWNSTREAM_NOTE}"
      fi
    fi

    # Cache project_uuid for Stop hook
    if [ -n "$PROJECT_UUID" ]; then
      "$API" state-set "project_uuid" "$PROJECT_UUID" 2>/dev/null || true
    fi
  fi
fi

# === Output ===
DISPLAY_NAME="${AGENT_NAME:-${AGENT_ID:0:8}}"
if [ "$CLOSE_OK" = true ]; then
  USER_MSG="Chorus session closed: '${DISPLAY_NAME}'"
  if [ "$CHECKOUT_COUNT" -gt 0 ]; then
    USER_MSG="${USER_MSG} (auto-checkout ${CHECKOUT_COUNT} task(s))"
  fi
  # VERIFY_INFO is only in CONTEXT_MSG (for Claude), not USER_MSG (for human)
  CONTEXT_MSG="Chorus session ${SESSION_UUID} for sub-agent '${DISPLAY_NAME}' closed. ${CHECKOUT_COUNT} task(s) auto-checked-out. State and session file cleaned up.${VERIFY_INFO}${UNBLOCKED_INFO}"
  "$API" hook-output "$USER_MSG" "$CONTEXT_MSG" "SubagentStop"
else
  "$API" hook-output \
    "Chorus: failed to close session for '${DISPLAY_NAME}'" \
    "WARNING: Failed to close Chorus session ${SESSION_UUID} for sub-agent '${DISPLAY_NAME}'. State cleaned up locally." \
    "SubagentStop"
fi
