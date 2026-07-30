#!/usr/bin/env bash
# on-user-prompt.sh — UserPromptSubmit hook
# Fires on EVERY user message. Must be ultra-fast (<100ms).
# NO MCP calls, NO network calls — only local file checks.
# Injects a brief Chorus workflow reminder into Claude's context.
#
# Output: JSON with additionalContext (for Claude)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Skip entirely if Chorus is not configured
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  exit 0
fi

# Read stdin only to lift the session id (no MCP, no network — stays fast).
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID

# Resolve this session's global state dir (fail-soft to the old layout).
# shellcheck source=chorus-paths.sh
[ -f "${SCRIPT_DIR}/chorus-paths.sh" ] && { . "${SCRIPT_DIR}/chorus-paths.sh" 2>/dev/null || true; }
STATE_DIR="${CHORUS_STATE_DIR:-${CLAUDE_PROJECT_DIR:-.}/.chorus}"
SESSIONS_DIR="${STATE_DIR}/sessions"

# Count active session files (fast local check)
SESSION_COUNT=0
SESSION_NAMES=""
if [ -d "$SESSIONS_DIR" ]; then
  for f in "$SESSIONS_DIR"/*.json; do
    [ -f "$f" ] || continue
    SESSION_COUNT=$((SESSION_COUNT + 1))
    NAME=$(basename "$f" .json)
    if [ -n "$SESSION_NAMES" ]; then
      SESSION_NAMES="${SESSION_NAMES}, ${NAME}"
    else
      SESSION_NAMES="$NAME"
    fi
  done
fi

# Build context — keep it concise to minimize token usage
CONTEXT="[Chorus Plugin Active]
- Sub-agent sessions are auto-managed by hooks (create/reuse/heartbeat/close).
- Do NOT call chorus_create_session or chorus_close_session for sub-agents — the plugin handles this.
- When spawning sub-agents: just pass Chorus task UUIDs. Session UUID + workflow are auto-injected by SubagentStart hook.
- Link CC tasks to Chorus tasks with \`chorus:task:<uuid>\` in description."

if [ "$SESSION_COUNT" -gt 0 ]; then
  CONTEXT="${CONTEXT}
- Active sub-agent sessions (${SESSION_COUNT}): ${SESSION_NAMES}"
fi

# Output JSON — no systemMessage (too noisy for every turn)
if command -v jq &>/dev/null; then
  jq -n --arg ac "$CONTEXT" '{additionalContext: $ac}'
else
  # Fallback
  AC_ESCAPED="${CONTEXT//\\/\\\\}"
  AC_ESCAPED="${AC_ESCAPED//\"/\\\"}"
  AC_ESCAPED="${AC_ESCAPED//$'\n'/\\n}"
  printf '{"additionalContext":"%s"}\n' "$AC_ESCAPED"
fi
