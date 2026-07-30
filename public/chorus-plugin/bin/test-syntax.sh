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

# Point the plugin's GLOBAL state root at a throwaway dir so this test never
# writes into the real ~/.chorus. chorus-paths.sh honors this override.
export CHORUS_PLUGIN_STATE_ROOT="/tmp/chorus-test-$$/global"

cleanup() { rm -rf "$CLAUDE_PROJECT_DIR" "/tmp/chorus-test-$$"; }
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
run_test "on-post-verify-task.sh" '{"tool_input":{"taskUuid":"test-uuid"},"tool_response":{"uuid":"test-uuid","status":"done","title":"Test task"}}'

# --- Session hooks ---
run_test "on-session-start.sh"   '{}'
run_test "on-session-end.sh"     '{}'

# --- User prompt hook ---
run_test "on-user-prompt.sh"     '{}'

# ============================================================================
# Global-state-layout assertions (chorus-paths.sh)
# ============================================================================
echo ""
echo "Global state layout:"

assert_eq() {
  # assert_eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf "  PASS  %s\n" "$1"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s (expected '%s', got '%s')\n" "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
    FAILED="$FAILED assert:$1"
  fi
}

assert_true() {
  # assert_true <label> <condition-cmd...>
  local _label="$1"; shift
  if "$@"; then
    printf "  PASS  %s\n" "$_label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n" "$_label"
    FAIL=$((FAIL + 1))
    FAILED="$FAILED assert:$_label"
  fi
}

# 1. chorus_slug_for_dir encodes an absolute path to a readable slug (not a hash).
SLUG_OUT="$( . "$DIR/chorus-paths.sh" 2>/dev/null; chorus_slug_for_dir "/home/ubuntu/dev/ai-pm" )"
assert_eq "slug encoding /home/ubuntu/dev/ai-pm" "-home-ubuntu-dev-ai-pm" "$SLUG_OUT"

# 2. With a session id, CHORUS_STATE_DIR resolves under the (overridden) global
#    root at <root>/<slug>/<sessionId> — NOT under $CLAUDE_PROJECT_DIR/.chorus.
STATE_WITH_SID="$( export CHORUS_SESSION_ID="sess-xyz"; . "$DIR/chorus-paths.sh" 2>/dev/null; printf '%s' "$CHORUS_STATE_DIR" )"
EXPECT_SLUG="$( . "$DIR/chorus-paths.sh" 2>/dev/null; chorus_slug_for_dir "$CLAUDE_PROJECT_DIR" )"
assert_eq "state dir under global root/<slug>/<sessionId>" \
  "${CHORUS_PLUGIN_STATE_ROOT}/${EXPECT_SLUG}/sess-xyz" "$STATE_WITH_SID"
case "$STATE_WITH_SID" in
  *"/.chorus"*) assert_true "state dir is NOT the per-project .chorus" false ;;
  *)            assert_true "state dir is NOT the per-project .chorus" true ;;
esac

# 3. Missing session id falls back to <slug>/no-session (never empty).
STATE_NO_SID="$( unset CHORUS_SESSION_ID; . "$DIR/chorus-paths.sh" 2>/dev/null; printf '%s' "$CHORUS_STATE_DIR" )"
assert_eq "no session id -> <slug>/no-session" \
  "${CHORUS_PLUGIN_STATE_ROOT}/${EXPECT_SLUG}/no-session" "$STATE_NO_SID"

# 4. A hook that writes state (on-pre-spawn-agent) lands its pending file under
#    the global root, and does NOT create a .chorus/ in the project dir.
printf '%s' '{"session_id":"sess-place","tool_input":{"subagent_type":"general-purpose","name":"placer"}}' \
  | "$BASH" "$DIR/on-pre-spawn-agent.sh" >/dev/null 2>&1 || true
assert_true "pending file written under global root" \
  test -f "${CHORUS_PLUGIN_STATE_ROOT}/${EXPECT_SLUG}/sess-place/pending/placer"
assert_true "no .chorus/ created in project dir" \
  test ! -d "${CLAUDE_PROJECT_DIR}/.chorus"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
