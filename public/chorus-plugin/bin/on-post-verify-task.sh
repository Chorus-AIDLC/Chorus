#!/usr/bin/env bash
# on-post-verify-task.sh — PostToolUse hook for chorus_admin_verify_task
#
# Three independent reminder branches share the post-verify trigger:
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
#   Branch C — Code-review gateway reminder
#     Tells the agent to spawn the code-reviewer for the idea — the final
#     ship-time review of the idea's AGGREGATE code change (the whole
#     feature across all its tasks). Gates: CLAUDE_PLUGIN_OPTION_
#     ENABLECODEREVIEWER=true (default), the task resolves to an idea
#     (proposal inputType=="idea" -> inputUuids[0], or a proposal-less
#     Quick Task's ideaUuid), and the server's chorus_get_idea
#     derivedStatus is "done" (union of approved-proposal and linked Quick
#     Tasks). Older servers without derivedStatus fall back to the
#     client-side task-count check (proposal tasks + linked Quick Tasks
#     done/closed).
#     Read-only — emits a reminder only.
#
#   Branch B — Idea-completion report reminder
#     Tells the agent to call `chorus_create_report` when this proposal
#     is finished and has no report Document yet. Two checks: all tasks
#     of THIS proposal are done/closed, and THIS proposal has no
#     `type="report"` Document yet. The multi-proposal-per-Idea case is
#     handled by yolo's mandatory end-step, not by this hook.
#
# Branches A and B are proposal-only: a linked Quick Task (no
# proposalUuid) can only trigger Branch C.
#
# Each branch is computed independently into its own context variable;
# any non-empty contexts are concatenated and emitted as one
# `additionalContext` payload at the end, in order [A archive][C code
# review][B completion report] — code review precedes the completion
# report (the report must not be written while a code-review FAIL is
# outstanding). Any single branch firing alone produces exactly one
# reminder; multiple firing are joined by blank lines.
#
# Branches B and C are read-only — they never call a mutation tool; they
# only inject a reminder.
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

# Export the CC session id so chorus-api.sh's mcp-tool calls write their handshake
# temp files under this session's global state partition (not a no-session bucket).
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID

# Extract taskUuid from .tool_input
TASK_UUID=$(printf '%s' "$EVENT" | jq -r '.tool_input.taskUuid // empty' 2>/dev/null) || true

# If taskUuid is empty -> exit 0 silently
if [ -z "$TASK_UUID" ]; then
  exit 0
fi

