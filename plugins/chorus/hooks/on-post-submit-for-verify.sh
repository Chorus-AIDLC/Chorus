#!/usr/bin/env bash
# on-post-submit-for-verify.sh — Codex / TRAE CLI PostToolUse hook for chorus_submit_for_verify.
#
# Shared by both runtimes; hook-runtime.sh picks the sub-agent wording
# (Codex spawn_agent vs TRAE Agent tool) and parses either tool_response shape.
# Bash 3.2 compatible (CLAUDE.md pitfall #10).
#
# Reminds the main agent to spawn chorus-task-reviewer.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./hook-output.sh
source "${DIR}/hook-output.sh"
# shellcheck source=./hook-runtime.sh
source "${DIR}/hook-runtime.sh"
RUNTIME=$(chorus_hook_runtime "$DIR")

EVENT=""
if [ ! -t 0 ]; then EVENT=$(cat); fi

# Extract the UUID from tool_response (object or JSON-encoded string);
# fall back to tool_input / post_tool_use.tool_input.
TASK_UUID=$(chorus_event_uuid "$EVENT" taskUuid)

CTX="[Chorus — Task Submitted for Verification]
Task ${TASK_UUID:-<uuid>} has been submitted for verification.

ACTION REQUIRED: Spawn the \`chorus-task-reviewer\` sub-agent to verify implementation against AC before admin verification."

if [ "$RUNTIME" = "trae" ]; then
  SPAWN="How to spawn (TRAE Agent tool; the sub-agent loads the reviewer skill first):
  Agent({
    description: \"Chorus task review\",
    prompt: \"Load the chorus:chorus-task-reviewer skill with the Skill tool, then review Chorus task ${TASK_UUID:-<uuid>}. Max review rounds: 3. Post VERDICT as a comment.\",
    run_in_background: false
  })

This gate depends on the verdict, so run the reviewer in the foreground and wait for it. Routine entity-backed reviewers start from a fresh context; put any material parent-conversation state into the prompt. Use SendMessage to continue an existing reviewer."
else
  SPAWN="How to spawn (mount the reviewer skill explicitly):
  reviewer = spawn_agent({
    items: [
      { type: \"skill\", name: \"Chorus Task Reviewer\", path: \"chorus:chorus-task-reviewer\" },
      { type: \"text\",  text: \"Review Chorus task ${TASK_UUID:-<uuid>}. Max review rounds: 3. Post VERDICT as a comment.\" }
    ]
  })
  wait_agent({ targets: [reviewer.agent_id] })
  close_agent({ target: reviewer.agent_id })    # completed != closed

This gate depends on the verdict, so wait here. Routine entity-backed reviewers use a fresh context; set \`fork_context: true\` only when material parent-conversation state cannot be conveyed in the text item. Use \`send_input\` for an active reviewer and \`resume_agent\` only for one that was previously closed."
fi

CTX="${CTX}

${SPAWN}

The reviewer is read-only (read-only sandbox) and posts its VERDICT as a comment. After it returns, read THIS round's \`VERDICT:\` comment on the task — the one posted after you dispatched the reviewer, not an older round's. Do not verify or reopen before you have read it:
- **VERDICT: PASS / PASS WITH NOTES** — Mark AC and call \`chorus_admin_verify_task\`.
- **VERDICT: FAIL** — Do NOT verify. Call \`chorus_admin_reopen_task\`, fix BLOCKERs, resubmit."

hook_output "" "$CTX" "PostToolUse"
