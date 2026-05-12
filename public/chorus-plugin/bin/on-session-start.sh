#!/usr/bin/env bash
# on-session-start.sh — SessionStart hook
# Triggered on Claude Code session startup/resume.
# Calls chorus_checkin via MCP to inject agent context.
# Also scans for existing session files (metadata for hook state lookup).
#
# Output: JSON with systemMessage (user) + additionalContext (Claude)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Read event JSON from stdin (if available)
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

# Check if Chorus environment is configured
if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  "$API" hook-output \
    "Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY)" \
    "Chorus environment not configured. Set CHORUS_URL and CHORUS_API_KEY to enable Chorus integration." \
    "SessionStart"
  exit 0
fi

# Call chorus_checkin via MCP
CHECKIN_RESULT=$("$API" mcp-tool "chorus_checkin" '{}' 2>/dev/null) || {
  "$API" hook-output \
    "Chorus plugin: connection failed (${CHORUS_URL})" \
    "WARNING: Unable to reach Chorus at ${CHORUS_URL}. Session lifecycle hooks will not function." \
    "SessionStart"
  exit 0
}

# Store owner info from checkin for SubagentStart hook to inject into sub-agent context
if command -v jq >/dev/null 2>&1; then
  _OWNER_NAME=$(echo "$CHECKIN_RESULT" | jq -r '.agent.owner.name // empty' 2>/dev/null) || true
  _OWNER_EMAIL=$(echo "$CHECKIN_RESULT" | jq -r '.agent.owner.email // empty' 2>/dev/null) || true
  _OWNER_UUID=$(echo "$CHECKIN_RESULT" | jq -r '.agent.owner.uuid // empty' 2>/dev/null) || true
  if [ -n "$_OWNER_UUID" ]; then
    "$API" state-set "owner_name" "$_OWNER_NAME"
    "$API" state-set "owner_email" "$_OWNER_EMAIL"
    "$API" state-set "owner_uuid" "$_OWNER_UUID"
  fi

  # Cache effective permissions for downstream hooks.
  # Stored as comma-separated "resource:action" pairs so hooks can substring-match
  # without re-parsing JSON. Example: "idea:read,idea:write,task:read,task:write,task:admin".
  _PERMS=$(echo "$CHECKIN_RESULT" | jq -r '
    .agent.permissions // {}
    | to_entries
    | map(.key as $r | .value[] | "\($r):\(.)")
    | join(",")
  ' 2>/dev/null) || true
  if [ -n "$_PERMS" ]; then
    "$API" state-set "agent_permissions" "$_PERMS"
  fi

fi

# Detect OpenSpec mode for this repo, once per session.
# Both conditions are required for OpenSpec mode to be usable:
#   (a) an openspec/ directory at the project root (this repo was inited via `openspec init`), AND
#   (b) the `openspec` CLI on PATH (so we can `openspec new change`, `validate`, `archive`).
# Overrides (precedence high -> low, first match wins):
#   1. enableOpenSpec userConfig toggle (default true) — UI-level switch.
#   2. CHORUS_OPENSPEC_MODE=off env var — env-level explicit opt-out.
# When the folder is present but the CLI is missing, surface that as a
# specific reason so the user-visible toast can hint at the install step
# instead of silently falling back.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
OPENSPEC_HINT=""
if [ "${CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC:-true}" != "true" ]; then
  CHORUS_OPENSPEC_ACTIVE=0
  OPENSPEC_REASON="enableOpenSpec userConfig=false (plugin-level opt-out)"
elif [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
  CHORUS_OPENSPEC_ACTIVE=0
  OPENSPEC_REASON="CHORUS_OPENSPEC_MODE=off (explicit opt-out)"
elif [ ! -d "${PROJECT_ROOT}/openspec" ]; then
  CHORUS_OPENSPEC_ACTIVE=0
  OPENSPEC_REASON="no openspec/ directory at ${PROJECT_ROOT}/openspec"
elif ! command -v openspec >/dev/null 2>&1; then
  CHORUS_OPENSPEC_ACTIVE=0
  OPENSPEC_REASON="openspec/ directory present but \`openspec\` CLI not on PATH"
  OPENSPEC_HINT="install with: npm i -g @fission-ai/openspec"
else
  CHORUS_OPENSPEC_ACTIVE=1
  OPENSPEC_REASON="openspec/ directory + openspec CLI both present"
fi

# Build context for Claude (additionalContext)
CONTEXT="# Chorus Plugin — Active

Chorus is connected at ${CHORUS_URL}. Session lifecycle hooks are enabled.

## Checkin

${CHECKIN_RESULT}

## OpenSpec Mode

CHORUS_OPENSPEC_ACTIVE=${CHORUS_OPENSPEC_ACTIVE} (${OPENSPEC_REASON})"

if [ "$CHORUS_OPENSPEC_ACTIVE" = "1" ]; then
  CONTEXT="${CONTEXT}

OpenSpec mode is **active** for this session. When the proposal / develop / yolo skills reach an OpenSpec-aware step, load the openspec-aware skill at \`.claude/skills/openspec-aware/SKILL.md\` and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.

Critical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST go through \`chorus-api.sh mcp-tool\` with \`content\` produced by \`json_encode_file\`. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode."
else
  CONTEXT="${CONTEXT}

OpenSpec mode is **inactive** for this session. The proposal / develop / yolo skills follow their free-form path; do NOT scaffold \`openspec/changes/\`, do NOT add an \`OpenSpec change slug:\` line to proposal descriptions, and do NOT route document mirror calls through \`chorus-api.sh\`."
  if [ -n "$OPENSPEC_HINT" ]; then
    CONTEXT="${CONTEXT}

Note: this repo has an \`openspec/\` directory, so the user likely intends to use OpenSpec mode but the \`openspec\` CLI is not installed. Surface this to the user (e.g. \"This repo is OpenSpec-init'd but the \\\`openspec\\\` CLI isn't installed locally — ${OPENSPEC_HINT}\") before authoring documents so they can install it and re-launch the session if they want spec-driven mode."
  fi
fi

CONTEXT="${CONTEXT}

## Quick Reference

- **Idea Tracker**: Shows up to 10 most recently updated ideas. Use chorus_get_ideas() for full list.
- **Sessions**: Auto-managed by hooks. Do NOT call chorus_create_session/chorus_close_session for sub-agents. See /chorus:develop.
- **Notifications**: chorus_get_notifications() fetches and auto-marks read. See /chorus.
- **Project Groups**: chorus_get_project_groups() before creating projects. See /chorus."

# Check for existing state (resumed session)
MAIN_SESSION=$("$API" state-get "main_session_uuid" 2>/dev/null) || true
if [ -n "$MAIN_SESSION" ]; then
  CONTEXT="${CONTEXT}

Resuming with existing Chorus session: ${MAIN_SESSION}"
  "$API" mcp-tool "chorus_session_heartbeat" "$(printf '{"sessionUuid":"%s"}' "$MAIN_SESSION")" >/dev/null 2>&1 || true
fi

# Build user-visible message
USER_MSG="Chorus connected at ${CHORUS_URL}"
if [ "$CHORUS_OPENSPEC_ACTIVE" = "1" ]; then
  USER_MSG="${USER_MSG} (OpenSpec Enabled)"
elif [ -n "$OPENSPEC_HINT" ]; then
  USER_MSG="${USER_MSG} (OpenSpec repo detected — ${OPENSPEC_HINT})"
fi
if [ -n "$MAIN_SESSION" ]; then
  USER_MSG="${USER_MSG} (resumed session)"
fi

"$API" hook-output "$USER_MSG" "$CONTEXT" "SessionStart"
