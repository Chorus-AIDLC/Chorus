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

# Resolve config: env var > userConfig (CLAUDE_PLUGIN_OPTION_*)
CHORUS_URL="${CHORUS_URL:-${CLAUDE_PLUGIN_OPTION_CHORUS_URL:-}}"
[ -z "$CHORUS_URL" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Read event from stdin to check agent type
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# Try to extract subagent_type and name from the tool input
AGENT_TYPE=""
AGENT_NAME=""
if [ -n "$EVENT" ]; then
  AGENT_TYPE=$(echo "$EVENT" | jq -r '.tool_input.subagent_type // .input.subagent_type // empty' 2>/dev/null) || true
  AGENT_NAME=$(echo "$EVENT" | jq -r '.tool_input.name // .input.name // empty' 2>/dev/null) || true
fi

# Skip non-worker types — no need to remind for Explore/Plan agents
case "$(printf '%s' "$AGENT_TYPE" | tr '[:upper:]' '[:lower:]')" in
  explore|plan|haiku|claude-code-guide|statusline-setup)
    exit 0
    ;;
esac

# Write a per-agent pending file for SubagentStart to claim.
# SubagentStart only receives agent_id + agent_type — not the name.
# CC sometimes uses the agent name as agent_type, so we store both.
#
# Each spawn gets its own file — no shared state, no concurrency issues.
# File name is the agent name (or a unique fallback if name is empty).
# SubagentStart claims by mv (atomic on same filesystem).
#
# CC may internally spawn cleanup agents that bypass PreToolUse:Task —
# SubagentStart skips those if no pending file matches.
PENDING_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus/pending"
mkdir -p "$PENDING_DIR"

# Use agent name as filename; fall back to timestamp-based unique name
PENDING_NAME="${AGENT_NAME:-unknown-$(date +%s%N)}"
printf '{"name":"%s","type":"%s","ts":"%s"}\n' \
  "${AGENT_NAME:-}" "${AGENT_TYPE:-}" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  > "${PENDING_DIR}/${PENDING_NAME}"

CONTEXT="[Chorus Plugin — Sub-agent Spawn]
Session auto-managed by plugin. Do NOT call chorus_create_session.
Chorus workflow instructions will be auto-injected into the sub-agent by the SubagentStart hook."

"$API" hook-output "" "$CONTEXT" "PreToolUse"
