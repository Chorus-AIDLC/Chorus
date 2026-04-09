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
  Agent({ subagent_type: \"chorus:proposal-reviewer\", prompt: \"Review proposal ${PROPOSAL_UUID}. Max review rounds: ${MAX_ROUNDS}. First, read existing comments to count previous VERDICTs and determine your round number. If max > 0 and your round exceeds max, skip the review and post a comment saying the limit was reached — human decision needed. Otherwise, proceed with review. Post your VERDICT as a comment on the proposal.\" })

The reviewer is read-only and will post its VERDICT as a comment on the proposal. The result is advisory — you make the final approval decision.

IMPORTANT: Run the reviewer synchronously (do NOT set run_in_background). Wait for its VERDICT before proceeding with approval."

"$API" hook-output "" "$CONTEXT" "PostToolUse"
