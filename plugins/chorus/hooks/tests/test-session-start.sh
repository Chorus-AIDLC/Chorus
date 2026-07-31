#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/mcp" <<'EOF'
#!/usr/bin/env bash
printf '{"agent":{"name":"Fixture"},"notifications":{"unread":0}}'
EOF
chmod +x "$TMP/mcp"

export CHORUS_URL="https://chorus.test/api/mcp"
export CHORUS_API_KEY="cho_test"
export CHORUS_MCP_CALL="$TMP/mcp"
mkdir -p "$TMP/project/openspec"

for source in startup resume clear compact; do
  output=$(cd "$TMP/project" && printf '{"source":"%s","session_id":"root-a"}' "$source" | \
    bash "$DIR/on-session-start.sh")
  printf '%s' "$output" | jq -e \
    '.hookSpecificOutput.hookEventName == "SessionStart"
     and (.hookSpecificOutput.additionalContext | contains("# Chorus Plugin"))
     and (.hookSpecificOutput.additionalContext | length < 12000)' >/dev/null
  count=$(printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext' | grep -c '^# Chorus Plugin')
  [ "$count" = "1" ]
done

echo "session-start: 4 passed"
