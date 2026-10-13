#!/usr/bin/env bash
# trae/on-post-submit-proposal.sh — TRAE CLI PostToolUse hook for
# chorus_pm_submit_proposal (fork of hooks/on-post-submit-proposal.sh;
# selected by hooks/run-hook.sh under TRAE).
#
# Differences from the Codex script:
#   - Proposal UUID extraction accepts TRAE's string-encoded `tool_response`
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

PROPOSAL_UUID=$(trae_event_uuid "$EVENT" proposalUuid)

CTX="[Chorus — Proposal Submitted for Review]
Proposal ${PROPOSAL_UUID:-<uuid>} has been submitted.

ACTION REQUIRED: Spawn the \`chorus-proposal-reviewer\` sub-agent to perform an independent quality review before admin approval.

How to spawn (TRAE Agent tool; the sub-agent loads the reviewer skill first):
  Agent({
    description: \"Chorus proposal review\",
    prompt: \"Load the chorus:chorus-proposal-reviewer skill with the Skill tool, then review proposal ${PROPOSAL_UUID:-<uuid>}. Max review rounds: 3. First read existing comments to determine round number; post VERDICT as a comment.\",
    run_in_background: false
  })

This gate depends on the verdict, so run the reviewer in the foreground and wait for it. Routine entity-backed reviewers start from a fresh context; put any material parent-conversation state into the prompt. Use SendMessage to continue an existing reviewer.

The reviewer is read-only and posts its VERDICT as a comment on the proposal. Read comments after it returns and find THIS round's \`VERDICT:\` line — the comment posted after you dispatched the reviewer, not an older round's:
- **VERDICT: PASS** — No issues. Proceed to \`chorus_admin_approve_proposal\`.
- **VERDICT: PASS WITH NOTES** — Minor notes. Still approve.
- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject with \`chorus_pm_reject_proposal\`, fix, resubmit."

hook_output "" "$CTX" "PostToolUse"
