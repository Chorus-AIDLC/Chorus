#!/usr/bin/env bash
# Test all plugin shell scripts for compatibility with the current bash version.
# Runs each script with mock input and mock env to catch runtime errors
# (e.g., ${VAR,,} on Bash 3.2).
#
# Usage:
#   /bin/bash public/chorus-plugin/bin/test-syntax.sh      # test with macOS system bash 3.2
#   bash public/chorus-plugin/bin/test-syntax.sh            # test with default bash

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
FAILED=""

echo "Using: $BASH ($("$BASH" --version | head -1))"
echo ""

# Mock env so scripts don't exit early on env guards.
# Use a bogus URL — scripts will fail on actual API calls but that's fine,
# we only care about bash syntax/substitution errors before the API call.
export CHORUS_URL="http://localhost:0"
export CHORUS_API_KEY="cho_test"
export CLAUDE_PROJECT_DIR="/tmp/chorus-test-$$"
mkdir -p "$CLAUDE_PROJECT_DIR"

cleanup() { rm -rf "$CLAUDE_PROJECT_DIR"; }
trap cleanup EXIT

# Mock event payloads for each hook type
run_test() {
  local name="$1"
  local input="$2"
  local script="$DIR/$name"
  local err_file="/tmp/chorus-test-err-$$"

  # Capture both stdout and stderr; expect exit 0 or exit due to API call failure.
  # We grep stderr for "bad substitution" to detect Bash version issues.
  if printf '%s' "$input" | "$BASH" "$script" >"$err_file" 2>&1; then
    printf "  PASS  %s\n" "$name"
    PASS=$((PASS + 1))
  else
    # Check if it's a bash substitution error vs expected API failure
    if grep -qi "bad substitution\|syntax error\|unexpected token" "$err_file"; then
      printf "  FAIL  %s (bash compatibility error)\n" "$name"
      sed 's/^/         /' "$err_file"
      FAIL=$((FAIL + 1))
      FAILED="$FAILED $name"
    else
      # Non-zero exit from API call / curl failure is expected — not a bash issue
      printf "  PASS  %s (exited non-zero but no bash error)\n" "$name"
      PASS=$((PASS + 1))
    fi
  fi
  rm -f "$err_file"
}

# --- PreToolUse hooks ---
run_test "on-pre-spawn-agent.sh" '{"tool_input":{"subagent_type":"Explore","name":"test"}}'
run_test "on-pre-spawn-agent.sh" '{"tool_input":{"subagent_type":"general-purpose","name":"worker"}}'
run_test "on-pre-enter-plan.sh"  '{}'
run_test "on-pre-exit-plan.sh"   '{}'

# --- Lifecycle hooks (need agent_id/agent_type) ---
run_test "on-subagent-start.sh"  '{"agent_id":"agent-001","agent_type":"Explore"}'
run_test "on-subagent-start.sh"  '{"agent_id":"agent-002","agent_type":"general-purpose"}'
run_test "on-subagent-stop.sh"   '{"agent_id":"agent-001","agent_type":"general-purpose"}'
run_test "on-teammate-idle.sh"   '{"agent_id":"agent-001","agent_type":"general-purpose"}'
run_test "on-task-completed.sh"  '{"task_id":"task-001"}'

# --- PostToolUse hooks ---
run_test "on-post-submit-proposal.sh"  '{"tool_input":{"proposalUuid":"test-uuid"},"tool_response":{"uuid":"test-uuid","status":"pending","title":"Test proposal"}}'
run_test "on-post-submit-for-verify.sh" '{"tool_input":{"taskUuid":"test-uuid"},"tool_response":{"uuid":"test-uuid","status":"to_verify","title":"Test task"}}'

# --- Session hooks ---
run_test "on-session-start.sh"   '{}'
run_test "on-session-end.sh"     '{}'

# --- User prompt hook ---
run_test "on-user-prompt.sh"     '{}'

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
