#!/usr/bin/env bash
# chorus-sse-monitor.sh — SSE listener for Chorus AIDLC event notifications
# Connects to Chorus SSE endpoint, parses events, outputs formatted messages to stdout.
# Each stdout line wakes Claude Code's Monitor tool.
#
# Environment variables:
#   CHORUS_URL             — Chorus base URL (e.g., https://chorus.example.com)
#   CHORUS_API_KEY         — Agent API key (cho_xxx)
#   CHORUS_PROJECT_UUIDS   — Optional comma-separated project UUIDs to filter events
#
# Bash 3.2 compatible (macOS constraint).

set -uo pipefail

# ===== Configuration =====

CHORUS_URL="${CHORUS_URL:-}"
CHORUS_API_KEY="${CHORUS_API_KEY:-}"
CHORUS_PROJECT_UUIDS="${CHORUS_PROJECT_UUIDS:-}"

INITIAL_DELAY=1
MAX_DELAY=30
reconnect_delay=$INITIAL_DELAY

CURL_PID=""
SSE_FIFO=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ===== Helpers =====

log() {
  echo "[chorus-sse-monitor] $*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_env() {
  if [ -z "$CHORUS_URL" ]; then
    die "CHORUS_URL is not set"
  fi
  if [ -z "$CHORUS_API_KEY" ]; then
    die "CHORUS_API_KEY is not set"
  fi
  command -v jq >/dev/null 2>&1 || die "jq is required but not installed"
  command -v curl >/dev/null 2>&1 || die "curl is required but not installed"
}

# ===== Signal Handling =====

cleanup() {
  if [ -n "$CURL_PID" ] && kill -0 "$CURL_PID" 2>/dev/null; then
    kill "$CURL_PID" 2>/dev/null
    wait "$CURL_PID" 2>/dev/null
  fi
  if [ -n "$SSE_FIFO" ] && [ -p "$SSE_FIFO" ]; then
    rm -f "$SSE_FIFO"
  fi
  log "Shutdown complete"
  exit 0
}

trap cleanup SIGTERM SIGINT EXIT

# ===== Project Filter =====

matches_project_filter() {
  local project_uuid="$1"
  if [ -z "$CHORUS_PROJECT_UUIDS" ]; then
    return 0
  fi
  local IFS=","
  local uuid
  for uuid in $CHORUS_PROJECT_UUIDS; do
    if [ "$uuid" = "$project_uuid" ]; then
      return 0
    fi
  done
  return 1
}

# ===== Event Processing =====

process_event() {
  local json="$1"

  local event_type
  event_type=$(printf '%s' "$json" | jq -r '.type // empty' 2>/dev/null) || return

  if [ "$event_type" != "new_notification" ]; then
    return
  fi

  local notification_uuid action actor_name entity_title entity_type entity_uuid project_uuid
  notification_uuid=$(printf '%s' "$json" | jq -r '.notificationUuid // empty' 2>/dev/null)
  action=$(printf '%s' "$json" | jq -r '.action // empty' 2>/dev/null)
  actor_name=$(printf '%s' "$json" | jq -r '.actorName // empty' 2>/dev/null)
  entity_title=$(printf '%s' "$json" | jq -r '.entityTitle // empty' 2>/dev/null)
  entity_type=$(printf '%s' "$json" | jq -r '.entityType // empty' 2>/dev/null)
  entity_uuid=$(printf '%s' "$json" | jq -r '.entityUuid // empty' 2>/dev/null)
  project_uuid=$(printf '%s' "$json" | jq -r '.projectUuid // empty' 2>/dev/null)

  if [ -z "$action" ]; then
    log "new_notification missing action field, skipping"
    return
  fi

  if ! matches_project_filter "$project_uuid"; then
    log "Event for project ${project_uuid} filtered out"
    return
  fi

  route_event "$notification_uuid" "$action" "$actor_name" "$entity_title" "$entity_type" "$entity_uuid" "$project_uuid"
}

# ===== MCP Notification Fetch =====
# For events that need the `message` field (not in SSE payload),
# fetch notification details via chorus-api.sh MCP tool call.

fetch_notification_message() {
  local notification_uuid="$1"
  local result=""

  result=$("$SCRIPT_DIR/chorus-api.sh" mcp-tool chorus_get_notifications \
    '{"status":"unread","limit":50,"autoMarkRead":false}' 2>/dev/null) || {
    log "MCP fetch failed for notification ${notification_uuid}"
    return 1
  }

  local message
  message=$(printf '%s' "$result" | jq -r \
    --arg uuid "$notification_uuid" \
    '.notifications[]? | select(.uuid == $uuid) | .message // empty' 2>/dev/null)

  if [ -n "$message" ]; then
    printf '%s' "$message"
    return 0
  fi
  return 1
}

# ===== Event Routing =====

