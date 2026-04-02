#!/usr/bin/env bash
# on-post-submit-for-verify.sh — PostToolUse hook for chorus_submit_for_verify
# Triggered after a task is submitted for verification.
# Returns additionalContext instructing the main agent to spawn chorus:task-reviewer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

# Read event JSON from stdin (PostToolUse hook input)
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract taskUuid from tool_input
TASK_UUID=$(echo "$EVENT" | jq -r '.tool_input.taskUuid // empty' 2>/dev/null) || true

if [ -z "$TASK_UUID" ]; then
  exit 0
fi

# Extract task title from tool_response if available
TASK_TITLE=$(echo "$EVENT" | jq -r '.tool_response.title // empty' 2>/dev/null) || true
TITLE_DISPLAY=""
if [ -n "$TASK_TITLE" ]; then
  TITLE_DISPLAY=" '${TASK_TITLE}'"
fi

CONTEXT="[Chorus Plugin — Task Submitted for Verification]
Task${TITLE_DISPLAY} (UUID: ${TASK_UUID}) has been submitted for verification.

ACTION REQUIRED: Spawn the \`chorus:task-reviewer\` agent to perform an independent review before admin verification.

Example:
  Agent({ subagent_type: \"chorus:task-reviewer\", prompt: \"Review task ${TASK_UUID}. Fetch the task and its AC, read the proposal documents, examine the code, run tests if available. Post your VERDICT as a comment on the task.\" })

The reviewer is read-only and will post its VERDICT as a comment on the task. The result is advisory — the admin makes the final verification decision.

IMPORTANT: Run the reviewer synchronously (do NOT set run_in_background). Wait for its VERDICT before proceeding with admin verification."

"$API" hook-output "" "$CONTEXT" "PostToolUse"
