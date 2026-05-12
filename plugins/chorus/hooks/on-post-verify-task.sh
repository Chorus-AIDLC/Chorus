#!/usr/bin/env bash
# on-post-verify-task.sh — Codex PostToolUse hook for chorus_admin_verify_task.
#
# Mirrors the Claude Code variant at
# public/chorus-plugin/bin/on-post-verify-task.sh: detects "last task
# verified for an OpenSpec-mode idea" and reminds the main agent to
# `openspec archive <slug>` + mirror updated specs back to Chorus
# Documents.
#
# Detection contract (all signals must hold to fire):
#   1. CHORUS_OPENSPEC_MODE != "off" — explicit opt-out wins.
#   2. The project root contains an `openspec/` directory — this repo is
#      OpenSpec-init'd. Probed via $PWD/openspec.
#   3. `openspec` CLI is on PATH — needed for the agent's later
#      `openspec archive` step. Both (2) and (3) are required because
#      either alone leaves the archive workflow unrunnable.
#   4. The verified task's proposal description contains a line matching
#      ^OpenSpec change slug: <slug>$ (slug provenance from §3.5).
#   5. Every task under the same proposal has status === "done".
#
# If any signal fails, the hook exits 0 silently (strict opt-in).
#
# Bash 3.2 compatible (per CLAUDE.md pitfall #10).
#
# All shell variable parsing of captured JSON uses
# `printf '%s' "$VAR" | jq ...` rather than `echo "$VAR" | jq ...` —
# echo corrupts multi-line content on `\n` (canonical §6 warning).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./hook-output.sh
source "${DIR}/hook-output.sh"

MCP="${DIR}/chorus-mcp-call.sh"

# Read event JSON from stdin (PostToolUse hook input)
EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi

if [ -z "$EVENT" ]; then
  exit 0
fi