route_event() {
  local notification_uuid="$1"
  local action="$2"
  local actor_name="$3"
  local entity_title="$4"
  local entity_type="$5"
  local entity_uuid="$6"
  local project_uuid="$7"

  local suffix="(from: ${actor_name})"
  local msg=""

  case "$action" in
    task_assigned)
      msg="[Chorus] Task assigned: ${entity_title}. Task UUID: ${entity_uuid}, project: ${project_uuid}. Use chorus_get_task to see details and begin work. ${suffix}"
      ;;
    task_verified)
      msg="[Chorus] Task '${entity_title}' verified and done. Task UUID: ${entity_uuid}, project: ${project_uuid}. Check chorus_get_unblocked_tasks for newly ready tasks. ${suffix}"
      ;;
    task_reopened)
      msg="[Chorus] Task '${entity_title}' reopened — needs rework. Task UUID: ${entity_uuid}, project: ${project_uuid}. Use chorus_get_task and chorus_get_comments for feedback. ${suffix}"
      ;;
    proposal_approved)
      msg="[Chorus] Proposal '${entity_title}' APPROVED! Proposal UUID: ${entity_uuid}, project: ${project_uuid}. Use chorus_get_available_tasks to see new tasks. ${suffix}"
      ;;
    proposal_rejected)
      local detail=""
      detail=$(fetch_notification_message "$notification_uuid") || true
      if [ -n "$detail" ]; then
        msg="[Chorus] Proposal '${entity_title}' REJECTED: ${detail}. Proposal UUID: ${entity_uuid}, project: ${project_uuid}. Fix and resubmit. ${suffix}"
      else
        msg="[Chorus] Proposal '${entity_title}' REJECTED. Proposal UUID: ${entity_uuid}, project: ${project_uuid}. Use chorus_get_proposal and chorus_get_comments for details. Fix and resubmit. ${suffix}"
      fi
      ;;
    idea_claimed)
      msg="[Chorus] Idea '${entity_title}' assigned. Idea UUID: ${entity_uuid}, project: ${project_uuid}. Use chorus_get_idea then chorus_claim_idea to start elaboration. ${suffix}"
      ;;
    elaboration_requested)
      msg="[Chorus] Elaboration requested for '${entity_title}'. Idea UUID: ${entity_uuid}, project: ${project_uuid}. Use chorus_get_elaboration to review questions. ${suffix}"
      ;;
    elaboration_answered)
      msg="[Chorus] Elaboration answers submitted for '${entity_title}'. Idea UUID: ${entity_uuid}, project: ${project_uuid}. Review with chorus_get_elaboration, then validate. ${suffix}"
      ;;
    mentioned)
      local detail=""
      detail=$(fetch_notification_message "$notification_uuid") || true
      if [ -n "$detail" ]; then
        msg="[Chorus] @Mentioned in ${entity_type} '${entity_title}': ${detail}. ${entity_type} UUID: ${entity_uuid}, project: ${project_uuid}. Review and respond via chorus_get_comments. ${suffix}"
      else
        msg="[Chorus] @Mentioned in ${entity_type} '${entity_title}'. ${entity_type} UUID: ${entity_uuid}, project: ${project_uuid}. Review and respond via chorus_get_comments. ${suffix}"
      fi
      ;;
    comment_added)
      local detail=""
      detail=$(fetch_notification_message "$notification_uuid") || true
      if [ -n "$detail" ]; then
        msg="[Chorus] New comment on ${entity_type} '${entity_title}': ${detail}. ${entity_type} UUID: ${entity_uuid}, project: ${project_uuid}. Review with chorus_get_comments. ${suffix}"
      else
        msg="[Chorus] New comment on ${entity_type} '${entity_title}'. ${entity_type} UUID: ${entity_uuid}, project: ${project_uuid}. Review with chorus_get_comments. ${suffix}"
      fi
      ;;
    *)
      log "Unhandled notification action: ${action}"
      return
      ;;
  esac

  echo "$msg"
}

# ===== SSE Connection =====

connect_sse() {
  local url="${CHORUS_URL%/}/api/events/notifications"

  log "Connecting to ${url}"

  # Create a temporary FIFO for curl output
  SSE_FIFO=$(mktemp -u /tmp/chorus-sse.XXXXXX)
  mkfifo "$SSE_FIFO"

  # Start curl in background, writing to FIFO
  curl --no-buffer -N -s -S \
    -H "Authorization: Bearer ${CHORUS_API_KEY}" \
    -H "Accept: text/event-stream" \
    "$url" > "$SSE_FIFO" 2>/dev/null &
  CURL_PID=$!

  local connected=false
  local line

  # Read from FIFO line by line
  while IFS= read -r line; do
    case "$line" in
      :*)
        if [ "$connected" = false ]; then
          connected=true
          reconnect_delay=$INITIAL_DELAY
          log "SSE connection established"
        fi
        ;;
      "data: "*)
        process_event "${line#data: }"
        ;;
      "")
        ;;
      *)
        ;;
    esac
  done < "$SSE_FIFO"

  # Curl exited — clean up
  wait "$CURL_PID" 2>/dev/null
  CURL_PID=""
  rm -f "$SSE_FIFO"
  SSE_FIFO=""

  if [ "$connected" = true ]; then
    log "SSE connection lost"
  else
    log "SSE connection failed"
  fi
}

# ===== Main Loop =====

main() {
  require_env

  log "Starting Chorus SSE monitor"
  log "URL: ${CHORUS_URL}"

  while true; do
    connect_sse

    log "Reconnecting in ${reconnect_delay}s"
    sleep "$reconnect_delay"

    # Exponential backoff: 1 -> 2 -> 4 -> 8 -> 16 -> 30
    reconnect_delay=$((reconnect_delay * 2))
    if [ "$reconnect_delay" -gt "$MAX_DELAY" ]; then
      reconnect_delay=$MAX_DELAY
    fi
  done
}

main "$@"
