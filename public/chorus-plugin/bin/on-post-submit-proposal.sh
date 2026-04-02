#!/usr/bin/env bash
# on-post-submit-proposal.sh — PostToolUse hook for chorus_pm_submit_proposal
# Triggered after a proposal is submitted for review.
# Returns additionalContext instructing the main agent to spawn chorus:proposal-reviewer.

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

CONTEXT="[Chorus Plugin — Proposal Submitted for Review]
Proposal${TITLE_DISPLAY} (UUID: ${PROPOSAL_UUID}) has been submitted.

ACTION REQUIRED: Spawn the \`chorus:proposal-reviewer\` agent to perform an independent quality review before admin approval.

Example:
  Agent({ subagent_type: \"chorus:proposal-reviewer\", prompt: \"Review proposal ${PROPOSAL_UUID}. Fetch the proposal, check document quality, task granularity, AC alignment, and cross-task dependencies. Post your VERDICT as a comment on the proposal.\" })

The reviewer is read-only and will post its VERDICT as a comment on the proposal. The result is advisory — you make the final approval decision.

IMPORTANT: Run the reviewer synchronously (do NOT set run_in_background). Wait for its VERDICT before proceeding with approval."

"$API" hook-output "" "$CONTEXT" "PostToolUse"
