#!/usr/bin/env bash
# on-post-verify-task.sh — Kiro `postToolUse` hook matched to
# @chorus/chorus_admin_verify_task.
#
# Kiro contract: postToolUse delivers {tool_name, tool_input,
# tool_response, ...} on STDIN; on exit 0 the hook's STDOUT is added to
# the agent's context as PLAIN TEXT (no additionalContext JSON envelope).
#
# Behavior (design D5 — code-review gateway): when the just-verified task
# is the LAST task of an idea-rooted proposal, emit a nudge to spawn the
# read-only `chorus-code-reviewer` subagent for the idea's AGGREGATE code
# change (the whole feature across all its tasks). Ported from the
# code-review branch of CC's on-post-verify-task.sh; the CC OpenSpec-archive
# and completion-report branches are out of scope for this hook per D5.
#
# Silent exit 0 (no nudge) when: no parseable taskUuid, the task has no
# proposal (Quick Task), the proposal is not idea-rooted, tasks remain
# non-terminal, or Chorus is unreachable.
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

# Resolve the verified task -> proposalUuid + project.uuid. If the lookup
# fails or there is no proposal (Quick Task), the gateway can't fire.
TASK_JSON=$("$API" mcp-tool chorus_get_task "$(printf '{"taskUuid":"%s"}' "$TASK_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASK_JSON" ]; then
  exit 0
fi

PROPOSAL_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.proposalUuid // empty' 2>/dev/null) || true
PROJECT_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.project.uuid // empty' 2>/dev/null) || true
if [ -z "$PROPOSAL_UUID" ] || [ -z "$PROJECT_UUID" ]; then
  exit 0
fi

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
if [ -z "$IDEA_UUID" ]; then
  exit 0
fi

# All tasks of this proposal must be terminal (done/closed). pageSize=200
# with a total>returned guard so a wide proposal can't fool the gate by
# fitting only terminal tasks on page 1.
TASKS_JSON=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":200}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASKS_JSON" ]; then
  exit 0
fi

TASKS_TOTAL=$(printf '%s' "$TASKS_JSON" | jq -r '.total // 0' 2>/dev/null) || exit 0
TASKS_RETURNED=$(printf '%s' "$TASKS_JSON" | jq -r '(.tasks // []) | length' 2>/dev/null) || exit 0
if [ -n "$TASKS_TOTAL" ] && [ -n "$TASKS_RETURNED" ] && [ "$TASKS_TOTAL" -gt "$TASKS_RETURNED" ]; then
  exit 0
fi
# Defensive: a zero-task proposal can't be "complete" in a meaningful way.
if [ -z "$TASKS_RETURNED" ] || [ "$TASKS_RETURNED" -eq 0 ]; then
  exit 0
fi

NON_TERMINAL_COUNT=$(printf '%s' "$TASKS_JSON" | jq -r '[(.tasks // [])[] | select(.status != "done" and .status != "closed")] | length' 2>/dev/null) || exit 0
if [ "$NON_TERMINAL_COUNT" != "0" ]; then
  exit 0
fi

# Last task of an idea-rooted proposal verified -> emit the gateway nudge.
printf '%s\n' "[Chorus Plugin — Code-Review Gateway]
All tasks of idea-rooted proposal ${PROPOSAL_UUID} are now verified. This is the final ship-time gateway for idea ${IDEA_UUID}.

ACTION REQUESTED: spawn the read-only \`chorus-code-reviewer\` subagent for this idea — an independent review of the idea's AGGREGATE code change (the whole feature across all its tasks), not a single task. It is auto-selected by its description; you can also invoke it as /chorus-code-reviewer.

1. Spawn the code-reviewer synchronously, passing ideaUuid=\"${IDEA_UUID}\" and the review round number (read prior code-review VERDICT comments on the idea to determine it). It reviews cross-task integration, architecture/convention consistency, security, regression/performance, feature-level test coverage, and overall soundness, then posts ONE VERDICT comment on the idea.
2. Read its VERDICT on the idea (chorus_get_comments targetType=\"idea\").
3. VERDICT: PASS / PASS WITH NOTES — the feature may ship.
4. VERDICT: FAIL — create new fix tasks on this approved proposal (chorus_create_tasks) targeting the BLOCKERs; do NOT reopen old tasks. When the fix tasks are done, re-run the code-reviewer (next round).

Run this code-review gateway BEFORE writing any idea-completion report — the report must not be written while a FAIL verdict is outstanding."

exit 0
