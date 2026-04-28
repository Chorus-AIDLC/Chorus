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

How to spawn (Codex correct syntax — the reviewer is a SKILL, not a built-in agent_type):
  spawn_agent(
    agent_type=\"default\",
    items=[
      { type: \"skill\", name: \"Chorus Task Reviewer\", path: \"chorus:chorus-task-reviewer\" },
      { type: \"text\",  text: \"Review Chorus task ${TASK_UUID:-<uuid>}. Max review rounds: 3. Post VERDICT as a comment.\" }
    ]
  )
  wait_agent([reviewer_id])
  close_agent(reviewer_id)    # IMPORTANT: release the thread slot (max 6 concurrent; completed != closed)

Why \`agent_type=\\\"default\\\"\` not \`agent_type=\\\"chorus-task-reviewer\\\"\`: Codex 0.125 only ships three built-in roles (default / explorer / worker). Custom review personas are loaded by mounting the skill into a default agent via \`items\`. If \`chorus:chorus-task-reviewer\` is rejected, try the namespaced form \`Chorus:chorus-task-reviewer\` or look up the exact skill path in the TUI \`/plugins\` panel.

The reviewer is read-only (read-only sandbox) and posts its VERDICT as a comment. After it returns, read comments:
- **VERDICT: PASS / PASS WITH NOTES** — Mark AC and call \`chorus_admin_verify_task\`.
- **VERDICT: FAIL** — Do NOT verify. Call \`chorus_admin_reopen_task\`, fix BLOCKERs, resubmit."

hook_output "" "$CTX" "PostToolUse"
