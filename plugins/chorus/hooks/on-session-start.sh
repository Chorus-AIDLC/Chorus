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

# Resolve the active spec mode for this repo, once per session, via the shared
# resolver (single source of truth — identical logic to the Claude Code port).
# It sets SPEC_MODE (lite|openspec|off), SPEC_REASON, SPEC_FAIL (non-empty ⇒ the
# stage skill MUST halt), OPENSPEC_USABLE_REASON, OPENSPEC_HINT, and
# CHORUS_OPENSPEC_ACTIVE (1 only for a usable openspec). Rule: an explicit
# CHORUS_SPEC_MODE wins; when unset, OpenSpec is the default whenever usable
# (openspec/ dir + CLI, not disabled) and lite is the fallback. Codex has no
# project-dir env var, so PROJECT_ROOT defaults to $PWD (Codex hooks run there).
PROJECT_ROOT="$PWD"
# shellcheck source=./resolve-spec-mode.sh
. "${DIR}/resolve-spec-mode.sh"

CTX="# Chorus Plugin — Active (Codex port)

Chorus is connected at ${CHORUS_URL}. MCP tools are available under the \`chorus\` server.

## Checkin

${CHECKIN}

## Spec Mode

CHORUS_SPEC_MODE=${SPEC_MODE} (${SPEC_REASON})"

if [ "$SPEC_MODE" = "lite" ]; then
  CTX="${CTX}

Routing: lite → follow the spec-lite skill (\`~/.codex/skills/spec-lite/SKILL.md\`). A capability's durable spec is \`.chorus/specs/<slug>/spec.md\` (edited in place, **never synced**, git history is its record); each change is a dated folder \`.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/\` of Chorus-typed docs (\`prd.md\` required; \`tech_design.md\` / \`adr.md\` / \`guide.md\` / \`spec.md\` optional) that **are** mirrored 1:1 into persistent Chorus Documents via \`chorus mcp call … --arg-file content=<file>\` (fallback \`chorus-mcp-call.sh\`). Put a \`Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/\` locator line in the proposal description. Do NOT scaffold \`openspec/changes/\` or add an \`OpenSpec change slug:\` line."
elif [ "$SPEC_MODE" = "off" ]; then
  CTX="${CTX}

Routing: off → free-form, no spec artifact. Do NOT create \`.chorus/specs/\` or \`openspec/changes/\` files; author document drafts inline via direct MCP."
elif [ -n "$SPEC_FAIL" ]; then
  CTX="${CTX}

Routing: openspec → **cannot be honored** — ${SPEC_FAIL}. The proposal / yolo skill MUST halt after resolving the mode; do NOT silently fall back to lite/free-form. Surface this to the user."
  if [ -n "$OPENSPEC_HINT" ]; then
    CTX="${CTX} Install hint: ${OPENSPEC_HINT}."
  fi
else
  CTX="${CTX}

CHORUS_OPENSPEC_ACTIVE=1 (${OPENSPEC_USABLE_REASON})

Routing: openspec → load the openspec-aware skill at \`~/.codex/skills/openspec-aware/SKILL.md\` and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.

Critical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST fill \`content\` from the local file — prefer \`chorus mcp call <tool> '<json>' --arg-file content=<file>\`, falling back to \`chorus-mcp-call.sh\` with \`json_encode_file\` when \`chorus\` is not on PATH. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode."
fi

CTX="${CTX}

## Quick Reference

- **Long-horizon work**: follow AI-DLC via the Chorus skill (idea → proposal → task → verify) rather than coding ad hoc, and use chorus_search to locate the specific work the user refers to across ideas/proposals/tasks/docs.
- **Notifications**: \`chorus_get_notifications()\` fetches and auto-marks read.
- **Skills**: use \`\$chorus\`, \`\$idea\`, \`\$proposal\`, \`\$develop\`, \`\$review\`, \`\$quick-dev\`, or \`\$yolo\` to load the stage-specific workflow.
- **Reviewer sub-agents**: mount the reviewer skill explicitly — \`spawn_agent({items:[{type:\"skill\", path:\"chorus:chorus-proposal-reviewer\"}, {type:\"text\", text:\"Review proposal <proposal-uuid> and post VERDICT.\"}]})\` after \`chorus_pm_submit_proposal\`; use \`chorus:chorus-task-reviewer\` with the task UUID after \`chorus_submit_for_verify\`. Wait only when the next gate depends on the verdict, then close the thread; use \`send_input\` for an active child and \`resume_agent\` only for a previously closed one. Routine entity-backed children use fresh context; \`fork_context: true\` is only for material parent-conversation state."

# User-visible status (mirrors the Claude Code hook; Codex skill prefix is $chorus).
USER_MSG="Chorus connected at ${CHORUS_URL}"
if [ -n "$SPEC_FAIL" ]; then
  USER_MSG="${USER_MSG} (Spec: openspec — not usable)"
else
  USER_MSG="${USER_MSG} (Spec: ${SPEC_MODE})"
fi

hook_output "$USER_MSG" "$CTX" "SessionStart"
