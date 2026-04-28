#!/usr/bin/env bash
# on-session-start.sh — Codex SessionStart hook.
#
# Calls chorus_checkin via MCP and injects the result as additionalContext
# (developer message) into the session. Stateless — no local files written.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./hook-output.sh
source "${DIR}/hook-output.sh"

# Consume stdin event JSON (we don't need its fields for SessionStart).
if [ ! -t 0 ]; then cat > /dev/null; fi

if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  hook_output \
    "Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY)" \
    "Chorus environment not configured. Set CHORUS_URL and CHORUS_API_KEY to enable Chorus integration." \
    "SessionStart"
  exit 0
fi

CHECKIN=$("${DIR}/chorus-mcp-call.sh" chorus_checkin '{}' 2>/dev/null) || {
  hook_output \
    "Chorus: connection failed (${CHORUS_URL})" \
    "WARNING: Unable to reach Chorus at ${CHORUS_URL}. MCP tools may still work if reachable during the session." \
    "SessionStart"
  exit 0
}

CTX="# Chorus Plugin — Active (Codex port)

Chorus is connected at ${CHORUS_URL}. MCP tools are available under the \`chorus\` server.

## Checkin

${CHECKIN}

## Quick Reference

- **Sessions are optional**: the Codex port does NOT auto-create Chorus sessions for sub-agents. If you spawn workers via \`spawn_agent\` and want per-worker observability, create a session manually with \`chorus_create_session\` before spawning and \`chorus_close_session\` after the worker returns. Otherwise skip session tools entirely.
- **Notifications**: \`chorus_get_notifications()\` fetches and auto-marks read.
- **Skills**: use \`\$chorus\`, \`\$idea\`, \`\$proposal\`, \`\$develop\`, \`\$review\`, \`\$quick-dev\`, or \`\$yolo\` to load the stage-specific workflow.
- **Reviewer sub-agents**: mount the reviewer skill into a default sub-agent — \`spawn_agent(agent_type=\"default\", items=[{type:\"skill\", path:\"chorus:chorus-proposal-reviewer\"}, {type:\"text\", text:\"Review proposal <uuid>.\"}])\` after \`chorus_pm_submit_proposal\`; same pattern with \`chorus:chorus-task-reviewer\` after \`chorus_submit_for_verify\`. Codex 0.125 only ships three built-in roles (default / explorer / worker) — custom agent_types like \`chorus-proposal-reviewer\` will be rejected. Remember \`close_agent\` after \`wait_agent\`; completed ≠ closed, 6 concurrent max."

hook_output "Chorus connected at ${CHORUS_URL}" "$CTX" "SessionStart"
