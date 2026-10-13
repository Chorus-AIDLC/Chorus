#!/usr/bin/env bash
# trae/on-post-submit-for-verify.sh — TRAE CLI PostToolUse hook for
# chorus_submit_for_verify (fork of hooks/on-post-submit-for-verify.sh;
# selected by hooks/run-hook.sh under TRAE).
#
# Differences from the Codex script:
#   - Task UUID extraction accepts TRAE's string-encoded `tool_response`
#     (see trae-event.sh); the Codex filter returns empty on TRAE.
#   - Reviewer spawn guidance uses TRAE's Agent tool (no spawn_agent).
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

set -euo pipefail

TRAE_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "${TRAE_DIR}/.." && pwd)"
# shellcheck source=../hook-output.sh
source "${DIR}/hook-output.sh"
# shellcheck source=./trae-event.sh
source "${TRAE_DIR}/trae-event.sh"

EVENT=""
if [ ! -t 0 ]; then EVENT=$(cat); fi

TASK_UUID=$(trae_event_uuid "$EVENT" taskUuid)

CTX="[Chorus — Task Submitted for Verification]
Task ${TASK_UUID:-<uuid>} has been submitted for verification.

ACTION REQUIRED: Spawn the \`chorus-task-reviewer\` sub-agent to verify implementation against AC before admin verification.

How to spawn (TRAE Agent tool; the sub-agent loads the reviewer skill first):
  Agent({
    description: \"Chorus task review\",
    prompt: \"Load the chorus:chorus-task-reviewer skill with the Skill tool, then review Chorus task ${TASK_UUID:-<uuid>}. Max review rounds: 3. Post VERDICT as a comment.\",
    run_in_background: false
  })

This gate depends on the verdict, so run the reviewer in the foreground and wait for it. Routine entity-backed reviewers start from a fresh context; put any material parent-conversation state into the prompt. Use SendMessage to continue an existing reviewer.

The reviewer is read-only and posts its VERDICT as a comment. After it returns, read THIS round's \`VERDICT:\` comment on the task — the one posted after you dispatched the reviewer, not an older round's. Do not verify or reopen before you have read it:
- **VERDICT: PASS / PASS WITH NOTES** — Mark AC and call \`chorus_admin_verify_task\`.
- **VERDICT: FAIL** — Do NOT verify. Call \`chorus_admin_reopen_task\`, fix BLOCKERs, resubmit."

hook_output "" "$CTX" "PostToolUse"
