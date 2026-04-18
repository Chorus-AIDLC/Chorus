#!/usr/bin/env bash
# chorus-api.sh — Lightweight REST API wrapper for Chorus session management
# Used by hook scripts to communicate with Chorus backend.
#
# Environment variables:
#   CHORUS_URL      — Chorus base URL (e.g., http://localhost:8637)
#   CHORUS_API_KEY  — Agent API key (cho_xxx)
#
# State file: $CLAUDE_PROJECT_DIR/.chorus/state.json (gitignored)

set -euo pipefail

# ===== Configuration =====

CHORUS_URL="${CHORUS_URL:-}"
CHORUS_API_KEY="${CHORUS_API_KEY:-}"
STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus"
STATE_FILE="${STATE_DIR}/state.json"

# ===== Helpers =====

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_env() {
  [ -n "$CHORUS_URL" ]    || die "CHORUS_URL is not set"
  [ -n "$CHORUS_API_KEY" ] || die "CHORUS_API_KEY is not set"
}

# Make an authenticated API request to Chorus
# Usage: api_call METHOD PATH [DATA]
api_call() {
  local method="$1"
  local path="$2"
  local data="${3:-}"

  local args=(
    -s -S
    -X "$method"
    -H "Authorization: Bearer ${CHORUS_API_KEY}"
    -H "Content-Type: application/json"
  )

  if [ -n "$data" ]; then
    args+=(-d "$data")
  fi

  local response
  response=$(curl "${args[@]}" "${CHORUS_URL}${path}" 2>&1) || {
    echo "CURL_ERROR: Failed to reach ${CHORUS_URL}${path}" >&2
    return 1
  }

  echo "$response"
}

# Ensure state directory and file exist
ensure_state() {
  mkdir -p "$STATE_DIR"
  if [ ! -f "$STATE_FILE" ]; then
    echo '{}' > "$STATE_FILE"
  fi
}

# ===== State Management =====

state_get() {
  local key="$1"
  ensure_state
  if command -v jq &>/dev/null; then
    jq -r --arg k "$key" '.[$k] // empty' "$STATE_FILE"
  else
    # Fallback: simple grep-based extraction
    grep -o "\"${key}\":\"[^\"]*\"" "$STATE_FILE" 2>/dev/null | cut -d'"' -f4
  fi
}

state_set() {
  local key="$1"
  local value="$2"
  ensure_state
  # Use flock to serialize concurrent state writes (multiple SubagentStart hooks
  # may run in parallel, each calling state-set multiple times).
  (
    flock -w 5 200 || { echo "WARN: state_set flock timeout for key=$key" >&2; return 0; }
    if command -v jq &>/dev/null; then
      local tmp
      tmp=$(mktemp)
      jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
    else
      if grep -q "\"${key}\":" "$STATE_FILE" 2>/dev/null; then
        sed -i "s|\"${key}\":\"[^\"]*\"|\"${key}\":\"${value}\"|" "$STATE_FILE"
      else
        local tmp
        tmp=$(mktemp)
        sed "s|}$|,\"${key}\":\"${value}\"}|" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
      fi
    fi
  ) 200>"${STATE_FILE}.lock"
}

state_delete() {
  local key="$1"
  ensure_state
  (
    flock -w 5 200 || { echo "WARN: state_delete flock timeout for key=$key" >&2; return 0; }
    if command -v jq &>/dev/null; then
      local tmp
      tmp=$(mktemp)
      jq --arg k "$key" 'del(.[$k])' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
    fi
  ) 200>"${STATE_FILE}.lock"
}

