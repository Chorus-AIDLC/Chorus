#!/usr/bin/env bash
# on-stop.sh — Stop hook (fires every assistant turn, main agent only)
# Extracts per-API-call token usage with:
#   - Streaming dedup (collapse consecutive same cache_read runs)
#   - Delta cache_read (cumulative → incremental)
#   - User-boundary round filtering (discard turns in rounds without chorus activity)
# Server replaces previous records for the same sourceSessionId.
# Bash 3.2 compatible.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus"

if [ -z "${CHORUS_URL:-}" ] || [ -z "${CHORUS_API_KEY:-}" ]; then
  exit 0
fi

EVENT=""
if [ ! -t 0 ]; then
  EVENT=$(cat)
fi
if [ -z "$EVENT" ]; then
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

STOP_ACTIVE=$(echo "$EVENT" | jq -r '.stop_hook_active // false' 2>/dev/null) || true
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

TRANSCRIPT_PATH=$(echo "$EVENT" | jq -r '.transcript_path // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$EVENT" | jq -r '.session_id // empty' 2>/dev/null) || true

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ] || [ ! -r "$TRANSCRIPT_PATH" ]; then
  exit 0
fi
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

mkdir -p "$STATE_DIR"

EXTRACT_FILE=$(mktemp "${STATE_DIR}/.extract.XXXXXX")
TURNS_FILE=$(mktemp "${STATE_DIR}/.turns.XXXXXX")
TIMELINE_FILE=$(mktemp "${STATE_DIR}/.timeline.XXXXXX")
PAYLOAD_FILE=$(mktemp "${STATE_DIR}/.payload.XXXXXX")
cleanup() { rm -f "$EXTRACT_FILE" "$TURNS_FILE" "$TIMELINE_FILE" "$PAYLOAD_FILE"; }
trap cleanup EXIT

# Step 1: Single-pass extraction — boundaries, raw turns, timeline.
cat "$TRANSCRIPT_PATH" | jq -cs '{
  boundaries: [.[] | select((.type == "user" or .type == "human") and .timestamp != null) | .timestamp],
  raw_turns: [.[] | select(.type == "assistant" and .message.usage != null) |
   {ts: (.timestamp // null),
    input_tokens: (.message.usage.input_tokens // 0),
    output_tokens: (.message.usage.output_tokens // 0),
    cache_creation_input_tokens: (.message.usage.cache_creation_input_tokens // 0),
    cr: (.message.usage.cache_read_input_tokens // 0)}],
  timeline: [.[] | select(.type == "assistant") |
   .timestamp as $ts |
   (.message.content[]? // empty) |
   select(.type == "tool_use" and (.name | test("chorus"))) |
   .input as $in |
   (if $in.taskUuid then {ts: $ts, entity_type: "task", entity_uuid: $in.taskUuid}
    elif $in.proposalUuid then {ts: $ts, entity_type: "proposal", entity_uuid: $in.proposalUuid}
    elif $in.ideaUuid then {ts: $ts, entity_type: "idea", entity_uuid: $in.ideaUuid}
    elif $in.documentUuid then {ts: $ts, entity_type: "document", entity_uuid: $in.documentUuid}
    else empty end)]
}' > "$EXTRACT_FILE" 2>/dev/null || echo '{"boundaries":[],"raw_turns":[],"timeline":[]}' > "$EXTRACT_FILE"

# Step 2: Dedup streaming chunks + delta cache_read + round filtering.
# Only keep turns in user→assistant rounds that contain chorus tool calls.
jq '
  (.boundaries | sort) as $boundaries |
  .timeline as $timeline |
  (.raw_turns | reduce .[] as $item ([];
    if length == 0 then [$item]
    elif (last.cr == $item.cr) then .[:-1] + [$item]
    else . + [$item]
    end
  ) | . as $d |
  [range(length) | . as $i |
   $d[$i] + {cache_read_input_tokens: ($d[$i].cr - (if $i > 0 then $d[$i-1].cr else 0 end))} |
   del(.cr)] |
  [.[] |
   . as $turn |
   ([$boundaries[] | select(. <= $turn.ts)] | last // "") as $round_start |
   ([$boundaries[] | select(. > $turn.ts)] | first // "Z") as $round_end |
   if ([$timeline[] | select(.ts >= $round_start and .ts < $round_end)] | length > 0) then $turn
   else empty end])
' "$EXTRACT_FILE" > "$TURNS_FILE" 2>/dev/null || echo "[]" > "$TURNS_FILE"

HAS_TURNS=$(jq -r 'length > 0' "$TURNS_FILE" 2>/dev/null) || HAS_TURNS="false"
if [ "$HAS_TURNS" != "true" ]; then
  exit 0
fi

# Step 3: Timeline (extracted in step 1).
jq '.timeline' "$EXTRACT_FILE" > "$TIMELINE_FILE" 2>/dev/null || echo "[]" > "$TIMELINE_FILE"

# Step 4: Build payload.
jq -cn --arg sid "$SESSION_ID" \
  '{sourceSessionId: $sid}' 2>/dev/null | \
  jq --slurpfile turns "$TURNS_FILE" --slurpfile timeline "$TIMELINE_FILE" \
  '. + {turns: $turns[0], timeline: $timeline[0]}' > "$PAYLOAD_FILE" 2>/dev/null

if [ -s "$PAYLOAD_FILE" ]; then
  curl -sS -X POST \
    -H "Authorization: Bearer ${CHORUS_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"$PAYLOAD_FILE" \
    "${CHORUS_URL}/api/agent-report/token-usage" \
    >/dev/null 2>&1 || true
fi
