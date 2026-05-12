#!/usr/bin/env bash
# on-post-verify-task.sh — PostToolUse hook for chorus_admin_verify_task
#
# Detects the "last task verified for an OpenSpec-mode idea" condition and
# injects an additionalContext reminder telling the main agent to run
# `openspec archive <slug>` and mirror the resulting
# openspec/specs/<capability>/spec.md files back to the matching Chorus
# Documents.
#
# Detection contract (all signals must hold to fire):
#   1. CHORUS_OPENSPEC_MODE != "off" — explicit opt-out wins.
#   2. The project root contains an `openspec/` directory — this repo is
#      OpenSpec-init'd. Probed via $CLAUDE_PROJECT_DIR/openspec.
#   3. `openspec` CLI is on PATH — needed for the agent's later
#      `openspec archive` step. Both (2) and (3) are required because
#      either alone leaves the archive workflow unrunnable.
#   4. The verified task's proposal description contains a line matching
#      ^OpenSpec change slug: <slug>$ (slug provenance from §3.5).
#   5. Every task under the same proposal has status === "done".
#
# If any signal fails, the hook exits 0 silently (strict opt-in).
#
# Bash 3.2 compatible (per CLAUDE.md pitfall #10): no ${VAR,,}, no
# ${VAR^^}, no `declare -A`, no `mapfile`, no `readarray`, no `|&`,
# no `&>>`.
#
# All shell variable parsing of captured JSON uses
# `printf '%s' "$VAR" | jq ...` rather than `echo "$VAR" | jq ...` —
# echo corrupts multi-line content on `\n` (canonical §6 warning).

set -euo pipefail

# Check userConfig toggle — default enabled. The same `enableOpenSpec`
# switch gates SessionStart detection; if it's off, we skip the archive
# reminder too. (Env-level CHORUS_OPENSPEC_MODE=off is checked separately
# at step 4 for symmetry with the SessionStart gate.)
if [ "${CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC:-true}" != "true" ]; then
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

# Step 2: Extract taskUuid from .tool_input
TASK_UUID=$(printf '%s' "$EVENT" | jq -r '.tool_input.taskUuid // empty' 2>/dev/null) || true

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
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ ! -d "${PROJECT_ROOT}/openspec" ]; then
  exit 0
fi
if ! command -v openspec >/dev/null 2>&1; then
  exit 0
fi
if ! openspec --version >/dev/null 2>&1; then
  exit 0
fi

# Step 5: chorus_get_task -> proposalUuid
TASK_JSON=$("$API" mcp-tool chorus_get_task "$(printf '{"taskUuid":"%s"}' "$TASK_UUID")" 2>/dev/null) || exit 0
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
PROPOSAL_JSON=$("$API" mcp-tool chorus_get_proposal "$(printf '{"proposalUuid":"%s"}' "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
if [ -z "$PROPOSAL_JSON" ]; then
  exit 0
fi

PROPOSAL_DESC=$(printf '%s' "$PROPOSAL_JSON" | jq -r '.description // empty' 2>/dev/null) || true

# Step 9: grep description for ^OpenSpec change slug: (.+)$ — first match wins
SLUG=""
if [ -n "$PROPOSAL_DESC" ]; then
  # POSIX-portable: print description with embedded newlines via printf %s
  # then grep line-anchored for the slug marker.
  SLUG_LINE=$(printf '%s\n' "$PROPOSAL_DESC" | grep -E '^OpenSpec change slug: .+' | head -1 || true)
  if [ -n "$SLUG_LINE" ]; then
    # Strip the prefix; trim trailing whitespace.
    SLUG=$(printf '%s' "$SLUG_LINE" | sed -e 's/^OpenSpec change slug:[[:space:]]*//' -e 's/[[:space:]]*$//')
  fi
fi

# Step 10: If $SLUG is empty -> exit 0 silently (free-form proposal)
if [ -z "$SLUG" ]; then
  exit 0
fi

# Step 8: chorus_list_tasks (filtered by proposalUuid) -> verify every task is "done".
# (The proposal-design assumed chorus_get_idea returned tasks[], but the
# actual MCP tool only returns IdeaResponse; chorus_list_tasks with the
# proposalUuids filter is the closest equivalent and is the documented
# contract.)
#
# We page through up to 200 tasks (pageSize=200) — far above the design
# expectation of ~10-20 tasks per proposal. If a proposal exceeds 200
# tasks the hook conservatively exits 0 silently, matching the
# Tech Design "Risk: chorus_get_idea is paginated" mitigation.
TASKS_JSON=$("$API" mcp-tool chorus_list_tasks "$(printf '{"projectUuid":"%s","proposalUuids":["%s"],"pageSize":200}' "$PROJECT_UUID" "$PROPOSAL_UUID")" 2>/dev/null) || exit 0
if [ -z "$TASKS_JSON" ]; then
  exit 0
fi

TOTAL_TASKS=$(printf '%s' "$TASKS_JSON" | jq -r '.total // 0' 2>/dev/null) || true
RETURNED_TASKS=$(printf '%s' "$TASKS_JSON" | jq -r '.tasks | length' 2>/dev/null) || true

# Pagination guard: if total exceeds what we fetched, exit silently (better
# safe than fire prematurely).
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

# Step 11: Build CONTEXT — instruct the agent to run `openspec archive <SLUG>`
# and mirror the resulting specs/<capability>/spec.md files back to the
# matching Chorus Documents.
#
# Note on chorus_get_documents: the canonical §3.8 mirror-back step uses
# `chorus_get_documents(projectUuid)` (the only filter the tool supports
# server-side is `type` — there is NO server-side title-prefix filter).
# The agent must list all `type:"spec"` documents and filter client-side
# by title prefix `Spec:` to find the matching capability.

CONTEXT="[Chorus Plugin — OpenSpec Archive Trigger]
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

# Step 12: Inject CONTEXT as additionalContext.
"$API" hook-output "" "$CONTEXT" "PostToolUse"

# Step 13: exit 0 (set -e already enforces this on success).
exit 0