# ===== Hook Output =====
# Produces JSON that Claude Code parses:
#   systemMessage                          → shown to user as notification
#   hookSpecificOutput.additionalContext   → injected into Claude's context (LLM sees this)
#   hookSpecificOutput.hookEventName       → identifies which hook event produced this context
#
# Usage: hook_output "User-visible message" "Context for Claude LLM" ["HookEventName"]
hook_output() {
  local system_message="$1"
  local additional_context="${2:-}"
  local hook_event_name="${3:-}"
  local updated_input_json="${4:-}"  # Optional: raw JSON object for updatedInput
  if command -v jq &>/dev/null; then
    if [ -n "$updated_input_json" ]; then
      # Build output with updatedInput (for PreToolUse parameter modification)
      jq -n \
        --arg sm "$system_message" \
        --arg ac "$additional_context" \
        --arg hen "$hook_event_name" \
        --argjson ui "$updated_input_json" \
        '{systemMessage: $sm, hookSpecificOutput: {hookEventName: $hen, additionalContext: $ac, updatedInput: $ui}}'
    elif [ -n "$additional_context" ]; then
      jq -n \
        --arg sm "$system_message" \
        --arg ac "$additional_context" \
        --arg hen "$hook_event_name" \
        '{systemMessage: $sm, hookSpecificOutput: {hookEventName: $hen, additionalContext: $ac}}'
    else
      jq -n \
        --arg sm "$system_message" \
        '{systemMessage: $sm}'
    fi
  else
    # Fallback: manual JSON — escape newlines and quotes
    local sm_escaped="${system_message//\\/\\\\}"
    sm_escaped="${sm_escaped//\"/\\\"}"
    sm_escaped="${sm_escaped//$'\n'/\\n}"
    if [ -n "$additional_context" ]; then
      local ac_escaped="${additional_context//\\/\\\\}"
      ac_escaped="${ac_escaped//\"/\\\"}"
      ac_escaped="${ac_escaped//$'\n'/\\n}"
      printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$sm_escaped" "$hook_event_name" "$ac_escaped"
    else
      printf '{"systemMessage":"%s"}\n' "$sm_escaped"
    fi
  fi
}

# ===== Session File Management (Plan A) =====

SESSIONS_DIR="${STATE_DIR}/sessions"

# Read a session file by agent name
# Usage: session_file_read <agent_name>
session_file_read() {
  local name="$1"
  local file="${SESSIONS_DIR}/${name}.json"
  if [ -f "$file" ]; then
    cat "$file"
  else
    echo "" >&2
    return 1
  fi
}

