#!/usr/bin/env bash
# hook-output.sh — shared helper to emit Codex hook JSON output.
#
# Usage:
#   hook_output "<systemMessage>" "<additionalContext>" "<hookEventName>"

hook_output() {
  local sm="${1:-}"
  local ac="${2:-}"
  local hen="${3:-}"
  if command -v jq >/dev/null 2>&1; then
    if [ -n "$ac" ]; then
      jq -n --arg sm "$sm" --arg ac "$ac" --arg hen "$hen" \
        '{systemMessage:$sm, hookSpecificOutput:{hookEventName:$hen, additionalContext:$ac}}'
    else
      jq -n --arg sm "$sm" '{systemMessage:$sm}'
    fi
  else
    # Fallback: minimal JSON escaping of sm and ac
    local sm_esc="${sm//\\/\\\\}"
    sm_esc="${sm_esc//\"/\\\"}"
    sm_esc="${sm_esc//$'\n'/\\n}"
    if [ -n "$ac" ]; then
      local ac_esc="${ac//\\/\\\\}"
      ac_esc="${ac_esc//\"/\\\"}"
      ac_esc="${ac_esc//$'\n'/\\n}"
      printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
        "$sm_esc" "$hen" "$ac_esc"
    else
      printf '{"systemMessage":"%s"}\n' "$sm_esc"
    fi
  fi
}
