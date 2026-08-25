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

TOOL_NAME="${1:?tool name required}"
# NOTE: avoid `${2:-{}}` — bash mis-parses the literal `{}` inside the
# parameter expansion and produces `{}}` (an extra `}`), which makes the
# server return -32700 "Parse error: Invalid JSON". Assign plainly instead.
ARGS="${2-}"
if [ -z "$ARGS" ]; then
  ARGS='{}'
fi

# Decide ONCE whether we can delegate to the native `chorus` CLI. `chorus mcp`
# (and profile-by-name/uuid selection) only exists in chorus >= 0.17.0, so
# version-gate: `chorus --version` prints a bare X.Y.Z; parse the first
# MAJOR.MINOR and accept major>0 OR (major==0 && minor>=17). Bash 3.2-safe.
# CHORUS_MCP_NO_CLI forces the curl path.
_cli_usable=0
_cli_ver=""
if [ -z "${CHORUS_MCP_NO_CLI:-}" ] && command -v chorus >/dev/null 2>&1; then
  _cli_ver=$(chorus --version 2>/dev/null | head -1 | tr -d '\r' || true)
  _cli_major=$(printf '%s' "$_cli_ver" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')
  _cli_minor=$(printf '%s' "$_cli_ver" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\2/p')
  if [ -n "$_cli_major" ] && [ -n "$_cli_minor" ] && { [ "$_cli_major" -gt 0 ] || [ "$_cli_minor" -ge 17 ]; }; then
    _cli_usable=1
  fi
fi

# Profile path (PREFERRED): CHORUS_AGENT_PROFILE + a usable CLI -> delegate by
# profile. The CLI reads this agent's key from ~/.chorus/daemon.json, so
# CHORUS_URL/CHORUS_API_KEY (and the .mcp.json search below) are NOT needed.
# When the CLI is absent/old we fall through to the url+key path.
if [ -n "${CHORUS_AGENT_PROFILE:-}" ] && [ "$_cli_usable" -eq 1 ]; then
  _cli_status=0
  chorus mcp call "$TOOL_NAME" "$ARGS" --agent "$CHORUS_AGENT_PROFILE" || _cli_status=$?
  exit "$_cli_status"
fi

# Connection resolution: CHORUS_URL / CHORUS_API_KEY env vars take
# precedence. When either is unset, fall back to the .mcp.json that
# pi-mcp-adapter auto-discovers (project-root .mcp.json, then
# ~/.pi/agent/mcp.json) so a single config source covers both the
# MCP gateway (literal URL+Bearer) and this wrapper. The .mcp.json
# chorus server entry uses the standard shape:
#   { "url": "…/api/mcp", "headers": { "Authorization": "Bearer cho_…" } }
#
# A PARTIAL entry (e.g. only url, no Authorization) does NOT count — the
# search keeps going so a partial project .mcp.json cannot shadow a complete
# ~/.pi/agent/mcp.json. Only a COMPLETE candidate (both url AND Authorization
# from the SAME source) is accepted; fields are never merged across candidates,
# matching the TS resolver in lib/lib.ts exactly (no credential mismatch when
# project and global point at different Chorus servers).
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  # Search candidate .mcp.json paths. PWD covers plain bash invocations
  # (the project root is the working directory); the global path covers
  # ~/.pi/agent/mcp.json (user-level, shared across projects).
  for _cfg in "${PWD}/.mcp.json" "${HOME}/.pi/agent/mcp.json"; do
    # Both fields already filled (env or an earlier candidate) — stop.
    [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ] || break
    [ -f "$_cfg" ] || continue
    if ! command -v jq >/dev/null 2>&1; then
      echo "chorus-mcp-call: jq required to parse $_cfg but not on PATH" >&2
      break
    fi
    _srv=$(jq -r '.mcpServers.chorus // empty' "$_cfg" 2>/dev/null) || _srv=""
    [ -n "$_srv" ] || continue
    # Read BOTH fields from THIS candidate only (no cross-candidate merge).
    _c_url=$(printf '%s' "$_srv" | jq -r '.url // empty' 2>/dev/null) || _c_url=""
    _c_auth=$(printf '%s' "$_srv" | jq -r '.headers.Authorization // empty' 2>/dev/null) || _c_auth=""
    _c_key=""
    case "$_c_auth" in
      Bearer\ *) _c_key="${_c_auth#Bearer }" ;;
      cho_*) _c_key="$_c_auth" ;;
    esac
    # Accept this candidate only if BOTH url and key are present (complete).
    if [ -n "$_c_url" ] && [ -n "$_c_key" ]; then
      [ -z "${CHORUS_URL:-}" ] && CHORUS_URL="$_c_url"
      [ -z "${CHORUS_API_KEY:-}" ] && CHORUS_API_KEY="$_c_key"
    fi
  done
  if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
    echo "chorus-mcp-call: CHORUS_URL or CHORUS_API_KEY not set, and no usable chorus server in .mcp.json" >&2
    echo "  Set CHORUS_URL + CHORUS_API_KEY, add a 'chorus' server to .mcp.json, or set CHORUS_AGENT_PROFILE with the chorus CLI installed" >&2
    exit 1
  fi
fi

# url+key path. This wrapper stays the single credential resolver (env or the
# .mcp.json discovered above), so pass CHORUS_URL/CHORUS_API_KEY explicitly (the
# CLI does its own /api/mcp normalization, same as the curl path below). Prefer
# the CLI when usable; the fallback never triggers on a call *failure* — a
# present-but-erroring `chorus mcp call` propagates its stdout, stderr, and exit
# code verbatim.
if [ "$_cli_usable" -eq 1 ]; then
  _cli_status=0
  chorus mcp call "$TOOL_NAME" "$ARGS" \
    --url "$CHORUS_URL" --api-key "$CHORUS_API_KEY" || _cli_status=$?
  exit "$_cli_status"
fi
if [ -z "${CHORUS_MCP_NO_CLI:-}" ] && command -v chorus >/dev/null 2>&1; then
  # `chorus` is present but too old for `chorus mcp` -> actionable upgrade error
  # (no silent curl fallback).
  echo "ERROR: chorus CLI version '${_cli_ver:-unknown}' is too old; 'chorus mcp' requires chorus >= 0.17.0. Upgrade with: npm install -g @chorus-aidlc/chorus" >&2
  exit 1
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
