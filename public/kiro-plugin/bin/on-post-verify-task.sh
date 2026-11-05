#!/usr/bin/env bash
# on-post-verify-task.sh — Kiro `postToolUse` hook matched to
# @chorus/chorus_admin_verify_task.
#
# Kiro contract: postToolUse delivers {tool_name, tool_input,
# tool_response, ...} on STDIN; on exit 0 the hook's STDOUT is added to
# the agent's context as PLAIN TEXT (no additionalContext JSON envelope).
#
# Behavior (design D5 — code-review gateway): when the just-verified task
# is the LAST task of an idea, emit a nudge to spawn the read-only
# `chorus-code-reviewer` subagent for the idea's AGGREGATE code change (the
# whole feature across all its tasks). The idea is resolved from the
# proposal's inputUuids[0] (idea-rooted proposal task) or task.ideaUuid
# (proposal-less linked Quick Task); the nudge fires only when the server's
# chorus_get_idea derivedStatus is "done" (union of approved-proposal tasks
# and linked Quick Tasks), so a mixed idea never fires while either side is
# still building. Older servers without derivedStatus fall back to the
# client-side task-count check:
#   - proposal task: every task of THIS proposal terminal AND every Quick
#     Task linked directly to the idea (Task.ideaUuid) terminal;
#   - Quick Task: every Quick Task linked to that idea terminal.
# Ported from the code-review branch of CC's on-post-verify-task.sh; the CC
# OpenSpec-archive and completion-report branches are out of scope for this
# hook per D5.
#
# Silent exit 0 (no nudge) when: no parseable taskUuid, the task has neither
# a proposal nor a linked idea (unlinked Quick Task), the proposal is not
# idea-rooted, tasks remain non-terminal, or Chorus is unreachable.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10). All JSON is parsed with
# `printf '%s' "$VAR" | jq ...` (echo corrupts multi-line JSON on \n).

set -euo pipefail

# Config toggle — default enabled (Kiro analog of CC's ENABLECODEREVIEWER).
if [ "${CHORUS_ENABLE_CODE_REVIEWER:-true}" != "true" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# jq is required to resolve the proposal/task graph; without it we cannot
# safely decide "last task of the idea", so degrade to a silent no-op.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

# Read the event JSON from STDIN.
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi
if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract taskUuid from tool_input; no UUID -> silent exit 0 (no broken nudge).
TASK_UUID=$(printf '%s' "$EVENT" | jq -r '.tool_input.taskUuid // empty' 2>/dev/null) || true
if [ -z "$TASK_UUID" ]; then
  exit 0
fi

# Resolve the verified task -> proposalUuid / ideaUuid + project.uuid. If
# the lookup fails or the task has neither a proposal nor a linked idea
# (unlinked Quick Task), the gateway can't fire.
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

# tasks_all_terminal <tasks_json> <allow_empty: yes|no>
# Succeeds only when the chorus_list_tasks payload is complete (total <=
# returned; pageSize=100 is the MCP maximum, so a wider set fails safe) and
# every task is done/closed. allow_empty=no also fails on an empty list.
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

if [ -n "$PROPOSAL_UUID" ]; then
  # Fetch the proposal — need inputType (idea-rooted only) + the idea UUID.
  PROPOSAL_JSON=$("$API" mcp-tool chorus_get_proposal "$(printf '{"proposalUuid":"%s"}' "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
  if [ -z "$PROPOSAL_JSON" ]; then
    exit 0
  fi

  INPUT_TYPE=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.inputType // empty' 2>/dev/null) || true
  if [ "$INPUT_TYPE" != "idea" ]; then
    exit 0
  fi

  IDEA_UUID=$(printf '%s' "$PROPOSAL_JSON" | jq -r '(.inputUuids // [])[0] // empty' 2>/dev/null) || true
else
  IDEA_UUID="$TASK_IDEA_UUID"
fi
if [ -z "$IDEA_UUID" ]; then
  exit 0
fi

# Server-side completion: the idea's derivedStatus is the single source of
# truth (same computation as the tracker/dashboard). Fire only on "done".
IDEA_JSON=$("$API" mcp-tool chorus_get_idea "$(printf '{"ideaUuid":"%s"}' "$IDEA_UUID")" 2>/dev/null) || IDEA_JSON=""
DERIVED_STATUS=""
if [ -n "$IDEA_JSON" ]; then
  DERIVED_STATUS=$(printf '%s' "$IDEA_JSON" | jq -r '.derivedStatus // empty' 2>/dev/null) || DERIVED_STATUS=""
fi

if [ -n "$DERIVED_STATUS" ]; then
  [ "$DERIVED_STATUS" = "done" ] || exit 0
elif [ -n "$PROPOSAL_UUID" ]; then
  # Legacy fallback (no derivedStatus): all tasks of this proposal must be
  # terminal (zero-task proposal -> skip) ...
  TASKS_JSON=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":100}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
  tasks_all_terminal "$TASKS_JSON" no || exit 0

  # ... and Quick Tasks linked directly to the idea too (none is fine).
  LINKED_JSON=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","ideaUuid":"%s","pageSize":100}' "$PROJECT_UUID" "$IDEA_UUID")" 2>/dev/null) || exit 0
  tasks_all_terminal "$LINKED_JSON" yes || exit 0
else
  # Legacy fallback (no derivedStatus), proposal-less Quick Task: every
  # linked Quick Task must be terminal (the verified task itself is in the
  # list, so an empty list means the read is stale -> skip).
  LINKED_JSON=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","ideaUuid":"%s","pageSize":100}' "$PROJECT_UUID" "$IDEA_UUID")" 2>/dev/null) || exit 0
  tasks_all_terminal "$LINKED_JSON" no || exit 0
