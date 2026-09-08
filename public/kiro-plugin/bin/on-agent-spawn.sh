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

# Resolve the active spec mode via the shared resolver (single source of truth —
# byte-identical to the Claude Code / Codex copies; enforced by the CI drift-guard).
# It sets SPEC_MODE (lite|openspec|off), SPEC_REASON, SPEC_FAIL (non-empty ⇒ the
# stage skill MUST halt), OPENSPEC_USABLE_REASON, OPENSPEC_HINT, CHORUS_OPENSPEC_ACTIVE.
# Kiro delivers cwd in the event JSON; use it as PROJECT_ROOT (fallback $PWD).
CWD_FROM_EVENT=$(printf '%s' "$EVENT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
PROJECT_ROOT="${CWD_FROM_EVENT:-$PWD}"
# shellcheck source=./resolve-spec-mode.sh
. "${SCRIPT_DIR}/resolve-spec-mode.sh"

# Emit the startup context as plain text (Kiro adds STDOUT to context).
# The checkin payload carries agent owner, effective permissions, the
# active-project distribution, and working-style guidance — surfaced verbatim,
# same as the CC hook.
CONTEXT="# Chorus Plugin — Active

Chorus is connected at ${CHORUS_URL}. Session lifecycle hooks are enabled (checkin on spawn, best-effort heartbeat/checkout on stop, reviewer nudges after workflow MCP calls).

## Checkin

${CHECKIN_RESULT}

## Spec Mode

CHORUS_SPEC_MODE=${SPEC_MODE} (${SPEC_REASON})"

if [ "$SPEC_MODE" = "lite" ]; then
  CONTEXT="${CONTEXT}

Routing: lite → follow the spec-lite skill (/chorus-spec-lite). A capability's durable spec is \`.chorus/specs/<slug>/spec.md\` (edited in place, **never synced**, git history is its record); each change is a dated folder \`.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/\` of Chorus-typed docs (\`prd.md\` required; \`tech_design.md\`/\`adr.md\`/\`guide.md\`/\`spec.md\` optional) that **are** mirrored 1:1 into persistent Chorus Documents via \`chorus mcp call … --arg-file content=<file>\` (fallback \`chorus-api.sh mcp-tool\`). Put a \`Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/\` locator line in the proposal description. Do NOT scaffold \`openspec/changes/\` or add an \`OpenSpec change slug:\` line."
elif [ "$SPEC_MODE" = "off" ]; then
  CONTEXT="${CONTEXT}

Routing: off → free-form, no spec artifact. Do NOT create \`.chorus/specs/\` or \`openspec/changes/\` files; author document drafts inline via direct MCP."
elif [ -n "$SPEC_FAIL" ]; then
  CONTEXT="${CONTEXT}

Routing: openspec → **cannot be honored** — ${SPEC_FAIL}. The proposal / yolo skill MUST halt after resolving the mode; do NOT silently fall back. Surface this to the user."
  if [ -n "$OPENSPEC_HINT" ]; then
    CONTEXT="${CONTEXT} Install hint: ${OPENSPEC_HINT}."
  fi
else
  CONTEXT="${CONTEXT}

CHORUS_OPENSPEC_ACTIVE=1 (${OPENSPEC_USABLE_REASON})

Routing: openspec → load the openspec-aware skill (/chorus-openspec-aware) and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.

Critical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST fill \`content\` from the local file — prefer \`chorus mcp call <tool> '<json>' --arg-file content=<file>\`, falling back to \`chorus-api.sh mcp-tool\` with \`json_encode_file\` when \`chorus\` is not on PATH. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode."
fi

CONTEXT="${CONTEXT}

## Quick Reference

- **Long-horizon work**: follow AI-DLC via the Chorus skill (idea → proposal → task → verify) rather than coding ad hoc, and use chorus_search to locate the specific work the user refers to across ideas/proposals/tasks/docs.
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
