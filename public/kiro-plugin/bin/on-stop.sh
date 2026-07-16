#!/usr/bin/env bash
# on-stop.sh — Kiro `stop` hook for the `chorus` main agent.
#
# Kiro contract (kiro.dev/docs/cli/hooks): the stop event delivers
# {hook_event_name, cwd, session_id, assistant_response} on STDIN. Kiro
# parses the hook's STDOUT as JSON ONLY to look for
# {"decision":"block","reason":"..."} — which would PREVENT the turn from
# stopping. Any other output (or none) lets the turn stop normally.
#
# This hook is a best-effort session heartbeat/checkout: it NEVER emits a
# block decision and NEVER fails the turn, even if Chorus is unreachable.
# It prints nothing to STDOUT so the turn always stops cleanly.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

# Deliberately NOT `set -e`: a stop hook must never turn a Chorus outage
# into a failed turn. Every Chorus call below is guarded with `|| true`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Drain STDIN if present (assistant_response etc. — not needed here).
if [ ! -t 0 ]; then
  cat >/dev/null 2>&1 || true
fi

# Nothing to do if Chorus isn't configured.
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  exit 0
fi

# Best-effort: if a Chorus session was cached (swarm-mode flow), send a
# final heartbeat and check out of any task it holds. All calls are
# fire-and-forget; failures are swallowed so the turn always stops.
MAIN_SESSION=$("$API" state-get "main_session_uuid" 2>/dev/null) || true
if [ -n "${MAIN_SESSION:-}" ]; then
  "$API" mcp-tool "chorus_session_heartbeat" \
    "$(printf '{"sessionUuid":"%s"}' "$MAIN_SESSION")" >/dev/null 2>&1 || true
  "$API" mcp-tool "chorus_session_checkout_task" \
    "$(printf '{"sessionUuid":"%s"}' "$MAIN_SESSION")" >/dev/null 2>&1 || true
fi

# Print nothing (no block decision) -> the turn stops normally.
exit 0
