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
# The checkin payload carries agent owner, effective permissions, the
# active-project distribution, and working-style guidance — surfaced verbatim,
# same as the CC hook.
CONTEXT="# Chorus Plugin — Active

Chorus is connected at ${CHORUS_URL}. Session lifecycle hooks are enabled (checkin on spawn, best-effort heartbeat/checkout on stop, reviewer nudges after workflow MCP calls).

## Checkin

${CHECKIN_RESULT}

## Quick Reference

- **Active Projects**: the checkin above shows activeProjects — which projects you're advancing ideas in, with an active-idea count per project (a location map, not a per-idea to-do list). Use chorus_search to find the specific work the user refers to, and chorus_get_my_assignments for the full per-idea list.
- **Reviewers**: after chorus_pm_submit_proposal / chorus_submit_for_verify / chorus_admin_verify_task, a postToolUse hook will nudge you to spawn the matching read-only reviewer subagent (chorus-proposal-reviewer / chorus-task-reviewer / chorus-code-reviewer). See /chorus-review.
- **Notifications**: chorus_get_notifications() fetches and auto-marks read. See /chorus-develop.
- **Project Groups**: chorus_get_project_groups() before creating projects."

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
