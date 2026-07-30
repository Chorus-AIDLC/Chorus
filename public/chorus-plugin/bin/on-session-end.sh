#!/usr/bin/env bash
# on-session-end.sh — SessionEnd hook
# Fires when Claude Code session ends.
# Removes THIS session's global state directory
# (~/.chorus/plugin/<cwd-slug>/<sessionId>/). Because state is now partitioned
# per session, we can delete our own directory unconditionally without racing
# sibling concurrent sessions of the same project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read event JSON from stdin to lift the session id.
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID

# Resolve this session's global state dir (fail-soft to old per-project layout).
# shellcheck source=chorus-paths.sh
if [ -f "${SCRIPT_DIR}/chorus-paths.sh" ]; then
  . "${SCRIPT_DIR}/chorus-paths.sh" 2>/dev/null || true
fi
STATE_DIR="${CHORUS_STATE_DIR:-${CLAUDE_PROJECT_DIR:-.}/.chorus}"

# Nothing to clean up
if [ ! -d "$STATE_DIR" ]; then
  exit 0
fi

# Guard: never delete the shared "no-session" fallback bucket — a degenerate
# session (no session id on stdin) must not wipe state that a concurrent,
# properly-identified session might also be using. Only self-delete when we
# resolved a real per-session directory.
case "${CHORUS_SESSION_ID:-}" in
  ""|no-session)
    exit 0
    ;;
esac

# Remove only this session's directory. Session-scoped, so no sibling guard needed.
rm -rf "$STATE_DIR" 2>/dev/null || true

# Best-effort: remove the now-possibly-empty <cwd-slug>/ parent. Fails (and is
# ignored) if other concurrent sessions of this project still have directories.
if [ -n "${CHORUS_PLUGIN_ROOT:-}" ] && [ -n "${CHORUS_CWD_SLUG:-}" ]; then
  rmdir "${CHORUS_PLUGIN_ROOT}/${CHORUS_CWD_SLUG}" 2>/dev/null || true
fi

exit 0
