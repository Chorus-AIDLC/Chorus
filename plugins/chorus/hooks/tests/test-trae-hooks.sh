#!/usr/bin/env bash
# test-trae-hooks.sh — TRAE CLI hook copies under hooks/trae/.
#
# Event shapes are modeled on payloads captured from traecli 0.209.1:
#   - "string": top-level tool_response is a JSON-ENCODED STRING (observed for
#     code-mode/nested MCP calls), plus a nested post_tool_use object.
#   - "object": top-level tool_response is an object (direct MCP calls).
# The Codex scripts lose the entity UUID on the string shape (jq errors on
# `.tool_response.content`), which is why the copies exist.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).
set -euo pipefail

HOOKS="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "${HOOKS}/.." && pwd)"
TRAE="${HOOKS}/trae"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); }

mkdir -p "$TMP/home" "$TMP/project" "$TMP/bin"
export HOME="$TMP/home"
unset TRAE_HOME CHORUS_HOOK_RUNTIME CHORUS_AGENT_PROFILE CHORUS_SPEC_MODE CHORUS_OPENSPEC_MODE 2>/dev/null || true
export CHORUS_MCP_NO_CLI=1
export CHORUS_URL="https://chorus.test/api/mcp" CHORUS_API_KEY="cho_test"
export PLUGIN_ROOT="$ROOT"

T=11111111-2222-4333-8444-555555555555
PR=22222222-3333-4444-8555-666666666666
PJ=33333333-4444-4555-8666-777777777777
ID=44444444-5555-4666-8777-888888888888

# Stub MCP: canned responses keyed by tool name, every call logged.
cat > "$TMP/mcp" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "\$1" "\$2" >> "$TMP/mcp.log"
case "\$1" in
  chorus_checkin) printf '{"agent":{"name":"Fixture"},"notifications":{"unread":0}}' ;;
  chorus_get_task) printf '{"uuid":"$T","proposalUuid":"$PR","project":{"uuid":"$PJ"}}' ;;
  chorus_get_proposal) printf '{"uuid":"$PR","inputType":"idea","inputUuids":["$ID"],"description":"x"}' ;;
  chorus_list_tasks) printf '{"total":1,"tasks":[{"uuid":"$T","status":"done"}]}' ;;
  chorus_get_documents) printf '{"total":0,"documents":[]}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/mcp"
export CHORUS_MCP_CALL="$TMP/mcp"

# event <shape> <tool> <field>
event() {
  local shape=$1 tool=$2 field=$3 resp
  resp=$(jq -cn --arg u "$T" '{content:[{type:"text",text:({uuid:$u,status:"ok"}|tojson)}]}')
  if [ "$shape" = string ]; then
    jq -cn --arg tool "mcp__chorus__$tool" --arg f "$field" --arg u "$T" --arg r "$resp" \
      '{hook_event_name:"PostToolUse", tool_name:$tool, tool_input:{($f):$u}, tool_response:$r,
        post_tool_use:{tool_name:$tool, tool_input:{($f):$u}, tool_response:($r|fromjson)}}'
  elif [ "$shape" = string-noinput ]; then
    # UUID only reachable through the string-encoded tool_response.
    jq -cn --arg tool "mcp__chorus__$tool" --arg r "$resp" \
      '{hook_event_name:"PostToolUse", tool_name:$tool, tool_input:{}, tool_response:$r}'
  else
    jq -cn --arg tool "mcp__chorus__$tool" --arg f "$field" --arg u "$T" --argjson r "$resp" \
      '{hook_event_name:"PostToolUse", tool_name:$tool, tool_input:{($f):$u}, tool_response:$r}'
  fi
}

ctx() { jq -r '.hookSpecificOutput.additionalContext // empty'; }

# ---- SessionStart ----------------------------------------------------------
session_start() {
  (cd "$TMP/project" && printf '{"source":"startup","session_id":"s","hook_event_name":"SessionStart"}' |
    bash "$TRAE/on-session-start.sh")
}
assert_session_ctx() {
  local label=$1 out c
  out=$(session_start)
  printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"
    and (.hookSpecificOutput.additionalContext | length <= 5000)' >/dev/null ||
    fail "SessionStart shape/limit ($label)"
  c=$(printf '%s' "$out" | ctx)
  printf '%s' "$c" | grep -Fq '# Chorus Plugin — Active (TRAE port)' || fail "TRAE banner missing ($label)"
  printf '%s' "$c" | grep -Fq '"name":"Fixture"' || fail "checkin not injected ($label)"
  printf '%s' "$c" | grep -Fq '.codex' && fail "Codex skill path leaked ($label)"
  printf '%s' "$c" | grep -Fq 'spawn_agent({' && fail "Codex spawn_agent call leaked ($label)"
  if printf '%s' "$c" | grep -Eq \
    'chorus_create_session|chorus_close_session|chorus_session_|sessionUuid|session management'; then
    fail "session-management guidance in context ($label)"
  fi
  printf '%s' "$c" | grep -Fq "${ROOT}/skills/<name>/SKILL.md" || fail "skill root missing ($label)"
  printf '%s' "$c"
}

c=$(CHORUS_SPEC_MODE=lite assert_session_ctx lite)
printf '%s' "$c" | grep -Fq "\`${ROOT}/skills/spec-lite/SKILL.md\`" || fail "spec-lite path"
[ -f "${ROOT}/skills/spec-lite/SKILL.md" ] || fail "spec-lite skill file missing"
ok