# Step 2: Extract taskUuid — Codex's tool_response is a content[0].text
# JSON blob; fall back to tool_input.taskUuid (mirrors the existing
# on-post-submit-for-verify.sh pattern).
TASK_UUID=""
if command -v jq >/dev/null 2>&1; then
  TASK_UUID=$(printf '%s' "$EVENT" | jq -r '
    (.tool_response.content[0].text // "") as $t
    | ($t | fromjson? // {}) as $tj
    | ($tj.taskUuid // $tj.uuid // .tool_input.taskUuid // empty)
  ' 2>/dev/null) || true
fi

# Step 3: If taskUuid is empty -> exit 0 silently
if [ -z "$TASK_UUID" ]; then
  exit 0
fi

# Step 4: OpenSpec gate — explicit opt-out, then folder + CLI both required.
# Both folder-presence and CLI-presence are necessary: the agent will run
# `openspec archive <slug>` on receipt of the injected reminder, and that
# command needs the openspec/ working directory AND the CLI on PATH. If
# either is missing, the reminder would point the agent at a dead end, so
# we silently skip injection and let the verify pass through unannotated.
if [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
  exit 0
fi
PROJECT_ROOT="$PWD"
if [ ! -d "${PROJECT_ROOT}/openspec" ]; then
  exit 0
fi
if ! command -v openspec >/dev/null 2>&1; then
  exit 0
fi
if ! openspec --version >/dev/null 2>&1; then
  exit 0
fi

# Step 5: chorus_get_task -> proposalUuid + project.uuid
TASK_JSON=$("$MCP" chorus_get_task "$(printf '{"taskUuid":"%s"}' "$TASK_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASK_JSON" ]; then
  exit 0
fi

PROPOSAL_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.proposalUuid // empty' 2>/dev/null) || true
PROJECT_UUID=$(printf '%s' "$TASK_JSON" | jq -r '.project.uuid // empty' 2>/dev/null) || true

# Step 6: If proposalUuid empty -> exit 0 silently (Quick Tasks have no proposal)
if [ -z "$PROPOSAL_UUID" ]; then
  exit 0
fi

# Step 7: chorus_get_proposal -> description (for slug grep)
PROPOSAL_JSON=$("$MCP" chorus_get_proposal "$(printf '{"proposalUuid":"%s"}' "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
if [ -z "$PROPOSAL_JSON" ]; then
  exit 0
fi

PROPOSAL_DESC=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.description // empty' 2>/dev/null) || true

# Step 9: grep description for ^OpenSpec change slug: (.+)$ — first match wins
SLUG=""
if [ -n "$PROPOSAL_DESC" ]; then
  SLUG_LINE=$(printf '%s\n' "$PROPOSAL_DESC" | grep -E '^OpenSpec change slug: .+' | head -1 || true)
  if [ -n "$SLUG_LINE" ]; then
    SLUG=$(printf '%s' "$SLUG_LINE" | sed -e 's/^OpenSpec change slug:[[:space:]]*//' -e 's/[[:space:]]*$//')
  fi
fi

# Step 10: If $SLUG is empty -> exit 0 silently (free-form proposal)
if [ -z "$SLUG" ]; then
  exit 0
fi

# Step 8: chorus_list_tasks (filtered by proposalUuid) -> verify every task
# is "done". Pagination guard: if total > returned, exit silently.
TASKS_JSON=$("$MCP" chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":200}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASKS_JSON" ]; then
  exit 0
fi

TOTAL_TASKS=$(printf '%s' "$TASKS_JSON" | jq -r '.total // 0' 2>/dev/null) || true
RETURNED_TASKS=$(printf '%s' "$TASKS_JSON" | jq -r '.tasks | length' 2>/dev/null) || true

if [ -n "$TOTAL_TASKS" ] && [ -n "$RETURNED_TASKS" ] && [ "$TOTAL_TASKS" -gt "$RETURNED_TASKS" ]; then
  exit 0
fi

# Defensive: zero-task proposal would otherwise fall through with
# NOT_DONE_COUNT=0. Proposal-submit validation prevents this in practice;
# this guard makes the gate complete.
if [ -z "$RETURNED_TASKS" ] || [ "$RETURNED_TASKS" -eq 0 ]; then
  exit 0
fi

NOT_DONE_COUNT=$(printf '%s' "$TASKS_JSON" | jq -r '[.tasks[] | select(.status != "done")] | length' 2>/dev/null) || true

if [ -z "$NOT_DONE_COUNT" ] || [ "$NOT_DONE_COUNT" != "0" ]; then
  exit 0
fi

# Step 11: Build CONTEXT — instruct the agent to run `openspec archive
# <SLUG>` and mirror the resulting specs back to the matching Chorus
# Documents. (chorus_get_documents only supports projectUuid + type as
# server-side filters — title matching is client-side, canonical §3.8.)

CTX="[Chorus — OpenSpec Archive Trigger]
The last task of OpenSpec-mode proposal ${PROPOSAL_UUID} (slug \`${SLUG}\`) has been admin-verified.

ACTION REQUIRED: archive the OpenSpec change locally and mirror updated specs back to the Chorus Documents. Run the steps below in order; HALT immediately on any error (canonical §6 — no silent errors).

1. Run \`openspec archive ${SLUG}\` in the repo root. This moves \`openspec/changes/${SLUG}/\` under \`openspec/changes/archive/<date>-${SLUG}/\` and emits/updates one \`openspec/specs/<capability>/spec.md\` per capability. If the CLI prompts interactively and a \`--yes\`/\`--no-confirm\` flag is available, use it (verify with \`openspec archive --help\`).

2. For EACH newly-emitted \`openspec/specs/<capability>/spec.md\`:
   - List all spec-type Documents in this project: \`chorus_get_documents({projectUuid: \"${PROJECT_UUID}\", type: \"spec\"})\`. The \`type\` filter is the only server-side filter — do client-side title matching against the documents you get back.
   - Find the Document whose title matches the capability (canonical §3.8 mirror-back contract; typical title shape \`Spec: <capability>\`).
   - Call \`chorus_pm_update_document\` with the new content from the on-disk spec.md.

3. On any error from \`openspec archive\` or \`chorus_pm_update_document\`: print stderr verbatim, post a comment on the proposal recording the failure (\`chorus_add_comment({targetType: \"proposal\", targetUuid: \"${PROPOSAL_UUID}\", content: \"...\"})\`), and HALT. No retry, no silent skip.

4. Confirm success by listing \`openspec/specs/<capability>/spec.md\` files and verifying they round-trip byte-equal (modulo trailing newline) with their Chorus Document counterparts.

References: canonical openspec-aware §3.8 (mirror-back contract), §3.9 (this archive trigger), §6 (no silent errors)."

# Step 12: Inject CTX as additionalContext (Codex hook_output emits the
# JSON envelope expected by Codex hook host).
hook_output "" "$CTX" "PostToolUse"

# Step 13: exit 0
exit 0
