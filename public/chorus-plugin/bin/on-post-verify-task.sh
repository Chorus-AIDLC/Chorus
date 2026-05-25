#!/usr/bin/env bash
# on-post-verify-task.sh — PostToolUse hook for chorus_admin_verify_task
#
# Two independent reminder branches share the post-verify trigger:
#
#   Branch A — OpenSpec archive trigger (legacy)
#     Detects "last task verified for an OpenSpec-mode proposal" and tells
#     the agent to run `openspec archive <slug>` plus mirror updated specs
#     back into Chorus Documents.
#     Gates (all must hold): CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC=true,
#     CHORUS_OPENSPEC_MODE!=off, $CLAUDE_PROJECT_DIR/openspec/ exists,
#     `openspec` CLI on PATH, proposal description matches
#     ^OpenSpec change slug:, every task under that proposal is done.
#
#   Branch B — Idea-completion report reminder
#     Tells the agent to call `chorus_create_report` when this proposal
#     is finished and has no report Document yet. Two checks: all tasks
#     of THIS proposal are done/closed, and THIS proposal has no
#     `type="report"` Document yet. The multi-proposal-per-Idea case is
#     handled by yolo's mandatory end-step, not by this hook.
#
# Each branch is computed independently into its own context variable;
# any non-empty contexts are concatenated and emitted as one
# `additionalContext` payload at the end. Either branch firing on its
# own produces exactly one reminder; both firing produces both reminders
# joined by a blank line.
#
# Branch B is read-only — it never calls `chorus_create_report` or any
# other mutation tool.
#
# Bash 3.2 compatible (per CLAUDE.md pitfall #10): no ${VAR,,}, no
# ${VAR^^}, no `declare -A`, no `mapfile`, no `readarray`, no `|&`,
# no `&>>`.
#
# All shell variable parsing of captured JSON uses
# `printf '%s' "$VAR" | jq ...` rather than `echo "$VAR" | jq ...` —
# echo corrupts multi-line content on `\n` (canonical §6 warning).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# ===== Shared: event parse =====

# Read event JSON from stdin (PostToolUse hook input)
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract taskUuid from .tool_input
TASK_UUID=$(printf '%s' "$EVENT" | jq -r '.tool_input.taskUuid // empty' 2>/dev/null) || true

# If taskUuid is empty -> exit 0 silently
if [ -z "$TASK_UUID" ]; then
  exit 0
fi

