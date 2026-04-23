#!/usr/bin/env bash
# on-subagent-stop.sh — SubagentStop hook
# Triggered when a sub-agent (teammate) exits.
# Auto-checkout from all checked-in tasks, close the Chorus session,
# clean up state files, and auto-verify if admin AC all passed.
#
# NOTE: SubagentStop does NOT support additionalContext in Claude Code's
# hookSpecificOutput schema, and systemMessage only reaches the UI —
# not the main agent's LLM context. All agent-facing reminders must go
# through SubagentStart workflow injection instead.

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

# === Auto-checkout from all checked-in tasks ===
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

# === Auto-verify: if admin marked all AC, verify the task automatically ===
if [ "$CLOSE_OK" = true ] && [ -n "$SESSION_DETAIL" ]; then
  FIRST_TASK_UUID=$(echo "$SESSION_DETAIL" | jq -r '
    (.checkins // .sessionTaskCheckins // [])[] | .taskUuid // empty
  ' 2>/dev/null | head -1) || true

  if [ -n "$FIRST_TASK_UUID" ]; then
    TASK_DETAIL=$("$API" mcp-tool "chorus_get_task" "$(printf '{"taskUuid":"%s"}' "$FIRST_TASK_UUID")" 2>/dev/null) || true
    if [ -n "$TASK_DETAIL" ]; then
      TASK_STATUS=$(echo "$TASK_DETAIL" | jq -r '.status // empty' 2>/dev/null) || true

      if [ "$TASK_STATUS" = "to_verify" ]; then
        AGENT_ROLES=$("$API" state-get "agent_roles" 2>/dev/null) || true
        IS_ADMIN="false"
        case ",$AGENT_ROLES," in
          *,admin_agent,*) IS_ADMIN="true" ;;
        esac

        if [ "$IS_ADMIN" = "true" ]; then
          AC_TOTAL=$(echo "$TASK_DETAIL" | jq -r '.acceptanceSummary.required // 0' 2>/dev/null) || true
          ADMIN_PASSED=$(echo "$TASK_DETAIL" | jq -r '.acceptanceSummary.requiredPassed // 0' 2>/dev/null) || true

          if [ "${AC_TOTAL:-0}" -gt 0 ] && [ "$AC_TOTAL" = "$ADMIN_PASSED" ]; then
            "$API" mcp-tool "chorus_admin_verify_task" \
              "$(printf '{"taskUuid":"%s"}' "$FIRST_TASK_UUID")" \
              >/dev/null 2>&1 || true
          fi
        fi

        # Cache project_uuid for other hooks
        PROJECT_UUID=$(echo "$TASK_DETAIL" | jq -r '.project.uuid // empty' 2>/dev/null) || true
        if [ -n "$PROJECT_UUID" ]; then
          "$API" state-set "project_uuid" "$PROJECT_UUID" 2>/dev/null || true
        fi
      fi
    fi
  fi
fi

# === Output (UI-only, not visible to main agent LLM) ===
DISPLAY_NAME="${AGENT_NAME:-${AGENT_ID:0:8}}"
if [ "$CLOSE_OK" = true ]; then
  USER_MSG="Chorus session closed: '${DISPLAY_NAME}'"
  if [ "$CHECKOUT_COUNT" -gt 0 ]; then
    USER_MSG="${USER_MSG} (auto-checkout ${CHECKOUT_COUNT} task(s))"
  fi
  "$API" hook-output "$USER_MSG" "" "SubagentStop"
else
  "$API" hook-output \
    "Chorus: failed to close session for '${DISPLAY_NAME}'" \
    "" \
    "SubagentStop"
fi