mkdir -p "$TMP/project/openspec"
printf '#!/bin/sh\necho 1.0.0\n' > "$TMP/bin/openspec"; chmod +x "$TMP/bin/openspec"
c=$(PATH="$TMP/bin:$PATH" assert_session_ctx openspec)
printf '%s' "$c" | grep -Fq 'CHORUS_OPENSPEC_ACTIVE=1' || fail "openspec mode not active"
printf '%s' "$c" | grep -Fq "\`${ROOT}/skills/openspec-aware/SKILL.md\`" || fail "openspec-aware path"
[ -f "${ROOT}/skills/openspec-aware/SKILL.md" ] || fail "openspec-aware skill file missing"
ok
rm -rf "$TMP/project/openspec"

out=$(cd "$TMP/project" && env -u CHORUS_URL bash "$TRAE/on-session-start.sh" </dev/null)
printf '%s' "$out" | grep -Fq 'not configured' || fail "unconfigured message"
ok
out=$(cd "$TMP/project" && CHORUS_MCP_CALL=false bash "$TRAE/on-session-start.sh" </dev/null)
printf '%s' "$out" | grep -Fq 'connection failed' || fail "connection-failed message"
ok

# ---- PostToolUse: submit_proposal / submit_for_verify ----------------------
for shape in string string-noinput object; do
  out=$(event "$shape" chorus_pm_submit_proposal proposalUuid | bash "$TRAE/on-post-submit-proposal.sh" | ctx)
  printf '%s' "$out" | grep -Fq "Proposal ${T} has been submitted" || fail "proposal uuid ($shape)"
  printf '%s' "$out" | grep -Fq 'chorus:chorus-proposal-reviewer' || fail "proposal reviewer skill ($shape)"
  printf '%s' "$out" | grep -Fq 'Agent({' || fail "proposal Agent tool ($shape)"
  printf '%s' "$out" | grep -Fq 'spawn_agent' && fail "proposal spawn_agent leaked ($shape)"
  ok

  out=$(event "$shape" chorus_submit_for_verify taskUuid | bash "$TRAE/on-post-submit-for-verify.sh" | ctx)
  printf '%s' "$out" | grep -Fq "Task ${T} has been submitted" || fail "task uuid ($shape)"
  printf '%s' "$out" | grep -Fq 'chorus:chorus-task-reviewer' || fail "task reviewer skill ($shape)"
  printf '%s' "$out" | grep -Fq 'spawn_agent' && fail "task spawn_agent leaked ($shape)"
  ok
done

# Regression evidence: the Codex original loses the UUID on TRAE's string shape.
out=$(event string chorus_submit_for_verify taskUuid | bash "$HOOKS/on-post-submit-for-verify.sh" | ctx)
printf '%s' "$out" | grep -Fq 'Task <uuid> has been submitted' ||
  fail "expected Codex script to miss the UUID on the TRAE string shape"
ok

# Empty stdin still emits the generic reminder (parity with Codex).
out=$(bash "$TRAE/on-post-submit-for-verify.sh" </dev/null | ctx)
printf '%s' "$out" | grep -Fq 'Task <uuid> has been submitted' || fail "empty-event fallback"
ok

# ---- PostToolUse: admin_verify_task ----------------------------------------
for shape in string string-noinput object; do
  : > "$TMP/mcp.log"
  out=$(cd "$TMP/project" && event "$shape" chorus_admin_verify_task taskUuid |
    bash "$TRAE/on-post-verify-task.sh" 2>"$TMP/err" | ctx)
  [ ! -s "$TMP/err" ] || fail "verify-task wrote stderr ($shape): $(cat "$TMP/err")"
  printf '%s' "$out" | grep -Fq 'admin verification to `done`' || fail "literal \`done\` lost ($shape)"
  grep -Fq "chorus_get_task {\"taskUuid\":\"${T}\"}" "$TMP/mcp.log" || fail "verify-task lookup ($shape)"
  printf '%s' "$out" | grep -Fq 'spawn code-reviewer' || fail "code-review branch ($shape)"
  printf '%s' "$out" | grep -Fq "idea ${ID}" || fail "code-review idea uuid ($shape)"
  printf '%s' "$out" | grep -Fq 'chorus:chorus-code-reviewer' || fail "code-reviewer skill ($shape)"
  printf '%s' "$out" | grep -Fq 'spawn_agent' && fail "verify-task spawn_agent leaked ($shape)"
  printf '%s' "$out" | grep -Fq 'create idea-completion report' || fail "report branch ($shape)"
  # Order contract: code review precedes the completion report.
  cr=$(printf '%s\n' "$out" | grep -n 'Code-Review Gateway Trigger' | cut -d: -f1)
  rp=$(printf '%s\n' "$out" | grep -n 'Idea-Completion Report Trigger' | cut -d: -f1)
  [ "$cr" -lt "$rp" ] || fail "branch order ($shape)"
  ok
done

# Not every task done -> silent.
cat > "$TMP/mcp2" <<EOF
#!/usr/bin/env bash
case "\$1" in
  chorus_list_tasks) printf '{"total":2,"tasks":[{"status":"done"},{"status":"in_progress"}]}' ;;
  *) exec "$TMP/mcp" "\$@" ;;
esac
EOF
chmod +x "$TMP/mcp2"
out=$(cd "$TMP/project" && event string chorus_admin_verify_task taskUuid |
  CHORUS_MCP_CALL="$TMP/mcp2" bash "$TRAE/on-post-verify-task.sh")
[ -z "$out" ] || fail "verify-task should be silent while tasks remain"
ok

# No UUID anywhere -> silent, no MCP calls.
: > "$TMP/mcp.log"
out=$(printf '{"hook_event_name":"PostToolUse","tool_input":{},"tool_response":"null"}' |
  bash "$TRAE/on-post-verify-task.sh")
[ -z "$out" ] && [ ! -s "$TMP/mcp.log" ] || fail "verify-task without uuid should be silent"
ok

echo "trae-hooks: ${pass} passed"