# Resolve the verified task once — every branch needs project.uuid plus
# either proposalUuid (Branches A/B/C) or ideaUuid (Branch C for a Quick
# Task linked directly to an idea). If the lookup fails, or the task has
# neither (an unlinked Quick Task), no branch can fire: exit silently.
TASK_JSON=$("$API" mcp-tool chorus_get_task "$(printf '{"taskUuid":"%s"}' "$TASK_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASK_JSON" ]; then
  exit 0
fi

PROPOSAL_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.proposalUuid // empty' 2>/dev/null) || true
PROJECT_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.project.uuid // empty' 2>/dev/null) || true
TASK_IDEA_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.ideaUuid // empty' 2>/dev/null) || true

if [ -z "$PROJECT_UUID" ]; then
  exit 0
fi
if [ -z "$PROPOSAL_UUID" ] && [ -z "$TASK_IDEA_UUID" ]; then
  exit 0
fi

# Proposal tasks: every branch needs the proposal's full record; fetch once.
# Linked Quick Tasks have no proposal — PROPOSAL_JSON stays empty and only
# Branch C runs.
PROPOSAL_JSON=""
if [ -n "$PROPOSAL_UUID" ]; then
  PROPOSAL_JSON=$("$API" mcp-tool chorus_get_proposal "$(printf '{"proposalUuid":"%s"}' "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
  if [ -z "$PROPOSAL_JSON" ]; then
    exit 0
  fi
fi

# ===== Shared: task-list terminal check =====
#
# tasks_all_terminal <tasks_json> <allow_empty: yes|no>
# Succeeds (exit 0) only when the chorus_list_tasks payload is complete
# (total <= returned — pageSize=100 is the MCP maximum, so a wider set
# fails safe) and every task is done/closed. allow_empty=no also fails on
# an empty list.
tasks_all_terminal() {
  local tj="$1" allow_empty="$2" total returned non_terminal
  [ -n "$tj" ] || return 1
  total=$(printf '%s' "$tj" | jq -r '.total // 0' 2>/dev/null) || return 1
  returned=$(printf '%s' "$tj" | jq -r '(.tasks // []) | length' 2>/dev/null) || return 1
  [ -n "$total" ] && [ -n "$returned" ] || return 1
  if [ "$total" -gt "$returned" ]; then
    return 1
  fi
  if [ "$returned" -eq 0 ] && [ "$allow_empty" != "yes" ]; then
    return 1
  fi
  non_terminal=$(printf '%s' "$tj" | jq -r '[(.tasks // [])[] | select(.status != "done" and .status != "closed")] | length' 2>/dev/null) || return 1
  [ "$non_terminal" = "0" ]
}

# ===== Branch A: OpenSpec archive trigger =====
#
# Returns the archive-reminder context on stdout when all conditions
# hold; returns empty (silent skip) otherwise. Designed to be captured
# via command substitution: OPENSPEC_CONTEXT=$(branch_openspec_archive)
branch_openspec_archive() {
  # Proposal-only branch.
  [ -n "$PROPOSAL_UUID" ] || return 0

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
  # fire prematurely). pageSize=100 (the MCP maximum) is far above the design expectation
  # of ~10-20 tasks per proposal.
  local tasks_json
  tasks_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":100}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || return 0
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

4. Confirm each updated spec with \`verify-document-roundtrip.sh <local-spec-path> <document-uuid>\`; do not use recursive \`jq\`, \`head\`, command substitution, or newline normalization.

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
  # Proposal-only branch (chorus_create_report needs a proposalUuid).
  [ -n "$PROPOSAL_UUID" ] || return 0

  # Only idea-rooted proposals get a completion report.
  local input_type
  input_type=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.inputType // empty' 2>/dev/null) || true
  if [ "$input_type" != "idea" ]; then
    return 0
  fi

  # Check 1: all tasks of this proposal are terminal.
  # pageSize=100 (the MCP maximum) + a total>returned guard so a wide proposal can't fool the
  # check by happening to fit "done" tasks on page 1 while non-terminals
  # remain on later pages. (Same belt-and-suspenders pattern as Branch A.)
  local tasks_json non_terminal_count tasks_total tasks_returned
  tasks_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":100}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || return 0
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
  # proposalUuid filter client-side. pageSize=100 (the MCP maximum) + total>returned guard
  # avoids a false "no report" when the proposal's existing report is on
  # a later page in a long-lived project.
  local docs_json existing_report_count docs_total docs_returned
  docs_json=$("$API" mcp-tool chorus_get_documents "$(printf '{"projectUuid":"%s","type":"report","pageSize":100}' "$PROJECT_UUID")" 2>/dev/null) || return 0
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

ACTION REQUESTED: create idea-completion report for this Idea. Call \`chorus_create_report\` with proposalUuid="${PROPOSAL_UUID}". The \`content\` parameter's description carries the Summary / Decisions / Follow-ups template.
CTX
}

# ===== Branch C: Code-review gateway reminder =====
#
# Fires when the last task of an idea is verified and the code-reviewer is
# enabled. Tells the agent to spawn the code-reviewer for the idea — the
# final ship-time review of the idea's AGGREGATE code change (the whole
# feature across all its tasks), not a single task.
# The idea is resolved from the proposal's inputUuids[0] (proposal task of
# an idea-rooted proposal, inputType=="idea") or from task.ideaUuid
# (proposal-less Quick Task linked to an idea). Completion is decided by the
# SERVER: chorus_get_idea's derivedStatus (union of approved-proposal tasks
# and linked Quick Tasks) must be "done" — so a mixed idea never fires while
# either side is still building, whichever task finishes first. Only when
# derivedStatus is absent (older server / idea read failed) does the legacy
# client-side task-count check apply:
#   - proposal task: every task of THIS proposal terminal AND every Quick
#     Task linked directly to the idea (chorus_list_tasks ideaUuid) terminal;
#   - Quick Task: every Quick Task linked to that idea terminal.
# Read-only — emits a reminder only; never posts a comment or mutates.
# Gated by enableCodeReviewer (default true), parallel to how Branch A
# gates on enableOpenSpec.
branch_code_review() {
  # Config toggle — default enabled.
  if [ "${CLAUDE_PLUGIN_OPTION_ENABLECODEREVIEWER:-true}" != "true" ]; then
    return 0
  fi

  local idea_uuid tasks_json linked_json idea_json derived_status
  if [ -n "$PROPOSAL_UUID" ]; then
    # Only idea-rooted proposals get a code-review gateway.
    local input_type
    input_type=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.inputType // empty' 2>/dev/null) || true
    if [ "$input_type" != "idea" ]; then
      return 0
    fi

    # Resolve the idea UUID from the proposal's inputUuids (first idea).
    idea_uuid=$(printf '%s' "$PROPOSAL_JSON" | jq -r '(.inputUuids // [])[0] // empty' 2>/dev/null) || true
  else
    idea_uuid="$TASK_IDEA_UUID"
  fi
  if [ -z "$idea_uuid" ]; then
    return 0
  fi

  # Server-side completion: the idea's derivedStatus is the single source of
  # truth (same computation as the tracker/dashboard). Fire only on "done".
  idea_json=$("$API" mcp-tool chorus_get_idea "$(printf '{"ideaUuid":"%s"}' "$idea_uuid")" 2>/dev/null) || idea_json=""
  derived_status=""
  if [ -n "$idea_json" ]; then
    derived_status=$(printf '%s' "$idea_json" | jq -r '.derivedStatus // empty' 2>/dev/null) || derived_status=""
  fi

  if [ -n "$derived_status" ]; then
    [ "$derived_status" = "done" ] || return 0
  elif [ -n "$PROPOSAL_UUID" ]; then
    # Legacy fallback (no derivedStatus): all tasks of this proposal must be
    # terminal (zero-task proposal -> skip) ...
    tasks_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":100}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || return 0
    tasks_all_terminal "$tasks_json" no || return 0

    # ... and Quick Tasks linked directly to the idea too (none is fine).
    linked_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","ideaUuid":"%s","pageSize":100}' "$PROJECT_UUID" "$idea_uuid")" 2>/dev/null) || return 0
    tasks_all_terminal "$linked_json" yes || return 0
  else
    # Legacy fallback (no derivedStatus), proposal-less Quick Task: every
    # linked Quick Task must be terminal (the verified task itself is in the
    # list, so an empty list means the read is stale -> skip).
    linked_json=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","ideaUuid":"%s","pageSize":100}' "$PROJECT_UUID" "$idea_uuid")" 2>/dev/null) || return 0
    tasks_all_terminal "$linked_json" no || return 0
  fi

  # Scope-specific wording: headline, where FAIL fix tasks go, and whether a
  # completion report follows (proposal-only).
  local headline fix_target report_line
  if [ -n "$PROPOSAL_UUID" ]; then
    headline="All tasks of idea-rooted proposal ${PROPOSAL_UUID} (and any Quick Tasks linked to the idea) are now done. This is the final ship-time gateway for idea ${idea_uuid}."
    fix_target="create new tasks on the original approved proposal"
    report_line="Run the code-review gateway BEFORE writing any idea-completion report — the report must not be written while a FAIL verdict is outstanding."
  else
    headline="Every task of idea ${idea_uuid} is now done — its linked Quick Tasks and any approved-proposal tasks. This is the final ship-time gateway for idea ${idea_uuid}."
    fix_target="create new Quick Tasks linked to the idea (chorus_create_tasks with ideaUuid=\"${idea_uuid}\")"
    report_line="A linked Quick Task closed this idea, so no completion-report reminder follows here. If the idea has no proposal, no idea-completion report applies and the VERDICT comment on the idea is the ship record; if it also has an approved proposal, write that proposal's idea-completion report only after this gateway passes."
  fi

  # Emit the reminder. The literal substring `spawn code-reviewer` is the
  # contract grep target asserted by the regression test.
  cat <<CTX
[Chorus Plugin — Code-Review Gateway Trigger]
${headline}

ACTION REQUESTED: spawn code-reviewer for this idea — an independent, read-only review of the idea's AGGREGATE code change (the whole feature across all its tasks), not a single task.

1. Spawn the code-reviewer and wait for its completion notification, passing it ideaUuid="${idea_uuid}" and the review round number (read prior code-review verdict comments on the idea to determine it). It reviews cross-task integration, architecture/convention consistency, security, regression/performance, feature-level test coverage, and overall code soundness, then posts ONE VERDICT comment on the idea.
2. Read THIS round's VERDICT on the idea (chorus_get_comments targetType="idea") — the comment posted after your dispatch, not an earlier round's. The launch result is not the verdict; do not declare the feature shippable before you have read that comment. If it is missing, check what the reviewer did post: a comment reporting the round limit was reached, or any other explicit refusal to review, is a deliberate escalation — STOP: do not respawn, do not self-review, do not post a VERDICT of your own; leave it pending the human's decision. If it posted nothing at all, respawn once and apply this same check again to what the retry posts — an explicit refusal still means STOP; only a second true silence lets you review the idea's aggregate change yourself as a read-only pass and post the VERDICT. Absence is never a PASS.
3. PASS / PASS WITH NOTES -> the feature may ship.
4. FAIL -> the orchestrator invokes Quick Dev to ${fix_target}; never reopen completed tasks or apply untracked fixes. Group related small BLOCKERs by default and split only materially large or independently testable fixes.
5. Re-run only after every fix task passes AC self-check, independent task review, and admin verification to done. A failed or cancelled fix stops the loop and escalates. Keep maxCodeReviewRounds authoritative.

${report_line}
CTX
}

# ===== Run all branches and emit combined output =====

OPENSPEC_CONTEXT=$(branch_openspec_archive || true)
CODEREVIEW_CONTEXT=$(branch_code_review || true)
REPORT_CONTEXT=$(branch_idea_report_reminder || true)

# Join any non-empty reminders with a blank-line separator, in order
# [OpenSpec archive][code review][completion report] — code review
# precedes the completion report (the report must not be written while a
# code-review FAIL is outstanding).
COMBINED=""
append_context() {
  [ -n "$1" ] || return 0
  if [ -n "$COMBINED" ]; then
    COMBINED="${COMBINED}

$1"
  else
    COMBINED="$1"
  fi
}
append_context "$OPENSPEC_CONTEXT"
append_context "$CODEREVIEW_CONTEXT"
append_context "$REPORT_CONTEXT"

if [ -n "$COMBINED" ]; then
  "$API" hook-output "" "$COMBINED" "PostToolUse"
fi

exit 0
