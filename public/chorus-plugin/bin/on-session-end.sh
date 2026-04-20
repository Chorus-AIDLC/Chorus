#!/usr/bin/env bash
# on-session-end.sh — SessionEnd hook
# Fires when Claude Code session ends.
# 1. Parse transcript for token usage → POST turns + timeline to server
# 2. Clean up .chorus/ directory if all sessions are closed and state is empty

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"
STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus"

# Read event JSON from stdin
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# === Layer 3: Token upload removed ===
# Main agent tokens are uploaded per-turn by on-stop.sh (Stop hook).
# on-session-end.sh has a 1.5s timeout and fires only on exit/clear/resume,
# making it unreliable for token capture.

# === Cleanup .chorus/ directory ===
if [ ! -d "$STATE_DIR" ]; then
  exit 0
fi

# Don't delete if there are still active session files
SESSIONS_DIR="${STATE_DIR}/sessions"
if [ -d "$SESSIONS_DIR" ]; then
  REMAINING=0
  for f in "$SESSIONS_DIR"/*.json; do
    [ -f "$f" ] || continue
    REMAINING=$((REMAINING + 1))
  done
  if [ "$REMAINING" -gt 0 ]; then
    exit 0
  fi
fi

# Don't delete if state.json has meaningful content
if [ -f "${STATE_DIR}/state.json" ]; then
  if command -v jq >/dev/null 2>&1; then
    KEY_COUNT=$(jq 'length' "${STATE_DIR}/state.json" 2>/dev/null) || KEY_COUNT=0
    if [ "$KEY_COUNT" -gt 0 ]; then
      exit 0
    fi
  fi
fi

# All clear — remove .chorus/ directory
rm -rf "$STATE_DIR"
