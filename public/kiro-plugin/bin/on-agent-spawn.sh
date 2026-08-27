#!/usr/bin/env bash
# on-agent-spawn.sh — Kiro `agentSpawn` hook for the `chorus` main agent.
#
# Kiro contract (kiro.dev/docs/cli/hooks): the agentSpawn event delivers
# {hook_event_name, cwd, session_id} on STDIN, and on exit 0 the hook's
# STDOUT is added to the agent's context as PLAIN TEXT (there is no
# hookSpecificOutput/additionalContext JSON envelope the way Claude Code
# uses — that is the load-bearing difference from the CC on-session-start
# hook this is ported from).
#
# Behavior (parity with CC public/chorus-plugin/bin/on-session-start.sh):
#   * If CHORUS_URL / CHORUS_API_KEY are unset -> print a "not configured"
#     notice to STDOUT and exit 0. NEVER abort the spawn.
#   * Otherwise call chorus_checkin over MCP and print the result (agent
#     owner / permissions / active-project distribution) as the startup context.
#   * If Chorus is unreachable, print a warning and exit 0 (degrade
#     gracefully — the spawn must not fail).
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10): no ${VAR,,}/${VAR^^},
# no `declare -A`, no `readarray`/`mapfile`, no `&>>`, no `|&`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Drain the event JSON from STDIN if present (base fields only for
# agentSpawn; not needed for logic, but consume it so the pipe closes).
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# Not configured -> plain-text notice, exit 0 (never abort spawn).
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  printf '%s\n' "Chorus plugin: not configured. Set CHORUS_URL and CHORUS_API_KEY to enable Chorus session automation (checkin, reviewer nudges, checkout)."
  exit 0
fi

# Call chorus_checkin via MCP. On any failure, warn and exit 0.
CHECKIN_RESULT=$("$API" mcp-tool "chorus_checkin" '{}' 2>/dev/null) || {
  printf '%s\n' "Chorus plugin: unable to reach Chorus at ${CHORUS_URL}. Session lifecycle hooks are inactive for this session."
  exit 0
}

if [ -z "$CHECKIN_RESULT" ]; then
  printf '%s\n' "Chorus plugin: checkin returned no data from ${CHORUS_URL}. Session lifecycle hooks may be degraded."
  exit 0
fi

# Emit the startup context as plain text (Kiro adds STDOUT to context).
# Slim the injected view to ONLY the active-project distribution + working-style
# guidance (idea e8f3af04). CHECKIN_RESULT still carries agent owner / permissions
# / notifications, but we do NOT dump it into the agent's context. Degrades
# gracefully when jq is missing.
CHORUS_ACTIVE_PROJECTS="(active-project distribution unavailable)"
CHORUS_GUIDANCE=""
if command -v jq >/dev/null 2>&1; then
  _AP=$(printf '%s' "$CHECKIN_RESULT" | jq -r '(.activeProjects // {}) | to_entries | if length == 0 then "No active projects — use chorus_search / chorus_get_my_assignments to find work." else (map("- \(.value.name): \(.value.activeIdeaCount) active idea(s)") | join("\n")) end' 2>/dev/null) || true
  [ -n "$_AP" ] && CHORUS_ACTIVE_PROJECTS="$_AP"
  CHORUS_GUIDANCE=$(printf '%s' "$CHECKIN_RESULT" | jq -r '(.guidance // []) | map("- " + .) | join("\n")' 2>/dev/null) || true
fi

CONTEXT="# Chorus Plugin — Active

Chorus is connected at ${CHORUS_URL}. Session lifecycle hooks are enabled (checkin on spawn, best-effort heartbeat/checkout on stop, reviewer nudges after workflow MCP calls).

## Active Projects

${CHORUS_ACTIVE_PROJECTS}

${CHORUS_GUIDANCE}"

# Resume: if a Chorus session was cached by a prior swarm-mode flow,
# send a best-effort heartbeat and note it in context. No session cached
# in the common single-agent case -> nothing to resume (silent).
MAIN_SESSION=$("$API" state-get "main_session_uuid" 2>/dev/null) || true
if [ -n "$MAIN_SESSION" ]; then
  CONTEXT="${CONTEXT}

Resuming with existing Chorus session: ${MAIN_SESSION}"
  "$API" mcp-tool "chorus_session_heartbeat" "$(printf '{"sessionUuid":"%s"}' "$MAIN_SESSION")" >/dev/null 2>&1 || true
fi

printf '%s\n' "$CONTEXT"
exit 0