# Resolve the verified task once — both branches need proposalUuid +
# project.uuid. If the lookup fails or returns no proposalUuid (Quick
# Tasks), neither branch can fire, so we exit silently.
TASK_JSON=$("$API" mcp-tool chorus_get_task "$(printf '{"taskUuid":"%s"}' "$TASK_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASK_JSON" ]; then
  exit 0
fi

PROPOSAL_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.proposalUuid // empty' 2>/dev/null) || true
PROJECT_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.project.uuid // empty' 2>/dev/null) || true

if [ -z "$PROPOSAL_UUID" ] || [ -z "$PROJECT_UUID" ]; then
  exit 0
fi

# Both branches need the proposal's full record; fetch once.
PROPOSAL_JSON=$("$API" mcp-tool chorus_get_proposal "$(printf '{"proposalUuid":"%s"}' "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
if [ -z "$PROPOSAL_JSON" ]; then
  exit 0
fi

# ===== Branch A: OpenSpec archive trigger =====
#
# Returns the archive-reminder context on stdout when all conditions
# hold; returns empty (silent skip) otherwise. Designed to be captured
# via command substitution: OPENSPEC_CONTEXT=$(branch_openspec_archive)
branch_openspec_archive() {
  # OpenSpec userConfig toggle — default enabled. The same `enableOpenSpec`
  # switch gates SessionStart detection; if it's off, we skip the archive
  # reminder too. (Env-level CHORUS_OPENSPEC_MODE=off is checked separately
  # below for symmetry with the SessionStart gate.)
  if [ "${CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC:-true}" != "true" ]; then
    return 0
  fi

  # OpenSpec gate — explicit opt-out, then folder + CLI both required.
  # Both folder-presence and CLI-presence are necessary: the agent will
  # run `openspec archive <slug>` on receipt of the injected reminder,
  # and that command needs the openspec/ working directory AND the CLI
  # on PATH. If either is missing, the reminder would point the agent
  # at a dead end, so we silently skip injection.
  if [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
    return 0
  fi
  local project_root="${CLAUDE_PROJECT_DIR:-$PWD}"
  if [ ! -d "${project_root}/openspec" ]; then
    return 0
  fi
  if ! command -v openspec >/dev/null 2>&1; then
    return 0
  fi
  if ! openspec --version >/dev/null 2>&1; then
    return 0
  fi

  local proposal_desc
  proposal_desc=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.description // empty' 2>/dev/null) || true

  # grep description for ^OpenSpec change slug: (.+)$ — first match wins
  local slug=""
  if [ -n "$proposal_desc" ]; then
    local slug_line
    slug_line=$(printf '%s\n' "$proposal_desc" | grep -E '^OpenSpec change slug: .+' | head -1 || true)
    if [ -n "$slug_line" ]; then
      slug=$(printf '%s' "$slug_line" | sed -e 's/^OpenSpec change slug:[[:space:]]*//' -e 's/[[:space:]]*$//')
    fi
  fi

  # If slug empty -> silent skip (free-form proposal)
  if [ -z "$slug" ]; then
    return 0
  fi

  # chorus_list_tasks (filtered by proposalUuid) -> verify every task is "done".
  # Pagination guard: if total > returned, exit silently (better safe than
  # fire prematurely). pageSize=200 is far above the design expectation
  # of ~10-20 tasks per proposal.
  local tasks_json
  tasks_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":200}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || return 0
  if [ -z "$tasks_json" ]; then
    return 0
  fi

  local total_tasks returned_tasks
  total_tasks=$(printf '%s' "$tasks_json" | jq -r '.total // 0' 2>/dev/null) || true
  returned_tasks=$(printf '%s' "$tasks_json" | jq -r '.tasks | length' 2>/dev/null) || true

  if [ -n "$total_tasks" ] && [ -n "$returned_tasks" ] && [ "$total_tasks" -gt "$returned_tasks" ]; then
    return 0
  fi

  # Defensive: zero-task proposal would otherwise fall through with
  # not_done_count=0. Proposal-submit validation prevents this in practice;
  # this guard makes the gate complete.
  if [ -z "$returned_tasks" ] || [ "$returned_tasks" -eq 0 ]; then
    return 0
  fi

  local not_done_count
  not_done_count=$(printf '%s' "$tasks_json" | jq -r '[.tasks[] | select(.status != "done")] | length' 2>/dev/null) || true

  if [ -z "$not_done_count" ] || [ "$not_done_count" != "0" ]; then
    return 0
  fi

  # Build the archive reminder. Note on chorus_get_documents: the
  # canonical §3.8 mirror-back step uses chorus_get_documents(projectUuid)
  # — the only filter the tool supports server-side is `type` (no title
  # filter). The agent must list all type:"spec" documents and filter
  # client-side by title prefix `Spec:` to find the matching capability.
  cat <<CTX
[Chorus Plugin — OpenSpec Archive Trigger]
The last task of OpenSpec-mode proposal ${PROPOSAL_UUID} (slug \`${slug}\`) has been admin-verified.

ACTION REQUIRED: archive the OpenSpec change locally and mirror updated specs back to the Chorus Documents. Run the steps below in order; HALT immediately on any error (canonical §6 — no silent errors).

1. Run \`openspec archive ${slug}\` in the repo root. This moves \`openspec/changes/${slug}/\` under \`openspec/changes/archive/<date>-${slug}/\` and emits/updates one \`openspec/specs/<capability>/spec.md\` per capability. If the CLI prompts interactively and a \`--yes\`/\`--no-confirm\` flag is available, use it (verify with \`openspec archive --help\`).

2. For EACH newly-emitted \`openspec/specs/<capability>/spec.md\`:
   - List all spec-type Documents in this project: \`chorus_get_documents({projectUuid: "${PROJECT_UUID}", type: "spec"})\`. The \`type\` filter is the only server-side filter — do client-side title matching against the documents you get back.
   - Find the Document whose title matches the capability (canonical §3.8 mirror-back contract; typical title shape \`Spec: <capability>\`).
   - Call \`chorus_pm_update_document\` with the new content from the on-disk spec.md.

3. On any error from \`openspec archive\` or \`chorus_pm_update_document\`: print stderr verbatim, post a comment on the proposal recording the failure (\`chorus_add_comment({targetType: "proposal", targetUuid: "${PROPOSAL_UUID}", content: "..."})\`), and HALT. No retry, no silent skip.

4. Confirm success by listing \`openspec/specs/<capability>/spec.md\` files and verifying they round-trip byte-equal (modulo trailing newline) with their Chorus Document counterparts.

References: canonical openspec-aware §3.8 (mirror-back contract), §3.9 (this archive trigger), §6 (no silent errors).
CTX
}

# ===== Branch B: Idea-completion report reminder =====
#
# Fires when this Proposal is finished AND has no report Document yet.
# Two checks only:
#   1. all tasks of this proposal in {done, closed}
#   2. no Document with type="report" attached to this proposal
# Read-only — the hook never calls chorus_create_report.
branch_idea_report_reminder() {
  # Only idea-rooted proposals get a completion report.
  local input_type
  input_type=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.inputType // empty' 2>/dev/null) || true
  if [ "$input_type" != "idea" ]; then
    return 0
  fi

  # Check 1: all tasks of this proposal are terminal.
  # pageSize=200 + a total>returned guard so a wide proposal can't fool the
  # check by happening to fit "done" tasks on page 1 while non-terminals
  # remain on later pages. (Same belt-and-suspenders pattern as Branch A.)
  local tasks_json non_terminal_count tasks_total tasks_returned
  tasks_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":200}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || return 0
  [ -n "$tasks_json" ] || return 0
  tasks_total=$(printf '%s' "$tasks_json" | jq -r '.total // 0' 2>/dev/null) || return 0
  tasks_returned=$(printf '%s' "$tasks_json" | jq -r '(.tasks // []) | length' 2>/dev/null) || return 0
  if [ -n "$tasks_total" ] && [ -n "$tasks_returned" ] && [ "$tasks_total" -gt "$tasks_returned" ]; then
    return 0
  fi
  non_terminal_count=$(printf '%s' "$tasks_json" | jq -r '[(.tasks // [])[] | select(.status != "done" and .status != "closed")] | length' 2>/dev/null) || return 0
  [ "$non_terminal_count" = "0" ] || return 0

  # Check 2: no report Document on this proposal yet.
  # chorus_get_documents only filters by type server-side; we do the
  # proposalUuid filter client-side. pageSize=200 + total>returned guard
  # avoids a false "no report" when the proposal's existing report is on
  # a later page in a long-lived project.
  local docs_json existing_report_count docs_total docs_returned
  docs_json=$("$API" mcp-tool chorus_get_documents "$(printf '{"projectUuid":"%s","type":"report","pageSize":200}' "$PROJECT_UUID")" 2>/dev/null) || return 0
  [ -n "$docs_json" ] || return 0
  docs_total=$(printf '%s' "$docs_json" | jq -r '.total // 0' 2>/dev/null) || return 0
  docs_returned=$(printf '%s' "$docs_json" | jq -r '(.documents // []) | length' 2>/dev/null) || return 0
  if [ -n "$docs_total" ] && [ -n "$docs_returned" ] && [ "$docs_total" -gt "$docs_returned" ]; then
    return 0
  fi
  existing_report_count=$(printf '%s' "$docs_json" | jq -r --arg p "$PROPOSAL_UUID" '[(.documents // [])[] | select(.proposalUuid==$p)] | length' 2>/dev/null) || return 0
  [ "$existing_report_count" = "0" ] || return 0

  # Emit the reminder. The literal substring `create idea-completion
  # report` is the contract grep target asserted by both the spec
  # scenarios and the regression test.
  cat <<CTX
[Chorus Plugin — Idea-Completion Report Trigger]
All tasks of proposal ${PROPOSAL_UUID} are now done; no completion report yet.

ACTION REQUESTED: create idea-completion report for this Idea. Call \`chorus_create_report\` with proposalUuid="${PROPOSAL_UUID}". The tool description carries the Summary / Decisions / Follow-ups template.
CTX
}

# ===== Run both branches and emit combined output =====

OPENSPEC_CONTEXT=$(branch_openspec_archive || true)
REPORT_CONTEXT=$(branch_idea_report_reminder || true)

COMBINED=""
if [ -n "$OPENSPEC_CONTEXT" ] && [ -n "$REPORT_CONTEXT" ]; then
  # Two reminders — separate them with a blank line.
  COMBINED="${OPENSPEC_CONTEXT}

${REPORT_CONTEXT}"
elif [ -n "$OPENSPEC_CONTEXT" ]; then
  COMBINED="$OPENSPEC_CONTEXT"
elif [ -n "$REPORT_CONTEXT" ]; then
  COMBINED="$REPORT_CONTEXT"
fi

if [ -n "$COMBINED" ]; then
  "$API" hook-output "" "$COMBINED" "PostToolUse"
fi

exit 0
