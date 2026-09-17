#!/usr/bin/env bash
# on-subagent-stop.sh — SubagentStop hook
# Triggered when a sub-agent (teammate) exits.
# Auto-checkout from all checked-in tasks, close the Chorus session,
# clean up state files, and auto-verify if admin AC all passed.
#
# Holder-aware: session names are the repeating agent_type, so parallel same-type
# sub-agents SHARE one session. Teardown (checkout / close / name-keyed state /
# sessions file / auto-verify) only happens for the LAST holder of the name — see
# the holder refcount block below. Non-last stops clean up only their own
# id-keyed state and leave the session running for their siblings.
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

# Export the CC session id so state-get / sessions / claimed resolve to the same
# global partition that on-subagent-start wrote to (cross-hook lookup must match).
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID
# shellcheck source=chorus-paths.sh
[ -f "${SCRIPT_DIR}/chorus-paths.sh" ] && { . "${SCRIPT_DIR}/chorus-paths.sh" 2>/dev/null || true; }
CHORUS_STATE_DIR="${CHORUS_STATE_DIR:-${CLAUDE_PROJECT_DIR:-.}/.chorus}"

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

# Sanitized form of the name for on-disk paths (same tr sanitization as
# on-subagent-start.sh uses for sessions/<name>.json and holders/<name>/) —
# namespaced types such as chorus:code-reviewer must not put a ":" into a path.
# The state keys keep the raw name.
AGENT_NAME_FILE=""
if [ -n "$AGENT_NAME" ]; then
  AGENT_NAME_FILE=$(printf '%s' "$AGENT_NAME" | tr -c '[:alnum:]._-' '_')
fi

# === Holder refcount: is this the LAST agent holding the session name? ===
# Session names are the repeating agent_type, so two parallel sub-agents of the
# same type share ONE session (reuse-by-name in on-subagent-start.sh). Remove our
# OWN holder entry first, then count what remains: only the last holder may close
# the session, auto-checkout, auto-verify or delete the name-keyed state that
# siblings (and on-teammate-idle.sh) still read.
#
# Races are benign and must stay benign: if a sibling's start has not registered
# its holder yet we may see 0 holders and close the session; that sibling's start
# then finds a closed/inactive row and reopens it via the existing reopen path.
# Deliberately no locking.
#
# With no name in state we cannot refcount — fall back to the legacy
# single-agent behaviour (treat this stop as the last holder).
HOLDERS_DIR=""
HOLDERS_REMAINING=0
if [ -n "$AGENT_NAME_FILE" ]; then
  HOLDERS_DIR="${CHORUS_STATE_DIR}/holders/${AGENT_NAME_FILE}"
  rm -f "${HOLDERS_DIR}/${AGENT_ID}" 2>/dev/null || true
  if [ -d "$HOLDERS_DIR" ]; then
    HOLDERS_REMAINING=$(ls -1 "$HOLDERS_DIR" 2>/dev/null | grep -c . || true)
  fi
fi
[ -n "$HOLDERS_REMAINING" ] || HOLDERS_REMAINING=0

IS_LAST_HOLDER=true
if [ "$HOLDERS_REMAINING" -gt 0 ]; then
  IS_LAST_HOLDER=false
fi

# === Auto-checkout from all checked-in tasks (last holder only) ===
# Open checkins on a shared session may belong to a still-running sibling, so a
# non-last stop must not check them out — each sub-agent checks its own task out
# per the workflow injected by on-subagent-start.sh.
CHECKOUT_COUNT=0
SESSION_DETAIL=""
CLOSE_OK=true

if [ "$IS_LAST_HOLDER" = true ]; then
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
  "$API" mcp-tool "chorus_close_session" "$(printf '{"sessionUuid":"%s"}' "$SESSION_UUID")" >/dev/null 2>&1 || CLOSE_OK=false
fi

# Clean up state.
# The id-keyed keys are this agent's own and always go. The name-keyed mapping and
# the reverse map agent_for_session_<uuid> (single-valued — siblings overwrite it)
# are shared, so they only go on the last-holder path.
"$API" state-delete "session_${AGENT_ID}" 2>/dev/null || true
"$API" state-delete "name_for_agent_${AGENT_ID}" 2>/dev/null || true
if [ "$IS_LAST_HOLDER" = true ]; then
  "$API" state-delete "agent_for_session_${SESSION_UUID}" 2>/dev/null || true
  if [ -n "$AGENT_NAME" ]; then
    "$API" state-delete "session_${AGENT_NAME}" 2>/dev/null || true
  fi
fi

# Clean up session file + holder dir (last holder only — siblings still read
# sessions/<name>.json, see on-teammate-idle.sh).
SESSIONS_DIR="${CHORUS_STATE_DIR}/sessions"
if [ "$IS_LAST_HOLDER" = true ]; then
  if [ -n "$AGENT_NAME_FILE" ] && [ -f "${SESSIONS_DIR}/${AGENT_NAME_FILE}.json" ]; then
    rm -f "${SESSIONS_DIR}/${AGENT_NAME_FILE}.json"
  fi
  if [ -n "$HOLDERS_DIR" ] && [ -d "$HOLDERS_DIR" ]; then
    rmdir "$HOLDERS_DIR" 2>/dev/null || true
  fi
fi

# Clean up claimed file (written by SubagentStart)
CLAIMED_DIR="${CHORUS_STATE_DIR}/claimed"
if [ -n "$AGENT_ID" ] && [ -f "${CLAIMED_DIR}/${AGENT_ID}" ]; then
  rm -f "${CLAIMED_DIR}/${AGENT_ID}"
fi

# === Auto-verify: if admin marked all AC, verify the task automatically ===
# Last holder only: on a shared session the first checkin may belong to a sibling,
# so a non-last stop must never auto-verify another agent's task.
if [ "$IS_LAST_HOLDER" = true ] && [ "$CLOSE_OK" = true ] && [ -n "$SESSION_DETAIL" ]; then
  FIRST_TASK_UUID=$(echo "$SESSION_DETAIL" | jq -r '
    (.checkins // .sessionTaskCheckins // [])[] | .taskUuid // empty
  ' 2>/dev/null | head -1) || true

  if [ -n "$FIRST_TASK_UUID" ]; then
    TASK_DETAIL=$("$API" mcp-tool "chorus_get_task" "$(printf '{"taskUuid":"%s"}' "$FIRST_TASK_UUID")" 2>/dev/null) || true
    if [ -n "$TASK_DETAIL" ]; then
      TASK_STATUS=$(echo "$TASK_DETAIL" | jq -r '.status // empty' 2>/dev/null) || true

      if [ "$TASK_STATUS" = "to_verify" ]; then
        AGENT_PERMS=$("$API" state-get "agent_permissions" 2>/dev/null) || true
        CAN_VERIFY_TASK="false"
        case ",$AGENT_PERMS," in
          *,task:admin,*) CAN_VERIFY_TASK="true" ;;
        esac

        if [ "$CAN_VERIFY_TASK" = "true" ]; then
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
if [ "$IS_LAST_HOLDER" != true ]; then
  # Shared session still has live holders — do not claim it was closed.
  "$API" hook-output \
    "Chorus session '${DISPLAY_NAME}' kept open (${HOLDERS_REMAINING} other agent(s) still using it)" \
    "" \
    "SubagentStop"
elif [ "$CLOSE_OK" = true ]; then
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
