#!/usr/bin/env bash
# on-pre-spawn-agent.sh — PreToolUse hook for Task (spawning sub-agents)
# 1. Captures agent name + type from tool_input and writes a per-agent pending file
#    (SubagentStart will claim this file atomically via mv)
# 2. Reminds Team Lead to pass Chorus task info to sub-agents.
#
# Concurrency safety: Each PreToolUse writes a separate file under .chorus/pending/
# so parallel spawns never contend on a shared file. SubagentStart claims files
# atomically with mv (only one process can successfully mv a given file).
#
# Output: JSON with additionalContext

set -euo pipefail

[ -z "${CHORUS_URL:-}" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Read event from stdin to check agent type
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# Export the CC session id so the pending dir lands in this session's partition —
# the SubagentStart hook resolves the same <sessionId> and claims from there.
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID

# Try to extract subagent_type and name from the tool input.
# `tool_input.name` does not exist on CC's Task tool today — it is read for
# forward-compatibility and falls back to subagent_type, which is the value the
# SubagentStart hook also receives as agent_type (and uses as the session name).
AGENT_TYPE=""
AGENT_NAME=""
if [ -n "$EVENT" ]; then
  AGENT_TYPE=$(echo "$EVENT" | jq -r '.tool_input.subagent_type // .input.subagent_type // empty' 2>/dev/null) || true
  AGENT_NAME=$(echo "$EVENT" | jq -r '.tool_input.name // .input.name // empty' 2>/dev/null) || true
fi
AGENT_NAME="${AGENT_NAME:-$AGENT_TYPE}"

# Skip non-worker types — no need to remind for Explore/Plan agents.
# This list MUST stay identical to the skip list in on-subagent-start.sh:
# a type skipped by only one hook leaves an orphan pending file that a later
# internal/cleanup agent could FIFO-claim, defeating the spawn gate.
case "$(printf '%s' "$AGENT_TYPE" | tr '[:upper:]' '[:lower:]')" in
  explore|plan|haiku|claude-code-guide|statusline-setup|chorus:proposal-reviewer|chorus:task-reviewer)
    exit 0
    ;;
esac

# Write a per-agent pending file for SubagentStart to claim.
#
# The pending file is a SPAWN GATE, not a name channel: its presence proves a
# SubagentStart came from a real Task spawn. The session name is derived by
# on-subagent-start.sh from the event's own agent_type, never from this file.
#
# Each spawn gets its own file — no shared state, no concurrency issues.
# SubagentStart claims by mv (atomic on same filesystem).
#
# CC may internally spawn cleanup agents that bypass PreToolUse:Task —
# SubagentStart skips those if no pending file matches.
# Resolve the global per-session state dir (fail-soft to old layout).
# shellcheck source=chorus-paths.sh
[ -f "${SCRIPT_DIR}/chorus-paths.sh" ] && { . "${SCRIPT_DIR}/chorus-paths.sh" 2>/dev/null || true; }
PENDING_DIR="${CHORUS_STATE_DIR:-${CLAUDE_PROJECT_DIR:-.}/.chorus}/pending"
mkdir -p "$PENDING_DIR" 2>/dev/null || true

# Filename stem: sanitized subagent_type (":" and "/" in namespaced types such as
# chorus:code-reviewer become "_"), plus epoch seconds and the PID for uniqueness.
# $$ is required: BSD date (macOS) has no %N, so two same-second spawns of the same
# type would otherwise collide on a single filename and one would be lost.
PENDING_STEM=$(printf '%s' "${AGENT_TYPE:-worker}" | tr -c '[:alnum:]._-' '_')
[ -z "$PENDING_STEM" ] && PENDING_STEM="worker"
PENDING_NAME="${PENDING_STEM}__$(date +%s)-$$"
printf '{"name":"%s","type":"%s","ts":"%s"}\n' \
  "${AGENT_NAME:-}" "${AGENT_TYPE:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "${PENDING_DIR}/${PENDING_NAME}"

CONTEXT="[Chorus Plugin — Sub-agent Spawn]
Session auto-managed by plugin. Do NOT call chorus_create_session.
Chorus workflow instructions will be auto-injected into the sub-agent by the SubagentStart hook."

"$API" hook-output "" "$CONTEXT" "PreToolUse"
