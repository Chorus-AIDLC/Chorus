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

How to spawn (Codex correct syntax — the reviewer is a SKILL, not a built-in agent_type):
  spawn_agent(
    agent_type=\"default\",
    items=[
      { type: \"skill\", name: \"Chorus Proposal Reviewer\", path: \"chorus:chorus-proposal-reviewer\" },
      { type: \"text\",  text: \"Review proposal ${PROPOSAL_UUID:-<uuid>}. Max review rounds: 3. First read existing comments to determine round number; post VERDICT as a comment.\" }
    ]
  )
  wait_agent([reviewer_id])
  close_agent(reviewer_id)    # IMPORTANT: release the thread slot (max 6 concurrent; completed != closed)

Why \`agent_type=\\\"default\\\"\` not \`agent_type=\\\"chorus-proposal-reviewer\\\"\`: Codex 0.125 only ships three built-in roles (default / explorer / worker). Custom review personas are loaded by mounting the skill into a default agent via \`items\`. If \`chorus:chorus-proposal-reviewer\` is rejected, try the namespaced form \`Chorus:chorus-proposal-reviewer\` or look up the exact skill path in the TUI \`/plugins\` panel.

The reviewer is read-only and posts its VERDICT as a comment on the proposal. Read comments after it returns, find the most recent \`VERDICT:\` line:
- **VERDICT: PASS** — No issues. Proceed to \`chorus_admin_approve_proposal\`.
- **VERDICT: PASS WITH NOTES** — Minor notes. Still approve.
- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject with \`chorus_pm_reject_proposal\`, fix, resubmit."

hook_output "" "$CTX" "PostToolUse"
