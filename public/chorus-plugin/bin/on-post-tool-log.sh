#!/usr/bin/env bash
# on-post-tool-log.sh — PostToolUse hook, captures every tool call to local JSONL.
# Runs async:true so it never blocks Claude. Pure local file append, no network.
#
# Event JSON from stdin (CC provides):
#   tool_name, tool_input, tool_response, tool_use_id, agent_id
#
# Behavior:
#  - For MCP tools matching mcp__chorus__*, try to extract an entity UUID from
#    tool_input (taskUuid/proposalUuid/ideaUuid/documentUuid/projectUuid/sessionUuid)
#    and update the Active Context in .chorus/state.json.
#  - Append a compact JSONL line to .chorus/tool-log.jsonl with:
#      ts, tool, id (tool_use_id), agent (agent_id), input_len, output_len,
#      is_error, entity_type, entity_uuid
#
# NOTE: Must be Bash 3.2 compatible. No ${VAR,,}, no declare -A, no readarray.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"
STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus"
LOG_FILE="${STATE_DIR}/tool-log.jsonl"
LOCK_FILE="${LOG_FILE}.lock"

# Read event JSON from stdin
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# Nothing to do without an event payload
if [ -z "$EVENT" ]; then
  exit 0
fi

# jq is required for reliable parsing. If missing, skip silently — we don't
# want to break Claude Code when jq is absent; T0 set up is best-effort.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$STATE_DIR"

# Extract base fields (all optional, default to empty)
TOOL_NAME=$(printf '%s' "$EVENT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
TOOL_USE_ID=$(printf '%s' "$EVENT" | jq -r '.tool_use_id // empty' 2>/dev/null || echo "")
AGENT_ID=$(printf '%s' "$EVENT" | jq -r '.agent_id // empty' 2>/dev/null || echo "")

# Without a tool name there's nothing useful to record
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Compute sizes of input/output JSON payloads (byte length of the JSON text).
INPUT_LEN=$(printf '%s' "$EVENT" | jq -r '(.tool_input // null) | if . == null then 0 else (tojson | length) end' 2>/dev/null || echo "0")
OUTPUT_LEN=$(printf '%s' "$EVENT" | jq -r '(.tool_response // null) | if . == null then 0 else (tojson | length) end' 2>/dev/null || echo "0")

# Detect error. CC sometimes reports errors as tool_response.is_error
# or as a top-level is_error, or via an "error" field inside tool_response.
IS_ERROR=$(printf '%s' "$EVENT" | jq -r '
  if (.tool_response | type) == "object" then
    ((.tool_response.is_error // .tool_response.isError // false) | tostring)
  elif (.is_error // false) then "true"
  else "false" end
' 2>/dev/null || echo "false")

# ===== Active Context update (Chorus MCP tools only) =====
ENTITY_TYPE=""
ENTITY_UUID=""

case "$TOOL_NAME" in
  mcp__chorus*)
    # Try known entity-UUID param names in priority order.
    # First match wins. All are uuid-shaped strings in tool_input.
    for KEY in taskUuid proposalUuid ideaUuid documentUuid projectUuid sessionUuid projectGroupUuid; do
      VAL=$(printf '%s' "$EVENT" | jq -r --arg k "$KEY" '.tool_input[$k] // empty' 2>/dev/null || echo "")
      if [ -n "$VAL" ]; then
        ENTITY_UUID="$VAL"
        # Map param name -> entity_type. Keep short canonical names.
        case "$KEY" in
          taskUuid)         ENTITY_TYPE="task" ;;
          proposalUuid)     ENTITY_TYPE="proposal" ;;
          ideaUuid)         ENTITY_TYPE="idea" ;;
          documentUuid)     ENTITY_TYPE="document" ;;
          projectUuid)      ENTITY_TYPE="project" ;;
          sessionUuid)      ENTITY_TYPE="session" ;;
          projectGroupUuid) ENTITY_TYPE="project_group" ;;
        esac
        break
      fi
    done

    # Update Active Context in state.json so other hooks / UI can surface
    # "what is the agent currently looking at?". Best-effort.
    if [ -n "$ENTITY_TYPE" ] && [ -n "$ENTITY_UUID" ]; then
      "$API" state-set "active_${ENTITY_TYPE}_uuid" "$ENTITY_UUID" >/dev/null 2>&1 || true
      "$API" state-set "active_entity_type" "$ENTITY_TYPE" >/dev/null 2>&1 || true
      "$API" state-set "active_entity_uuid" "$ENTITY_UUID" >/dev/null 2>&1 || true
    fi
    ;;
esac

# ===== Build compact JSONL entry =====
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

LINE=$(jq -cn \
  --arg ts "$TS" \
  --arg tool "$TOOL_NAME" \
  --arg id "$TOOL_USE_ID" \
  --arg agent "$AGENT_ID" \
  --argjson input_len "${INPUT_LEN:-0}" \
  --argjson output_len "${OUTPUT_LEN:-0}" \
  --argjson is_error "${IS_ERROR:-false}" \
  --arg entity_type "$ENTITY_TYPE" \
  --arg entity_uuid "$ENTITY_UUID" \
  '{
     ts: $ts,
     tool: $tool,
     id: (if $id == "" then null else $id end),
     agent: (if $agent == "" then null else $agent end),
     input_len: $input_len,
     output_len: $output_len,
     is_error: $is_error,
     entity_type: (if $entity_type == "" then null else $entity_type end),
     entity_uuid: (if $entity_uuid == "" then null else $entity_uuid end)
   }' 2>/dev/null) || exit 0

# Serialize concurrent appends across multiple teammate processes.
# flock on macOS (Bash 3.2) is available via util-linux shim in CI; on mac
# itself we fall back to a plain append (acceptable race for a log file).
if command -v flock >/dev/null 2>&1; then
  (
    flock -w 2 201 || exit 0
    printf '%s\n' "$LINE" >> "$LOG_FILE"
  ) 201>"$LOCK_FILE" || true
else
  printf '%s\n' "$LINE" >> "$LOG_FILE" || true
fi

# Async hooks: suppress any output so we don't perturb Claude's context.
exit 0
