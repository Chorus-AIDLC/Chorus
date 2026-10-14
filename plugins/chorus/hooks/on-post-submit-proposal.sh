#!/usr/bin/env bash
# on-post-submit-proposal.sh — Codex / TRAE CLI PostToolUse hook for chorus_pm_submit_proposal.
#
# Shared by both runtimes; hook-runtime.sh picks the sub-agent wording
# (Codex spawn_agent vs TRAE Agent tool) and parses either tool_response shape.
# Bash 3.2 compatible (CLAUDE.md pitfall #10).
#
# Reminds the main agent to spawn chorus-proposal-reviewer.

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
PROPOSAL_UUID=$(chorus_event_uuid "$EVENT" proposalUuid)

CTX="[Chorus — Proposal Submitted for Review]
Proposal ${PROPOSAL_UUID:-<uuid>} has been submitted.

ACTION REQUIRED: Spawn the \`chorus-proposal-reviewer\` sub-agent to perform an independent quality review before admin approval."

if [ "$RUNTIME" = "trae" ]; then
  SPAWN="How to spawn (TRAE Agent tool; the sub-agent loads the reviewer skill first):
  Agent({
    description: \"Chorus proposal review\",
    prompt: \"Load the chorus:chorus-proposal-reviewer skill with the Skill tool, then review proposal ${PROPOSAL_UUID:-<uuid>}. Max review rounds: 3. First read existing comments to determine round number; post VERDICT as a comment.\",
    run_in_background: false
  })

This gate depends on the verdict, so run the reviewer in the foreground and wait for it. Routine entity-backed reviewers start from a fresh context; put any material parent-conversation state into the prompt. Use SendMessage to continue an existing reviewer."
else
  SPAWN="How to spawn (mount the reviewer skill explicitly):
  reviewer = spawn_agent({
    items: [
      { type: \"skill\", name: \"Chorus Proposal Reviewer\", path: \"chorus:chorus-proposal-reviewer\" },
      { type: \"text\",  text: \"Review proposal ${PROPOSAL_UUID:-<uuid>}. Max review rounds: 3. First read existing comments to determine round number; post VERDICT as a comment.\" }
    ]
  })
  wait_agent({ targets: [reviewer.agent_id] })
  close_agent({ target: reviewer.agent_id })    # completed != closed

This gate depends on the verdict, so wait here. Routine entity-backed reviewers use a fresh context; set \`fork_context: true\` only when material parent-conversation state cannot be conveyed in the text item. Use \`send_input\` for an active reviewer and \`resume_agent\` only for one that was previously closed."
fi

CTX="${CTX}

${SPAWN}

The reviewer is read-only and posts its VERDICT as a comment on the proposal. Read comments after it returns and find THIS round's \`VERDICT:\` line — the comment posted after you dispatched the reviewer, not an older round's:
- **VERDICT: PASS** — No issues. Proceed to \`chorus_admin_approve_proposal\`.
- **VERDICT: PASS WITH NOTES** — Minor notes. Still approve.
- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject with \`chorus_pm_reject_proposal\`, fix, resubmit."

hook_output "" "$CTX" "PostToolUse"
