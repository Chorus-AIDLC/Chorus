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

# Detect OpenSpec mode for this repo, once per session.
# Both conditions are required for OpenSpec mode to be usable:
#   (a) an openspec/ directory at the project root (this repo was inited via `openspec init`), AND
#   (b) the `openspec` CLI on PATH (so we can `openspec new change`, `validate`, `archive`).
# Override: CHORUS_OPENSPEC_MODE=off (explicit opt-out wins even if both
# signals are present — same precedence as the original detection contract).
# Codex doesn't expose a project-dir env var, so we use $PWD (Codex hooks
# run from the project root).
PROJECT_ROOT="$PWD"
OPENSPEC_HINT=""
if [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
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

CTX="# Chorus Plugin — Active (Codex port)

Chorus is connected at ${CHORUS_URL}. MCP tools are available under the \`chorus\` server.

## Checkin

${CHECKIN}

## OpenSpec Mode

CHORUS_OPENSPEC_ACTIVE=${CHORUS_OPENSPEC_ACTIVE} (${OPENSPEC_REASON})"

if [ "$CHORUS_OPENSPEC_ACTIVE" = "1" ]; then
  CTX="${CTX}

OpenSpec mode is **active** for this session. When the proposal / develop / yolo skills reach an OpenSpec-aware step, load the openspec-aware skill at \`~/.codex/skills/openspec-aware/SKILL.md\` and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.

Critical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST go through \`chorus-mcp-call.sh\` with \`content\` produced by \`json_encode_file\`. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode."
else
  CTX="${CTX}

OpenSpec mode is **inactive** for this session. The proposal / develop / yolo skills follow their free-form path; do NOT scaffold \`openspec/changes/\`, do NOT add an \`OpenSpec change slug:\` line to proposal descriptions, and do NOT route document mirror calls through \`chorus-mcp-call.sh\`."
  if [ -n "$OPENSPEC_HINT" ]; then
    CTX="${CTX}

Note: this repo has an \`openspec/\` directory, so the user likely intends to use OpenSpec mode but the \`openspec\` CLI is not installed. Surface this to the user (e.g. \"This repo is OpenSpec-init'd but the \\\`openspec\\\` CLI isn't installed locally — ${OPENSPEC_HINT}\") before authoring documents so they can install it and re-launch the session if they want spec-driven mode."
  fi
fi

CTX="${CTX}

## Quick Reference

- **Sessions are optional**: the Codex port does NOT auto-create Chorus sessions for sub-agents. If you spawn workers via \`spawn_agent\` and want per-worker observability, create a session manually with \`chorus_create_session\` before spawning and \`chorus_close_session\` after the worker returns. Otherwise skip session tools entirely.
- **Notifications**: \`chorus_get_notifications()\` fetches and auto-marks read.
- **Skills**: use \`\$chorus\`, \`\$idea\`, \`\$proposal\`, \`\$develop\`, \`\$review\`, \`\$quick-dev\`, or \`\$yolo\` to load the stage-specific workflow.
- **Reviewer sub-agents**: mount the reviewer skill into a default sub-agent — \`spawn_agent(agent_type=\"default\", items=[{type:\"skill\", path:\"chorus:chorus-proposal-reviewer\"}, {type:\"text\", text:\"Review proposal <uuid>.\"}])\` after \`chorus_pm_submit_proposal\`; same pattern with \`chorus:chorus-task-reviewer\` after \`chorus_submit_for_verify\`. Codex 0.125 only ships three built-in roles (default / explorer / worker) — custom agent_types like \`chorus-proposal-reviewer\` will be rejected. Remember \`close_agent\` after \`wait_agent\`; completed ≠ closed, 6 concurrent max."

USER_MSG="Chorus connected at ${CHORUS_URL}"
if [ "$CHORUS_OPENSPEC_ACTIVE" = "1" ]; then
  USER_MSG="${USER_MSG} (OpenSpec Enabled)"
elif [ -n "$OPENSPEC_HINT" ]; then
  USER_MSG="${USER_MSG} (OpenSpec repo detected — ${OPENSPEC_HINT})"
fi

hook_output "$USER_MSG" "$CTX" "SessionStart"
