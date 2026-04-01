#!/usr/bin/env bash
# on-teammate-idle.sh — TeammateIdle hook
# Triggered when a teammate goes idle (between turns).
# Sends a heartbeat via MCP to keep the Chorus session active.
#
# Output: suppressed (heartbeats are frequent and noisy)

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

# Extract teammate info from event
# TeammateIdle provides teammate_name (unlike SubagentStart/Stop which don't)
TEAMMATE_NAME=$(echo "$EVENT" | jq -r '.teammate_name // .teammateName // empty' 2>/dev/null) || true

# Try to find session UUID by teammate name first, then look up from state
SESSION_UUID=""

if [ -n "$TEAMMATE_NAME" ]; then
  SESSION_UUID=$("$API" state-get "session_${TEAMMATE_NAME}" 2>/dev/null) || true
fi

if [ -z "$SESSION_UUID" ]; then
  exit 0
fi

# Send heartbeat via MCP (suppress all output — heartbeats are too frequent to notify)
"$API" mcp-tool "chorus_session_heartbeat" "$(printf '{"sessionUuid":"%s"}' "$SESSION_UUID")" >/dev/null 2>&1 || true

# Suppress output entirely — no systemMessage for heartbeats
echo '{"suppressOutput": true}'