# List all session files
session_file_list() {
  if [ ! -d "$SESSIONS_DIR" ]; then
    echo "[]"
    return
  fi
  if command -v jq &>/dev/null; then
    local result="["
    local first=true
    for f in "$SESSIONS_DIR"/*.json; do
      [ -f "$f" ] || continue
      if [ "$first" = true ]; then
        first=false
      else
        result="${result},"
      fi
      result="${result}$(cat "$f")"
    done
    result="${result}]"
    echo "$result" | jq '.'
  else
    ls "$SESSIONS_DIR"/*.json 2>/dev/null | while read -r f; do
      basename "$f" .json
    done
  fi
}

# ===== Subcommands =====

cmd_checkin() {
  require_env
  api_call GET "/api/health"
}

# Call an MCP tool via JSON-RPC over HTTP Streamable Transport
# Usage: cmd_mcp_tool <tool_name> [arguments_json]
# Returns the text content from the tool result
cmd_mcp_tool() {
  local tool_name="${1:-}"
  local arguments="${2:-{\}}"
  [ -n "$tool_name" ] || die "Usage: chorus-api.sh mcp-tool <tool_name> [arguments_json]"
  require_env
  ensure_state

  local mcp_url="${CHORUS_URL}/api/mcp"
  local auth_header="Authorization: Bearer ${CHORUS_API_KEY}"
  local max_retries=3
  local retry_count=0
  local session_id=""
  local tool_response=""

  # Retry loop for auto-reconnection on 404 (session expired)
  while [ $retry_count -le $max_retries ]; do
    # Step 1: Initialize MCP session
    local init_payload
    init_payload=$(cat <<JSONEOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"chorus-hook","version":"0.1.1"}}}
JSONEOF
)

    # Use a unique temp file for headers to avoid concurrent hooks overwriting each other
    local headers_file
    headers_file=$(mktemp "${STATE_DIR}/.mcp_headers.XXXXXX")

    local init_response
    init_response=$(curl -s -S -X POST \
      -H "$auth_header" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -D "$headers_file" \
      -d "$init_payload" \
      "$mcp_url" 2>/dev/null) || { rm -f "$headers_file"; die "MCP initialize failed"; }

    # Extract session ID from response headers (optional — stateless servers don't return one)
    session_id=$(grep -i "^mcp-session-id:" "$headers_file" 2>/dev/null | tr -d '\r' | awk '{print $2}') || true
    rm -f "$headers_file"

    # Build session header (empty string if stateless server returned no session ID)
    local session_header=""
    if [ -n "$session_id" ]; then
      session_header="mcp-session-id: $session_id"
    fi

    # Step 2: Send initialized notification
    local notif_payload='{"jsonrpc":"2.0","method":"notifications/initialized"}'
    if [ -n "$session_header" ]; then
      curl -s -S -X POST \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -H "$session_header" \
        -d "$notif_payload" \
        "$mcp_url" >/dev/null 2>&1 || true
    else
      curl -s -S -X POST \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -d "$notif_payload" \
        "$mcp_url" >/dev/null 2>&1 || true
    fi

    # Step 3: Call the tool
    local call_payload
    call_payload=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$tool_name" "$arguments")

    # Capture HTTP status code and response separately
    local http_code
    local response_file
    response_file=$(mktemp "${STATE_DIR}/.mcp_response.XXXXXX")

    if [ -n "$session_header" ]; then
      http_code=$(curl -s -S -X POST \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -H "$session_header" \
        -d "$call_payload" \
        -w "%{http_code}" \
        -o "$response_file" \
        "$mcp_url" 2>/dev/null) || http_code="000"
    else
      http_code=$(curl -s -S -X POST \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -d "$call_payload" \
        -w "%{http_code}" \
        -o "$response_file" \
        "$mcp_url" 2>/dev/null) || http_code="000"
    fi

    # Check if session expired (404)
    if [ "$http_code" = "404" ]; then
      retry_count=$((retry_count + 1))
      rm -f "$response_file"

      if [ $retry_count -le $max_retries ]; then
        # Session expired - retry with new session
        continue
      else
        die "MCP session expired after retry. Please reinitialize."
      fi
    fi

    # Read the response
    tool_response=$(cat "$response_file")
    rm -f "$response_file"

    # Break the retry loop - request succeeded
    break
  done

  # Step 4: Close session (best effort, only for stateful servers)
  if [ -n "$session_id" ]; then
    curl -s -S -X DELETE \
      -H "$auth_header" \
      -H "mcp-session-id: $session_id" \
      "$mcp_url" >/dev/null 2>&1 || true
  fi

  # Response may be SSE format (event: message\ndata: {...}) or plain JSON
  # Strip SSE framing to get the JSON payload
  local json_response
  if echo "$tool_response" | grep -q "^data: "; then
    json_response=$(echo "$tool_response" | grep "^data: " | head -1 | sed 's/^data: //')
  else
    json_response="$tool_response"
  fi

  # Extract text content from result
  if command -v jq &>/dev/null; then
    echo "$json_response" | jq -r '.result.content[]? | select(.type=="text") | .text // empty' 2>/dev/null || echo "$json_response"
  else
    echo "$json_response"
  fi
}

# ===== Main Dispatch =====

cmd="${1:-}"
shift || true

case "$cmd" in
  checkin)          cmd_checkin "$@" ;;
  mcp-tool)         cmd_mcp_tool "$@" ;;
  state-get)        state_get "${1:-}" ;;
  state-set)        state_set "${1:-}" "${2:-}" ;;
  state-delete)     state_delete "${1:-}" ;;
  session-read)     session_file_read "${1:-}" ;;
  session-list)     session_file_list ;;
  hook-output)      hook_output "${1:-}" "${2:-}" "${3:-}" "${4:-}" ;;
  *)
    echo "Usage: chorus-api.sh <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  checkin                                Check connectivity with Chorus"
    echo "  mcp-tool <name> [args_json]            Call an MCP tool via JSON-RPC"
    echo "  state-get <key>                        Read from state.json"
    echo "  state-set <key> <value>                Write to state.json"
    echo "  state-delete <key>                     Delete key from state.json"
    echo "  session-read <name>                    Read session file for an agent"
    echo "  session-list                           List all pre-created session files"
    exit 1
    ;;
esac
