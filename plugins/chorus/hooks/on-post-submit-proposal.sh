#!/usr/bin/env bash
# on-post-submit-proposal.sh — Codex PostToolUse hook for chorus_pm_submit_proposal.
#
# Reminds the main agent to spawn chorus-proposal-reviewer.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./hook-output.sh
source "${DIR}/hook-output.sh"

EVENT=""
if [ ! -t 0 ]; then EVENT=$(cat); fi

# Try to extract proposal UUID from tool_response; fall back to tool_input.
PROPOSAL_UUID=""
if command -v jq >/dev/null 2>&1 && [ -n "$EVENT" ]; then
  PROPOSAL_UUID=$(echo "$EVENT" | jq -r '
    (.tool_response.content[0].text // "") as $t
    | ($t | fromjson? // {}) as $tj
    | ($tj.proposalUuid // $tj.uuid // .tool_input.proposalUuid // empty)
  ' 2>/dev/null) || true
fi

CTX="[Chorus — Proposal Submitted for Review]
Proposal ${PROPOSAL_UUID:-<uuid>} has been submitted.

ACTION REQUIRED: Spawn the \`chorus-proposal-reviewer\` sub-agent to perform an independent quality review before admin approval.

How to spawn (mount the reviewer skill explicitly):
  reviewer = spawn_agent({
    items: [
      { type: \"skill\", name: \"Chorus Proposal Reviewer\", path: \"chorus:chorus-proposal-reviewer\" },
      { type: \"text\",  text: \"Review proposal ${PROPOSAL_UUID:-<uuid>}. Max review rounds: 3. First read existing comments to determine round number; post VERDICT as a comment.\" }
    ]
  })
  wait_agent({ targets: [reviewer.agent_id] })
  close_agent({ target: reviewer.agent_id })    # completed != closed

This gate depends on the verdict, so wait here. Routine entity-backed reviewers use a fresh context; set \`fork_context: true\` only when material parent-conversation state cannot be conveyed in the text item. Use \`send_input\` for an active reviewer and \`resume_agent\` only for one that was previously closed.

The reviewer is read-only and posts its VERDICT as a comment on the proposal. Read comments after it returns, find the most recent \`VERDICT:\` line:
- **VERDICT: PASS** — No issues. Proceed to \`chorus_admin_approve_proposal\`.
- **VERDICT: PASS WITH NOTES** — Minor notes. Still approve.
- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject with \`chorus_pm_reject_proposal\`, fix, resubmit."

hook_output "" "$CTX" "PostToolUse"
