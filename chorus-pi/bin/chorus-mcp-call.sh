#!/usr/bin/env bash
# chorus-mcp-call.sh — Stateless MCP-over-HTTP helper for Codex hooks.
#
# Usage:
#   chorus-mcp-call.sh TOOL_NAME '<json_arguments>'
#
# Environment:
#   CHORUS_URL      — Full Chorus MCP endpoint URL
#                     (e.g., https://chorus.example.com/api/mcp).
#                     If only a host is provided (no path), /api/mcp is
#                     appended automatically for backward compatibility.
#   CHORUS_API_KEY  — Agent API key (cho_xxx)
#
# Writes MCP tool result text to stdout. Exits non-zero on error.
# No filesystem state — Codex port is stateless (no .chorus/ directory).

set -euo pipefail

# Connection resolution: CHORUS_URL / CHORUS_API_KEY env vars take
# precedence. When either is unset, fall back to the .mcp.json that
# pi-mcp-adapter auto-discovers (project-root .mcp.json, then
# ~/.pi/agent/mcp.json) so a single config source covers both the
# MCP gateway (literal URL+Bearer) and this wrapper. The .mcp.json
# chorus server entry uses the standard shape:
#   { "url": "…/api/mcp", "headers": { "Authorization": "Bearer cho_…" } }
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  _found=""
  # Search candidate .mcp.json paths. PWD covers plain bash invocations
  # (the project root is the working directory); the global path covers
  # ~/.pi/agent/mcp.json (user-level, shared across projects).
  for _cfg in "${PWD}/.mcp.json" "${HOME}/.pi/agent/mcp.json"; do
    [ -f "$_cfg" ] || continue
    if ! command -v jq >/dev/null 2>&1; then
      echo "chorus-mcp-call: jq required to parse $_cfg but not on PATH" >&2
      break
    fi
    _srv=$(jq -r '.mcpServers.chorus // empty' "$_cfg" 2>/dev/null) || _srv=""
    [ -n "$_srv" ] || continue
    [ -z "${CHORUS_URL:-}" ] && CHORUS_URL=$(printf '%s' "$_srv" | jq -r '.url // empty' 2>/dev/null) || true
    if [ -z "${CHORUS_API_KEY:-}" ]; then
      # Authorization: "Bearer cho_…" → extract just the token
      _auth=$(printf '%s' "$_srv" | jq -r '.headers.Authorization // empty' 2>/dev/null) || _auth=""
      case "$_auth" in
        Bearer\ *) CHORUS_API_KEY="${_auth#Bearer }" ;;
        cho_*) CHORUS_API_KEY="$_auth" ;;
      esac
    fi
    _found=1
    break
  done
  if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
    echo "chorus-mcp-call: CHORUS_URL or CHORUS_API_KEY not set, and no usable chorus server in .mcp.json" >&2
    echo "  Set CHORUS_URL + CHORUS_API_KEY, or add a 'chorus' server to .mcp.json" >&2
    exit 1
  fi
fi

TOOL_NAME="${1:?tool name required}"
# NOTE: avoid `${2:-{}}` — bash mis-parses the literal `{}` inside the
# parameter expansion and produces `{}}` (an extra `}`), which makes the
# server return -32700 "Parse error: Invalid JSON". Assign plainly instead.
ARGS="${2-}"
if [ -z "$ARGS" ]; then
  ARGS='{}'
fi

# Derive the MCP endpoint URL. Accept both:
#   1) Full endpoint:  https://host/api/mcp   (preferred, installer writes this)
#   2) Bare host:      https://host            (legacy — auto-append /api/mcp)
_url="${CHORUS_URL%/}"
case "$_url" in
  http://*/*|https://*/*)
    # Has a path segment beyond the host → assume it's already the full endpoint.
    _rest="${_url#http*://}"
    _rest="${_rest#*/}"
    if [ -n "$_rest" ]; then
      MCP_URL="$_url"
    else
      MCP_URL="${_url}/api/mcp"
    fi
    ;;
  *)
    MCP_URL="${_url}/api/mcp"
    ;;
esac
AUTH="Authorization: Bearer ${CHORUS_API_KEY}"
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"

INIT=$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"chorus-codex-hook","version":"0.14.3"}}}
JSON
)

HEADERS_FILE=$(mktemp)
trap 'rm -f "$HEADERS_FILE"' EXIT

curl -s -S -X POST -H "$AUTH" -H "$CT" -H "$ACCEPT" -D "$HEADERS_FILE" \
  -d "$INIT" "$MCP_URL" >/dev/null || { echo "MCP initialize failed" >&2; exit 2; }

SESSION_ID=$(grep -i '^mcp-session-id:' "$HEADERS_FILE" 2>/dev/null | tr -d '\r' | awk '{print $2}') || true
SESSION_HEADER=()
if [ -n "$SESSION_ID" ]; then
  SESSION_HEADER=(-H "Mcp-Session-Id: ${SESSION_ID}")
fi

# Fire 'initialized' notification (no reply expected)
curl -s -S -X POST -H "$AUTH" -H "$CT" -H "$ACCEPT" "${SESSION_HEADER[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "$MCP_URL" >/dev/null || true

# Call the tool
CALL=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$TOOL_NAME" "$ARGS")

RAW=$(curl -s -S -X POST -H "$AUTH" -H "$CT" -H "$ACCEPT" "${SESSION_HEADER[@]}" \
  -d "$CALL" "$MCP_URL" 2>/dev/null) || { echo "MCP tool call failed" >&2; exit 3; }

# Streamable transport may return SSE framing; strip 'data: ' prefix if present
if printf '%s' "$RAW" | head -1 | grep -q '^event:\|^data:'; then
  RAW=$(printf '%s' "$RAW" | sed -n 's/^data: //p' | head -1)
fi

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$RAW" | jq -r '.result.content[0].text // .result // .'
else
  printf '%s\n' "$RAW"
fi
