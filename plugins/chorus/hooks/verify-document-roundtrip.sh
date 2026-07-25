#!/usr/bin/env bash
# Verify a local file against a Chorus Document without normalizing bytes.

set -euo pipefail

LOCAL_FILE="${1:?local file required}"
DOCUMENT_UUID="${2:?document UUID required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_CALL="${CHORUS_MCP_CALL_BIN:-$SCRIPT_DIR/chorus-mcp-call.sh}"

[ -f "$LOCAL_FILE" ] || {
  echo "round-trip verification: local file not found: $LOCAL_FILE" >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  echo "round-trip verification: jq is required" >&2
  exit 2
}

RESPONSE_FILE=$(mktemp)
REMOTE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE" "$REMOTE_FILE"' EXIT

PAYLOAD=$(jq -cn --arg documentUuid "$DOCUMENT_UUID" '{documentUuid: $documentUuid}')
"$MCP_CALL" chorus_get_document "$PAYLOAD" >"$RESPONSE_FILE"

if ! jq -je 'if (.content | type) == "string" then .content else error("top-level .content must be a string") end' \
  "$RESPONSE_FILE" >"$REMOTE_FILE"; then
  echo "round-trip verification: invalid chorus_get_document response" >&2
  exit 3
fi

if cmp -s "$LOCAL_FILE" "$REMOTE_FILE"; then
  exit 0
fi

byte_count() {
  wc -c <"$1" | tr -d '[:space:]'
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

echo "round-trip mismatch:" >&2
echo "  local  bytes=$(byte_count "$LOCAL_FILE") sha256=$(sha256 "$LOCAL_FILE")" >&2
echo "  remote bytes=$(byte_count "$REMOTE_FILE") sha256=$(sha256 "$REMOTE_FILE")" >&2
exit 4
