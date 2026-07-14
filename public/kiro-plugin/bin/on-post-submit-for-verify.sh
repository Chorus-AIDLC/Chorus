#!/usr/bin/env bash
# on-post-submit-for-verify.sh — Kiro `postToolUse` hook matched to
# @chorus/chorus_submit_for_verify.
#
# Kiro contract: postToolUse delivers {tool_name, tool_input,
# tool_response, ...} on STDIN; on exit 0 the hook's STDOUT is added to
# the agent's context as PLAIN TEXT (no additionalContext JSON envelope).
#
# Behavior: emit a nudge to spawn the read-only `chorus-task-reviewer`
# subagent before admin verification. If the event carries no parseable
# taskUuid -> exit 0 with NO output (no broken nudge).
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

set -euo pipefail

# Config toggle — default enabled (Kiro analog of CC's ENABLETASKREVIEWER).
if [ "${CHORUS_ENABLE_TASK_REVIEWER:-true}" != "true" ]; then
  exit 0
fi

EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi
if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract taskUuid from tool_input; silent exit if missing/unparseable.
TASK_UUID=""
if command -v jq >/dev/null 2>&1; then
  TASK_UUID=$(printf '%s' "$EVENT" | jq -r '.tool_input.taskUuid // empty' 2>/dev/null) || true
fi
if [ -z "$TASK_UUID" ]; then
  exit 0
fi

# Optional task title from tool_response.
TITLE_DISPLAY=""
if command -v jq >/dev/null 2>&1; then
  TASK_TITLE=$(printf '%s' "$EVENT" | jq -r '.tool_response.title // empty' 2>/dev/null) || true
  if [ -n "${TASK_TITLE:-}" ]; then
    TITLE_DISPLAY=" '${TASK_TITLE}'"
  fi
fi

# Max review rounds (0 = unlimited). Kiro analog of CC's
# CLAUDE_PLUGIN_OPTION_MAXTASKREVIEWROUNDS.
MAX_ROUNDS="${CHORUS_MAX_TASK_REVIEW_ROUNDS:-3}"

printf '%s\n' "[Chorus Plugin — Task Submitted for Verification]
Task${TITLE_DISPLAY} (UUID: ${TASK_UUID}) has been submitted for verification.

Max review rounds: ${MAX_ROUNDS} (0 = unlimited).

ACTION REQUIRED: spawn the read-only \`chorus-task-reviewer\` subagent to perform an independent review before admin verification.

In Kiro, hand the reviewer this task (auto-selected by its description; also invokable as /chorus-task-reviewer): \"Review task ${TASK_UUID}. Max review rounds: ${MAX_ROUNDS}. First, read existing comments to count previous VERDICTs and determine your round number. If max > 0 and your round exceeds max, skip the review and post a comment saying the limit was reached — human decision needed. Otherwise, proceed with the review and post your VERDICT as a comment on the task.\"

The reviewer is read-only (tools: read + @chorus) and posts its VERDICT as a comment on the task. After it completes, read comments and act on the most recent \`VERDICT:\` line:
- VERDICT: PASS — all AC verified, no issues. Proceed to mark AC and call chorus_admin_verify_task.
- VERDICT: PASS WITH NOTES — all AC verified, minor non-blocking notes. Still proceed to verify.
- VERDICT: FAIL — BLOCKERs found. Do NOT verify. Reopen the task (chorus_admin_reopen_task) and fix the BLOCKERs.

IMPORTANT: run the reviewer synchronously and wait for its VERDICT before proceeding."

exit 0
