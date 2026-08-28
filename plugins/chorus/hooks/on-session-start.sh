#!/usr/bin/env bash
# on-session-start.sh — Codex SessionStart hook.
#
# Calls chorus_checkin via MCP and injects bounded developer context.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./hook-output.sh
source "${DIR}/hook-output.sh"
MCP_CALL="${CHORUS_MCP_CALL:-${DIR}/chorus-mcp-call.sh}"

# Consume stdin event JSON; the matcher handles the SessionStart source.
if [ ! -t 0 ]; then cat > /dev/null; fi

if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  hook_output \
    "Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY)" \
    "Chorus environment not configured. Set CHORUS_URL and CHORUS_API_KEY to enable Chorus integration." \
    "SessionStart"
  exit 0
fi

CHECKIN=$("$MCP_CALL" chorus_checkin '{}' 2>/dev/null) || {
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
#
# The inactive states split into two user-facing kinds (same as the Claude
# Code hook, minus the plugin toggle Codex doesn't have):
#   - OPENSPEC_OPTOUT=1 — CHORUS_OPENSPEC_MODE=off, an explicit choice. Show a
#     neutral note, no nag.
#   - OPENSPEC_OPTOUT=0 — OpenSpec is simply not set up. Point the user at
#     `$chorus enable openspec`, which walks the actual install/init steps.
PROJECT_ROOT="$PWD"
OPENSPEC_HINT=""
OPENSPEC_OPTOUT=0
if [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
  CHORUS_OPENSPEC_ACTIVE=0
  OPENSPEC_OPTOUT=1
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

Critical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST fill \`content\` from the local file — prefer \`chorus mcp call <tool> '<json>' --arg-file content=<file>\`, falling back to \`chorus-mcp-call.sh\` with \`json_encode_file\` when \`chorus\` is not on PATH. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode."
else
  CTX="${CTX}

OpenSpec mode is **inactive** for this session. The proposal / develop / yolo skills follow their free-form path; do NOT scaffold \`openspec/changes/\`, do NOT add an \`OpenSpec change slug:\` line to proposal descriptions, and do NOT route document mirror calls through the \`chorus\` CLI or \`chorus-mcp-call.sh\`."
  if [ "$OPENSPEC_OPTOUT" = "1" ]; then
    CTX="${CTX}

OpenSpec was **explicitly turned off** (${OPENSPEC_REASON}), so this is a deliberate choice — do NOT nag the user to enable it. If they ask to turn it back on, point them at unsetting \`CHORUS_OPENSPEC_MODE\`, then the OpenSpec setup section in the \`\$chorus\` skill."
  elif [ -n "$OPENSPEC_HINT" ]; then
    CTX="${CTX}

Note: this repo has an \`openspec/\` directory, so the user likely intends to use OpenSpec mode but the \`openspec\` CLI is not installed. Surface this to the user (e.g. \"This repo is OpenSpec-init'd but the \\\`openspec\\\` CLI isn't installed locally — ${OPENSPEC_HINT}\") before authoring documents. To set it up, run \`\$chorus enable openspec\` (§6 walks the install + restart)."
  else
    CTX="${CTX}

Note: OpenSpec is not set up in this repo (${OPENSPEC_REASON}). Spec-driven authoring is optional — free-form works fine. If the user wants spec-driven mode (proposal.md / design.md / spec deltas mirrored into Chorus), run \`\$chorus enable openspec\` — §6 walks the \`npm i -g @fission-ai/openspec\` + \`openspec init\` steps and the restart."
  fi
fi

CTX="${CTX}

## Quick Reference

- **Long-horizon work**: follow AI-DLC via the Chorus skill (idea → proposal → task → verify) rather than coding ad hoc, and use chorus_search to locate the specific work the user refers to across ideas/proposals/tasks/docs.
- **Notifications**: \`chorus_get_notifications()\` fetches and auto-marks read.
- **Skills**: use \`\$chorus\`, \`\$idea\`, \`\$proposal\`, \`\$develop\`, \`\$review\`, \`\$quick-dev\`, or \`\$yolo\` to load the stage-specific workflow.
- **Reviewer sub-agents**: mount the reviewer skill explicitly — \`spawn_agent({items:[{type:\"skill\", path:\"chorus:chorus-proposal-reviewer\"}, {type:\"text\", text:\"Review proposal <proposal-uuid> and post VERDICT.\"}]})\` after \`chorus_pm_submit_proposal\`; use \`chorus:chorus-task-reviewer\` with the task UUID after \`chorus_submit_for_verify\`. Wait only when the next gate depends on the verdict, then close the thread; use \`send_input\` for an active child and \`resume_agent\` only for a previously closed one. Routine entity-backed children use fresh context; \`fork_context: true\` is only for material parent-conversation state."

# User-visible status (mirrors the Claude Code hook; Codex skill prefix is $chorus).
USER_MSG="Chorus connected at ${CHORUS_URL}"
if [ "$CHORUS_OPENSPEC_ACTIVE" = "1" ]; then
  USER_MSG="${USER_MSG} (OpenSpec Enabled)"
elif [ "$OPENSPEC_OPTOUT" = "1" ]; then
  USER_MSG="${USER_MSG} (OpenSpec off)"
else
  USER_MSG="${USER_MSG} (OpenSpec off — run \`\$chorus enable openspec\` to set it up)"
fi

hook_output "$USER_MSG" "$CTX" "SessionStart"
