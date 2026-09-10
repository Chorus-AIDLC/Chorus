#!/usr/bin/env bash
# on-post-submit-proposal.sh — Kiro `postToolUse` hook matched to
# @chorus/chorus_pm_submit_proposal.
#
# Kiro contract (kiro.dev/docs/cli/hooks): postToolUse delivers
# {hook_event_name, tool_name, tool_input, tool_response, cwd, session_id}
# on STDIN, and on exit 0 the hook's STDOUT is added to the agent's
# context as PLAIN TEXT. (No hookSpecificOutput/additionalContext JSON
# envelope — that is the difference from the CC on-post-submit-proposal
# hook this is ported from.)
#
# Behavior: emit a nudge to spawn the read-only `chorus-proposal-reviewer`
# subagent before admin approval. If the event carries no parseable
# proposalUuid -> exit 0 with NO output (no broken nudge).
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

set -euo pipefail

# Config toggle — default enabled. CHORUS_ENABLE_PROPOSAL_REVIEWER is the
# Kiro analog of CC's CLAUDE_PLUGIN_OPTION_ENABLEPROPOSALREVIEWER (Kiro has
# no userConfig plumbing, so we read a plain env var).
if [ "${CHORUS_ENABLE_PROPOSAL_REVIEWER:-true}" != "true" ]; then
  exit 0
fi

# Read the event JSON from STDIN.
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi
if [ -z "$EVENT" ]; then
  exit 0
fi

# Extract proposalUuid from tool_input. printf (not echo) preserves
# multi-line JSON. If jq is unavailable or the field is empty -> silent
# exit 0 (no broken nudge).
PROPOSAL_UUID=""
if command -v jq >/dev/null 2>&1; then
  PROPOSAL_UUID=$(printf '%s' "$EVENT" | jq -r '.tool_input.proposalUuid // empty' 2>/dev/null) || true
fi
if [ -z "$PROPOSAL_UUID" ]; then
  exit 0
fi

# Optional proposal title from tool_response for a friendlier nudge.
TITLE_DISPLAY=""
if command -v jq >/dev/null 2>&1; then
  PROPOSAL_TITLE=$(printf '%s' "$EVENT" | jq -r '.tool_response.title // empty' 2>/dev/null) || true
  if [ -n "${PROPOSAL_TITLE:-}" ]; then
    TITLE_DISPLAY=" '${PROPOSAL_TITLE}'"
  fi
fi

# Max review rounds (0 = unlimited). Kiro analog of CC's
# CLAUDE_PLUGIN_OPTION_MAXPROPOSALREVIEWROUNDS.
MAX_ROUNDS="${CHORUS_MAX_PROPOSAL_REVIEW_ROUNDS:-3}"

printf '%s\n' "[Chorus Plugin — Proposal Submitted for Review]
Proposal${TITLE_DISPLAY} (UUID: ${PROPOSAL_UUID}) has been submitted.

Max review rounds: ${MAX_ROUNDS} (0 = unlimited).

ACTION REQUIRED: spawn the read-only \`chorus-proposal-reviewer\` subagent to perform an independent quality review before admin approval.

In Kiro, hand the reviewer this task (it is auto-selected by its description; you can also invoke it as /chorus-proposal-reviewer): \"Review proposal ${PROPOSAL_UUID}. Max review rounds: ${MAX_ROUNDS}. First, read existing comments to count previous VERDICTs and determine your round number. If max > 0 and your round exceeds max, skip the review and post a comment whose first line is exactly REVIEW SKIPPED: round limit reached — human decision needed (this marker tells the main agent to stop rather than substitute its own verdict). Otherwise, proceed with the review and post your VERDICT as a comment on the proposal.\"

The reviewer is read-only (tools: read + @chorus) and posts its VERDICT as a comment on the proposal. Wait for the \`subagent\` call to return, then read this round's \`VERDICT:\` comment with chorus_get_comments — on THIS proposal, posted after you dispatched the reviewer. Do not settle for an older VERDICT from a previous round:
- VERDICT: PASS — no issues. Proceed to approve (chorus_admin_approve_proposal).
- VERDICT: PASS WITH NOTES — minor non-blocking notes. Still proceed to approve.
- VERDICT: FAIL — BLOCKERs found. Do NOT approve. Reject (chorus_pm_reject_proposal), fix the BLOCKERs, and resubmit.

IMPORTANT: the \`subagent\` call's own return value is not the verdict — base the decision on the comment. Do NOT approve or reject before you have read this round's VERDICT comment. If it is missing, check what the reviewer did post: a REVIEW SKIPPED: comment (round limit reached, human decision needed) or any other explicit refusal is a deliberate escalation — STOP: do not respawn, do not self-review, do not post a VERDICT of your own; leave it pending the human's decision. If it posted nothing at all, respawn once; if still absent, review the proposal yourself as a read-only pass and post the VERDICT. Absence is never a PASS."

exit 0
