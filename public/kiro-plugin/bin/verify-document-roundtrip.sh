#!/usr/bin/env bash
set -euo pipefail

LOCAL_FILE="${1:?local file required}"
DOCUMENT_UUID="${2:?document UUID required}"
[ -f "$LOCAL_FILE" ] || { echo "round-trip verification: local file not found" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "round-trip verification: jq is required" >&2; exit 2; }

RESPONSE_FILE=$(mktemp)
REMOTE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE" "$REMOTE_FILE"' EXIT
PAYLOAD=$(jq -cn --arg documentUuid "$DOCUMENT_UUID" '{documentUuid: $documentUuid}')

if [ -n "${CHORUS_MCP_CALL_BIN:-}" ]; then
  "$CHORUS_MCP_CALL_BIN" chorus_get_document "$PAYLOAD" >"$RESPONSE_FILE"
else
  chorus-api.sh mcp-tool chorus_get_document "$PAYLOAD" >"$RESPONSE_FILE"
fi

jq -je 'if (.content | type) == "string" then .content else error("top-level .content must be a string") end' \
  "$RESPONSE_FILE" >"$REMOTE_FILE" || { echo "round-trip verification: invalid chorus_get_document response" >&2; exit 3; }
cmp -s "$LOCAL_FILE" "$REMOTE_FILE" && exit 0

hash_file() { command -v sha256sum >/dev/null 2>&1 && sha256sum "$1" | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }
echo "round-trip mismatch:" >&2
echo "  local  bytes=$(wc -c <"$LOCAL_FILE" | tr -d '[:space:]') sha256=$(hash_file "$LOCAL_FILE")" >&2
echo "  remote bytes=$(wc -c <"$REMOTE_FILE" | tr -d '[:space:]') sha256=$(hash_file "$REMOTE_FILE")" >&2
exit 4
