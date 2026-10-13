#!/usr/bin/env bash
# trae-event.sh — shared helpers for the TRAE CLI hook copies (sourced).
#
# Why TRAE needs its own parsing (observed on traecli 0.209.1):
#   PostToolUse stdin carries the top-level `tool_response` as a JSON-ENCODED
#   STRING ("{\"content\":[...]}"), not an object, plus a nested
#   `post_tool_use.{tool_name,tool_input,tool_response}` object form. The Codex
#   scripts' `.tool_response.content[0].text` raises a jq error on a string,
#   which aborts the whole filter — including the `.tool_input.*` fallback —
#   so the entity UUID comes back empty. These helpers accept both shapes.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

# trae_event_uuid <EVENT_JSON> <field>
#   Prints the entity UUID for <field> (taskUuid | proposalUuid) from a TRAE
#   (or Codex-shaped) PostToolUse event, or nothing. Resolution order:
#   tool_response text JSON .<field> / .uuid, then tool_input.<field>, then
#   post_tool_use.tool_input.<field>.
trae_event_uuid() {
  local event="${1:-}"
  local field="${2:-}"
  [ -n "$event" ] || return 0
  [ -n "$field" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  printf '%s' "$event" | jq -r --arg f "$field" '
    def decode: if type == "string" then (try fromjson catch null) else . end;
    def as_obj: if type == "object" then . else {} end;
    def text_of: (try (.content[0].text) catch null) // "";
    ((.tool_response | decode) // (.post_tool_use.tool_response | decode)) as $r
    | (if ($r | type) == "object" then ($r | text_of) else "" end) as $t
    | ($t | if type == "string" then (try fromjson catch null) else null end | as_obj) as $tj
    | (.tool_input | as_obj) as $in
    | (.post_tool_use | as_obj | .tool_input | as_obj) as $pin
    | ($tj[$f] // $tj.uuid // $in[$f] // $pin[$f] // empty)
    | if type == "string" then . else empty end
  ' 2>/dev/null || true
}
