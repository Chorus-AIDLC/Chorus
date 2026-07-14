#!/usr/bin/env bash
# Test all Kiro-plugin hook scripts for compatibility with the current bash
# version. Runs each script with a mock Kiro hook event on STDIN and mock
# env to catch runtime errors (e.g. ${VAR,,} bad substitution on Bash 3.2).
#
# Mirrors public/chorus-plugin/bin/test-syntax.sh, adapted to Kiro's hook
# event JSON shape (kiro.dev/docs/cli/hooks): agentSpawn/stop carry base
# fields only; postToolUse carries tool_name + tool_input + tool_response.
#
# Usage:
#   /bin/bash public/kiro-plugin/bin/test-syntax.sh   # test with macOS system bash 3.2
#   bash public/kiro-plugin/bin/test-syntax.sh         # test with default bash

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
FAILED=""

echo "Using: $BASH ($("$BASH" --version | head -1))"
echo ""

# Mock env so scripts don't exit early on env guards. Use a bogus URL —
# scripts will fail on actual API calls but that's fine; we only care about
# bash syntax/substitution errors before the API call.
export CHORUS_URL="http://localhost:0"
export CHORUS_API_KEY="cho_test"
export CLAUDE_PROJECT_DIR="/tmp/kiro-test-$$"
mkdir -p "$CLAUDE_PROJECT_DIR"

cleanup() { rm -rf "$CLAUDE_PROJECT_DIR"; }
trap cleanup EXIT

# First-class syntax parse (`bash -n`) for every *.sh in the dir, including
# chorus-api.sh which is a library (never executed standalone here).
echo "--- bash -n parse check (all *.sh) ---"
for f in "$DIR"/*.sh; do
  base=$(basename "$f")
  if "$BASH" -n "$f" 2>/tmp/kiro-parse-err-$$; then
    printf "  PARSE OK  %s\n" "$base"
  else
    printf "  PARSE FAIL  %s\n" "$base"
    sed 's/^/           /' /tmp/kiro-parse-err-$$
    FAIL=$((FAIL + 1))
    FAILED="$FAILED $base(parse)"
  fi
  rm -f /tmp/kiro-parse-err-$$
done
echo ""

# Run each hook with a mock Kiro event; grep stderr for bash version issues.
run_test() {
  local name="$1"
  local input="$2"
  local script="$DIR/$name"
  local err_file="/tmp/kiro-test-err-$$"

  if printf '%s' "$input" | "$BASH" "$script" >"$err_file" 2>&1; then
    printf "  PASS  %s\n" "$name"
    PASS=$((PASS + 1))
  else
    if grep -qi "bad substitution\|syntax error\|unexpected token" "$err_file"; then
      printf "  FAIL  %s (bash compatibility error)\n" "$name"
      sed 's/^/         /' "$err_file"
      FAIL=$((FAIL + 1))
      FAILED="$FAILED $name"
    else
      # Non-zero exit from an API/curl failure is expected — not a bash issue.
      printf "  PASS  %s (exited non-zero but no bash error)\n" "$name"
      PASS=$((PASS + 1))
    fi
  fi
  rm -f "$err_file"
}

echo "--- runtime smoke tests (mock Kiro events) ---"

# agentSpawn — base fields only.
run_test "on-agent-spawn.sh" '{"hook_event_name":"agentSpawn","cwd":"/tmp","session_id":"sess-1"}'

# stop — base fields + assistant_response.
run_test "on-stop.sh"        '{"hook_event_name":"stop","cwd":"/tmp","session_id":"sess-1","assistant_response":"done"}'

# postToolUse — tool_name + tool_input + tool_response (happy path).
run_test "on-post-submit-proposal.sh"   '{"hook_event_name":"postToolUse","tool_name":"@chorus/chorus_pm_submit_proposal","tool_input":{"proposalUuid":"prop-uuid"},"tool_response":{"success":true,"result":["{\"uuid\":\"prop-uuid\",\"title\":\"Test proposal\"}"]},"title":"Test proposal"}'
run_test "on-post-submit-for-verify.sh" '{"hook_event_name":"postToolUse","tool_name":"@chorus/chorus_submit_for_verify","tool_input":{"taskUuid":"task-uuid"},"tool_response":{"success":true,"result":["ok"]}}'
run_test "on-post-verify-task.sh"       '{"hook_event_name":"postToolUse","tool_name":"@chorus/chorus_admin_verify_task","tool_input":{"taskUuid":"task-uuid"},"tool_response":{"success":true,"result":["ok"]}}'

# postToolUse — no parseable UUID (must exit 0 with no broken nudge).
run_test "on-post-submit-proposal.sh"   '{"hook_event_name":"postToolUse","tool_name":"@chorus/chorus_pm_submit_proposal","tool_input":{}}'
run_test "on-post-submit-for-verify.sh" '{"hook_event_name":"postToolUse","tool_name":"@chorus/chorus_submit_for_verify","tool_input":{}}'
run_test "on-post-verify-task.sh"       '{"hook_event_name":"postToolUse","tool_name":"@chorus/chorus_admin_verify_task","tool_input":{}}'

# Empty STDIN edge case (all hooks must survive).
run_test "on-agent-spawn.sh"            ''
run_test "on-stop.sh"                   ''
run_test "on-post-submit-proposal.sh"   ''
run_test "on-post-submit-for-verify.sh" ''
run_test "on-post-verify-task.sh"       ''

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
