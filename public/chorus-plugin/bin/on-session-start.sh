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

# Extract the Claude Code session id from the event and export it so chorus-api.sh
# (and any sub-path we build) resolves to this session's global state partition.
# Fail-soft: an absent id just falls back to the shared "no-session" bucket.
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID

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

# Resolve the active spec mode for this repo, once per session. The resolution
# logic lives in resolve-spec-mode.sh (pure: env + filesystem only) so it can be
# unit-tested — see bin/tests/test-spec-mode-resolution.sh. It sets SPEC_MODE,
# SPEC_REASON, SPEC_FAIL, OPENSPEC_USABLE_REASON, OPENSPEC_HINT, CHORUS_OPENSPEC_ACTIVE.
#
# Summary: an explicit CHORUS_SPEC_MODE (lite|openspec|off) wins; when UNSET,
# OpenSpec stays the default whenever it is usable (openspec/ dir + CLI, not
# disabled) and lite is the fallback only when OpenSpec is absent or disabled.
# Legacy CHORUS_OPENSPEC_MODE=off still forces not-openspec (→ lite when unset).
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
. "${SCRIPT_DIR}/resolve-spec-mode.sh"

# Build context for Claude (additionalContext)
CONTEXT="# Chorus Plugin — Active

Chorus is connected at ${CHORUS_URL}. Session lifecycle hooks are enabled.

## Checkin

${CHECKIN_RESULT}

## Spec Mode

CHORUS_SPEC_MODE=${SPEC_MODE} (${SPEC_REASON})"

if [ "$SPEC_MODE" = "lite" ]; then
  CONTEXT="${CONTEXT}

Routing: lite → follow the spec-lite skill (\`skills/spec-lite/SKILL.md\`). Author a Chorus-native change folder \`.chorus/specs/<slug>/\` (\`prd.md\` required; \`tech_design.md\` / \`adr.md\` / \`spec.md\` / \`guide.md\` optional) and mirror each \`<type>.md\` 1:1 into a Chorus Document of that type via \`chorus mcp call … --arg-file content=<file>\`. Do NOT scaffold \`openspec/changes/\` or add an \`OpenSpec change slug:\` line."
elif [ "$SPEC_MODE" = "off" ]; then
  CONTEXT="${CONTEXT}

Routing: off → free-form, no spec artifact. Do NOT create \`.chorus/specs/\` or \`openspec/changes/\` files; author document drafts inline via direct MCP."
elif [ -n "$SPEC_FAIL" ]; then
  CONTEXT="${CONTEXT}

Routing: openspec → **cannot be honored** — ${SPEC_FAIL}. The proposal / yolo skill MUST halt after resolving the mode; do NOT silently fall back to lite/free-form. Surface this to the user."
  if [ -n "$OPENSPEC_HINT" ]; then
    CONTEXT="${CONTEXT} Install hint: ${OPENSPEC_HINT}."
  fi
else
  CONTEXT="${CONTEXT}

CHORUS_OPENSPEC_ACTIVE=1 (${OPENSPEC_USABLE_REASON})

Routing: openspec → load the openspec-aware skill at \`.claude/skills/openspec-aware/SKILL.md\` and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.

Critical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST fill \`content\` from the local file — prefer \`chorus mcp call <tool> '<json>' --arg-file content=<file>\`, falling back to \`chorus-api.sh mcp-tool\` with \`json_encode_file\` when \`chorus\` is not on PATH. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode."
fi

CONTEXT="${CONTEXT}

## Quick Reference

- **Long-horizon work**: follow AI-DLC via the Chorus skill (idea → proposal → task → verify) rather than coding ad hoc, and use chorus_search to locate the specific work the user refers to across ideas/proposals/tasks/docs.
- **Active Projects**: checkin.activeProjects shows which projects you're advancing ideas in, with an active-idea count per project — it is a location map, not a per-idea to-do list. Use chorus_search to find the specific work the user refers to (across ideas/proposals/tasks/docs), and chorus_get_my_assignments for the full per-idea list.
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

# Build user-visible message. Always states the active spec mode (lite is the
# default); an explicit openspec that can't be honored is flagged as not usable.
#   lite              -> (Spec: lite)
#   off               -> (Spec: off)
#   openspec (usable) -> (Spec: openspec)
#   openspec (broken) -> (Spec: openspec — not usable)
USER_MSG="Chorus connected at ${CHORUS_URL}"
if [ "$SPEC_MODE" = "lite" ]; then
  USER_MSG="${USER_MSG} (Spec: lite)"
elif [ "$SPEC_MODE" = "off" ]; then
  USER_MSG="${USER_MSG} (Spec: off)"
elif [ -n "$SPEC_FAIL" ]; then
  USER_MSG="${USER_MSG} (Spec: openspec — not usable)"
else
  USER_MSG="${USER_MSG} (Spec: openspec)"
fi
if [ -n "$MAIN_SESSION" ]; then
  USER_MSG="${USER_MSG} (resumed session)"
fi

"$API" hook-output "$USER_MSG" "$CONTEXT" "SessionStart"
