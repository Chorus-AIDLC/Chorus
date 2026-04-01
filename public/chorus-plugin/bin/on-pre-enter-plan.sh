#!/usr/bin/env bash
# on-pre-enter-plan.sh — PreToolUse hook for EnterPlanMode
# Injects Chorus proposal workflow guidance when Claude enters plan mode.
#
# Output: JSON with additionalContext

set -euo pipefail

# Resolve config: env var > userConfig (CLAUDE_PLUGIN_OPTION_*)
CHORUS_URL="${CHORUS_URL:-${CLAUDE_PLUGIN_OPTION_CHORUS_URL:-}}"
[ -z "$CHORUS_URL" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API="${SCRIPT_DIR}/chorus-api.sh"

CONTEXT="[Chorus Planning Workflow]
When planning implementation, follow the Chorus AI-DLC lifecycle:
1. Identify or create a Chorus Idea for this requirement
2. Create a Proposal with document drafts (PRD) and task drafts
3. Set up task dependency DAG (dependsOnDraftUuids) — frontend depends on backend API, tests depend on both
4. Submit the Proposal for admin approval
5. After approval, tasks materialize and can be claimed/assigned
Do NOT start coding without an approved Chorus Proposal unless working on an already-approved task.

When planning sub-agent work distribution:
- The Chorus Plugin auto-manages session lifecycle — do NOT plan to create sessions manually.
- Plan which Chorus task UUIDs each sub-agent will work on — that is what the prompt needs."

"$API" hook-output "Chorus: plan mode — follow proposal workflow" "$CONTEXT" "PreToolUse"
