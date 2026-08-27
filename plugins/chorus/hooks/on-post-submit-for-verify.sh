#!/usr/bin/env bash
# on-post-submit-for-verify.sh — Codex PostToolUse hook for chorus_submit_for_verify.
#
# Reminds the main agent to spawn chorus-task-reviewer.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./hook-output.sh
source "${DIR}/hook-output.sh"

EVENT=""
if [ ! -t 0 ]; then EVENT=$(cat); fi

TASK_UUID=""
if command -v jq >/dev/null 2>&1 && [ -n "$EVENT" ]; then
  TASK_UUID=$(echo "$EVENT" | jq -r '
    (.tool_response.content[0].text // "") as $t
    | ($t | fromjson? // {}) as $tj
    | ($tj.taskUuid // $tj.uuid // .tool_input.taskUuid // empty)
  ' 2>/dev/null) || true
fi

CTX="[Chorus — Task Submitted for Verification]
Task ${TASK_UUID:-<uuid>} has been submitted for verification.

ACTION REQUIRED: Spawn the \`chorus-task-reviewer\` sub-agent to verify implementation against AC before admin verification.

How to spawn (mount the reviewer skill explicitly):
  reviewer = spawn_agent({
    items: [
      { type: \"skill\", name: \"Chorus Task Reviewer\", path: \"chorus:chorus-task-reviewer\" },
      { type: \"text\",  text: \"Review Chorus task ${TASK_UUID:-<uuid>}. Max review rounds: 3. Post VERDICT as a comment.\" }
    ]
  })
  wait_agent({ targets: [reviewer.agent_id] })
  close_agent({ target: reviewer.agent_id })    # completed != closed

This gate depends on the verdict, so wait here. Routine entity-backed reviewers use a fresh context; set \`fork_context: true\` only when material parent-conversation state cannot be conveyed in the text item. Use \`send_input\` for an active reviewer and \`resume_agent\` only for one that was previously closed.

The reviewer is read-only (read-only sandbox) and posts its VERDICT as a comment. After it returns, read comments:
- **VERDICT: PASS / PASS WITH NOTES** — Mark AC and call \`chorus_admin_verify_task\`.
- **VERDICT: FAIL** — Do NOT verify. Call \`chorus_admin_reopen_task\`, fix BLOCKERs, resubmit."

hook_output "" "$CTX" "PostToolUse"