fi

if [ -n "$PROPOSAL_UUID" ]; then
  HEADLINE="All tasks of idea-rooted proposal ${PROPOSAL_UUID} (and any Quick Tasks linked to the idea) are now verified. This is the final ship-time gateway for idea ${IDEA_UUID}."
  FIX_TARGET="create new tasks on the original approved proposal"
  REPORT_LINE="Run this code-review gateway BEFORE writing any idea-completion report — the report must not be written while a FAIL verdict is outstanding."
else
  HEADLINE="Every task of idea ${IDEA_UUID} is now verified — its linked Quick Tasks and any approved-proposal tasks. This is the final ship-time gateway for idea ${IDEA_UUID}."
  FIX_TARGET="create new Quick Tasks linked to the idea (chorus_create_tasks with ideaUuid=\"${IDEA_UUID}\")"
  REPORT_LINE="A linked Quick Task closed this idea, so no completion-report reminder follows here. If the idea has no proposal, no idea-completion report applies and the VERDICT comment on the idea is the ship record; if it also has an approved proposal, write that proposal's idea-completion report only after this gateway passes."
fi

# Last task of the idea verified -> emit the gateway nudge.
printf '%s\n' "[Chorus Plugin — Code-Review Gateway]
${HEADLINE}

ACTION REQUESTED: spawn the read-only \`chorus-code-reviewer\` subagent for this idea — an independent review of the idea's AGGREGATE code change (the whole feature across all its tasks), not a single task. It is auto-selected by its description; you can also invoke it as /chorus-code-reviewer.

1. Spawn the code-reviewer and wait for the \`subagent\` call to return, passing ideaUuid=\"${IDEA_UUID}\" and the review round number (read prior code-review VERDICT comments on the idea to determine it). It reviews cross-task integration, architecture/convention consistency, security, regression/performance, feature-level test coverage, and overall soundness, then posts ONE VERDICT comment on the idea.
2. Read THIS round's VERDICT on the idea (chorus_get_comments targetType=\"idea\") — the comment posted after your dispatch, not an earlier round's. The \`subagent\` call's own return value is not the verdict; do not declare the feature shippable before you have read that comment. If it is missing, check what the reviewer did post: a comment reporting the round limit was reached, or any other explicit refusal to review, is a deliberate escalation — STOP: do not respawn, do not self-review, do not post a VERDICT of your own; leave it pending the human's decision. If it posted nothing at all, respawn once and apply this same check again to what the retry posts — an explicit refusal still means STOP; only a second true silence lets you review the idea's aggregate change yourself as a read-only pass and post the VERDICT. Absence is never a PASS.
3. VERDICT: PASS / PASS WITH NOTES — the feature may ship.
4. VERDICT: FAIL — the orchestrator invokes Quick Dev to ${FIX_TARGET}; never reopen completed tasks or apply untracked fixes. Group related small BLOCKERs by default and split only materially large or independently testable fixes.
5. Re-run only after every fix task passes AC self-check, independent task review, and admin verification to done. A failed or cancelled fix stops the loop and escalates. Keep maxCodeReviewRounds authoritative.

${REPORT_LINE}"

exit 0
