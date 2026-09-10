#!/usr/bin/env bash
# on-post-submit-proposal.sh — PostToolUse hook for chorus_pm_submit_proposal
# Triggered after a proposal is submitted for review.
# Returns additionalContext instructing the main agent to spawn chorus:proposal-reviewer.

set -euo pipefail

# Check userConfig toggle — default enabled
if [ "${CLAUDE_PLUGIN_OPTION_ENABLEPROPOSALREVIEWER:-true}" != "true" ]; then
  exit 0
fi

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

# Extract proposalUuid from tool_input
PROPOSAL_UUID=$(echo "$EVENT" | jq -r '.tool_input.proposalUuid // empty' 2>/dev/null) || true

if [ -z "$PROPOSAL_UUID" ]; then
  exit 0
fi

# Extract proposal title from tool_response if available
PROPOSAL_TITLE=$(echo "$EVENT" | jq -r '.tool_response.title // empty' 2>/dev/null) || true
TITLE_DISPLAY=""
if [ -n "$PROPOSAL_TITLE" ]; then
  TITLE_DISPLAY=" '${PROPOSAL_TITLE}'"
fi

# Max rounds config (0 = unlimited)
MAX_ROUNDS="${CLAUDE_PLUGIN_OPTION_MAXPROPOSALREVIEWROUNDS:-3}"

CONTEXT="[Chorus Plugin — Proposal Submitted for Review]
Proposal${TITLE_DISPLAY} (UUID: ${PROPOSAL_UUID}) has been submitted.

Max review rounds: ${MAX_ROUNDS} (0 = unlimited).

ACTION REQUIRED: Spawn the \`chorus:proposal-reviewer\` agent to perform an independent quality review before admin approval.

Example:
  Agent({ subagent_type: \"chorus:proposal-reviewer\", prompt: \"Review proposal ${PROPOSAL_UUID}. Max review rounds: ${MAX_ROUNDS}. First, read existing comments to count previous VERDICTs and determine your round number. If max > 0 and your round exceeds max, skip the review and post a comment whose first line is exactly REVIEW SKIPPED: round limit reached — human decision needed (this marker tells the main agent to stop rather than substitute its own verdict). Otherwise, proceed with review. Post your VERDICT as a comment on the proposal.\" })

The reviewer is read-only and will post its VERDICT as a comment on the proposal.

Wait for the reviewer to complete (its completion notification), then read this round's \`VERDICT:\` comment with chorus_get_comments — on THIS proposal, posted after you dispatched the reviewer. Do not settle for an older VERDICT from a previous round:
- **VERDICT: PASS** — No issues found. Proceed to approve (chorus_admin_approve_proposal).
- **VERDICT: PASS WITH NOTES** — Minor non-blocking notes. Still proceed to approve.
- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject the proposal (chorus_pm_reject_proposal), fix BLOCKERs, and resubmit.

IMPORTANT: the launch result is not the verdict — these reviewer subagent types report an async launch regardless of the flag you pass. Do NOT approve or reject before you have read this round's VERDICT comment. If it is missing, check what the reviewer did post: a REVIEW SKIPPED: comment (round limit reached, human decision needed) or any other explicit refusal is a deliberate escalation — STOP: do not respawn, do not self-review, do not post a VERDICT of your own; leave it pending the human's decision. If it posted nothing at all, respawn once; if still absent, review the proposal yourself as a read-only pass and post the VERDICT. Absence is never a PASS."

"$API" hook-output "" "$CONTEXT" "PostToolUse"
