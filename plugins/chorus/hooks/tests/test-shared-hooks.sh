#!/usr/bin/env bash
# test-shared-hooks.sh — the hooks/*.sh scripts shared by Codex CLI and TRAE CLI.
#
#   1. Runtime detection (hooks/hook-runtime.sh chorus_hook_runtime): Codex is
#      the default; TRAE is selected when the plugin root (PLUGIN_ROOT, or the
#      hooks dir's parent when unset) resolves under
#      ${TRAE_HOME:-$HOME/.trae}/plugins/ (symlinks resolved);
#      CHORUS_HOOK_RUNTIME=codex|trae forces the choice.
#   2. SessionStart under both runtimes: banner, skill routing via
#      $PLUGIN_ROOT/skills/<name>/SKILL.md (files exist), runtime wording.
#   3. PostToolUse hooks under both runtimes and every tool_response shape seen
#      on Codex / traecli 0.209.1:
#        - "object":         tool_response is an object (Codex; TRAE direct calls)
#        - "string":         tool_response is a JSON-ENCODED STRING (TRAE
#                            code-mode / nested calls) + nested post_tool_use
#        - "string-noinput": UUID only reachable through the encoded string
#        - "nested-only":    UUID only in post_tool_use.tool_input
#   4. on-post-verify-task.sh emits no stderr (the literal `done` in its
#      heredoc used to run as a command -> bash syntax error) and keeps the
#      code-review-before-report order.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).
set -euo pipefail

HOOKS="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "${HOOKS}/.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); }

# Hermetic env: no ambient TRAE install, no CLI profile/creds leakage.
mkdir -p "$TMP/home" "$TMP/project" "$TMP/bin"
export HOME="$TMP/home"
unset TRAE_HOME CODEX_HOME CHORUS_HOOK_RUNTIME CHORUS_AGENT_PROFILE CHORUS_SPEC_MODE CHORUS_OPENSPEC_MODE 2>/dev/null || true
export CHORUS_MCP_NO_CLI=1
export CHORUS_URL="https://chorus.test/api/mcp" CHORUS_API_KEY="cho_test"

T=11111111-2222-4333-8444-555555555555
PR=22222222-3333-4444-8555-666666666666
PJ=33333333-4444-4555-8666-777777777777
ID=44444444-5555-4666-8777-888888888888

# Stub MCP: canned responses keyed by tool name, every call logged.
cat > "$TMP/mcp" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "\$1" "\$2" >> "$TMP/mcp.log"
# The Chorus MCP rejects pageSize > 100 (server-side zod max), like the real server.
if printf '%s' "\$2" | jq -e '(.pageSize // 0) > 100' >/dev/null 2>&1; then exit 1; fi
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

# Simulated installs of the SAME package under each CLI's plugin cache.
CODEX_ROOT="$TMP/home/.codex/plugins/cache/chorus-plugins/chorus/0.0.0"
TRAE_REAL="$TMP/trae-home"
TRAE_ROOT="$TRAE_REAL/plugins/cache/chorus-plugins/chorus/0.0.0"
mkdir -p "$(dirname "$CODEX_ROOT")" "$(dirname "$TRAE_ROOT")"
cp -R "$ROOT" "$CODEX_ROOT"
cp -R "$ROOT" "$TRAE_ROOT"
# traecli exports PLUGIN_ROOT canonical while ~/.trae may be a symlink.
ln -s "$TRAE_REAL" "$TMP/home/.trae"

# ---- 1. Runtime detection --------------------------------------------------
runtime() {
  # runtime <hooks-dir> [PLUGIN_ROOT|-]
  local dir=$1 root=${2:--}
  (
    # shellcheck source=../hook-runtime.sh
    . "$HOOKS/hook-runtime.sh"
    if [ "$root" = "-" ]; then unset PLUGIN_ROOT; else export PLUGIN_ROOT="$root"; fi
    chorus_hook_runtime "$dir"
  )
}
[ "$(runtime "$ROOT/hooks" "$ROOT")" = codex ] || fail "repo checkout should be codex"; ok
[ "$(runtime "$CODEX_ROOT/hooks" "$CODEX_ROOT")" = codex ] || fail "codex install with TRAE also present"; ok
[ "$(runtime "$CODEX_ROOT/hooks")" = codex ] || fail "codex install, PLUGIN_ROOT unset"; ok
[ "$(runtime "$TRAE_ROOT/hooks" "$TRAE_ROOT")" = trae ] || fail "trae via default ~/.trae symlink"; ok
[ "$(runtime "$TRAE_ROOT/hooks")" = trae ] || fail "trae, PLUGIN_ROOT unset (hooks dir parent)"; ok
[ "$(TRAE_HOME="$TRAE_REAL" runtime "$TRAE_ROOT/hooks" "$TRAE_ROOT")" = trae ] || fail "trae, explicit TRAE_HOME"; ok
[ "$(TRAE_HOME="$TMP/elsewhere" runtime "$TRAE_ROOT/hooks" "$TRAE_ROOT")" = codex ] || fail "TRAE_HOME elsewhere must not match"; ok
[ "$(HOME= runtime "$TRAE_ROOT/hooks" "$TRAE_ROOT")" = codex ] || fail "no HOME/TRAE_HOME -> codex"; ok
[ "$(CHORUS_HOOK_RUNTIME=codex runtime "$TRAE_ROOT/hooks" "$TRAE_ROOT")" = codex ] || fail "override codex"; ok
[ "$(CHORUS_HOOK_RUNTIME=trae runtime "$ROOT/hooks" "$ROOT")" = trae ] || fail "override trae"; ok

# ---- 2. SessionStart -------------------------------------------------------
ctx() { jq -r '.hookSpecificOutput.additionalContext // empty'; }

# session_ctx <runtime> -> context on stdout (asserts the shared contract)
session_ctx() {
  local rt=$1 root out c
  if [ "$rt" = trae ]; then root=$TRAE_ROOT; else root=$CODEX_ROOT; fi
  out=$(cd "$TMP/project" && printf '{"source":"startup","session_id":"s","hook_event_name":"SessionStart"}' |
    PLUGIN_ROOT="$root" bash "$root/hooks/on-session-start.sh")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"
    and (.hookSpecificOutput.additionalContext | length <= 5000)' >/dev/null ||
    fail "SessionStart shape/limit ($rt)"
  c=$(printf '%s' "$out" | ctx)
  printf '%s' "$c" | grep -Fq '"name":"Fixture"' || fail "checkin not injected ($rt)"
  printf '%s' "$c" | grep -Fq '.codex/skills' && fail "stale ~/.codex/skills path ($rt)"
  if printf '%s' "$c" | grep -Eq \
    'chorus_create_session|chorus_close_session|chorus_session_|sessionUuid|session management'; then
    fail "session-management guidance in context ($rt)"
  fi
  if [ "$rt" = trae ]; then
    printf '%s' "$c" | grep -Fq '# Chorus Plugin — Active (TRAE port)' || fail "TRAE banner"
    printf '%s' "$c" | grep -Fq 'spawn_agent({' && fail "Codex spawn_agent call leaked (trae)"
    printf '%s' "$c" | grep -Fq 'Agent({' || fail "TRAE Agent tool wording"
    printf '%s' "$c" | grep -Fq "${root}/skills/<name>/SKILL.md" || fail "skill root (trae)"
  else
    printf '%s' "$c" | grep -Fq '# Chorus Plugin — Active (Codex port)' || fail "Codex banner"
    printf '%s' "$c" | grep -Fq 'TRAE' && fail "TRAE wording leaked (codex)"
    printf '%s' "$c" | grep -Fq 'spawn_agent({items:' || fail "Codex spawn_agent wording"
    printf '%s' "$c" | grep -Fq 'fork_context: true' || fail "Codex fork_context wording"
    if printf '%s' "$c" | grep -Eq 'type: ?\\?"skill\\?", ?path:'; then fail "skill item without name (session)"; fi
  fi
  printf '%s' "$c"
}

for rt in codex trae; do
  if [ "$rt" = trae ]; then root=$TRAE_ROOT; else root=$CODEX_ROOT; fi
  c=$(CHORUS_SPEC_MODE=lite session_ctx "$rt")
  printf '%s' "$c" | grep -Fq "\`${root}/skills/spec-lite/SKILL.md\`" || fail "spec-lite path ($rt)"
  [ -f "${root}/skills/spec-lite/SKILL.md" ] || fail "spec-lite skill file missing ($rt)"
  ok

  mkdir -p "$TMP/project/openspec"
  printf '#!/bin/sh\necho 1.0.0\n' > "$TMP/bin/openspec"; chmod +x "$TMP/bin/openspec"
  c=$(PATH="$TMP/bin:$PATH" session_ctx "$rt")
  printf '%s' "$c" | grep -Fq 'CHORUS_OPENSPEC_ACTIVE=1' || fail "openspec mode not active ($rt)"
  printf '%s' "$c" | grep -Fq "\`${root}/skills/openspec-aware/SKILL.md\`" || fail "openspec-aware path ($rt)"
  [ -f "${root}/skills/openspec-aware/SKILL.md" ] || fail "openspec-aware skill file missing ($rt)"
  rm -rf "$TMP/project/openspec"
  ok

  out=$(cd "$TMP/project" && env -u CHORUS_URL PLUGIN_ROOT="$root" bash "$root/hooks/on-session-start.sh" </dev/null)
  printf '%s' "$out" | grep -Fq 'not configured' || fail "unconfigured message ($rt)"
  ok
  out=$(cd "$TMP/project" && CHORUS_MCP_CALL=false PLUGIN_ROOT="$root" bash "$root/hooks/on-session-start.sh" </dev/null)
  printf '%s' "$out" | grep -Fq 'connection failed' || fail "connection-failed message ($rt)"
  ok
done

# PLUGIN_ROOT unset -> skills resolve from the script's own plugin root.
c=$(cd "$TMP/project" && env -u PLUGIN_ROOT CHORUS_SPEC_MODE=lite bash "$CODEX_ROOT/hooks/on-session-start.sh" </dev/null | ctx)
printf '%s' "$c" | grep -Fq "\`${CODEX_ROOT}/skills/spec-lite/SKILL.md\`" || fail "skill root fallback"
ok

# ---- 3. PostToolUse: submit_proposal / submit_for_verify -------------------
# event <shape> <tool> <field>
event() {
  local shape=$1 tool=$2 field=$3 resp
  resp=$(jq -cn --arg u "$T" '{content:[{type:"text",text:({uuid:$u,status:"ok"}|tojson)}]}')
  case "$shape" in
    string)
      jq -cn --arg tool "mcp__chorus__$tool" --arg f "$field" --arg u "$T" --arg r "$resp" \
        '{hook_event_name:"PostToolUse", tool_name:$tool, tool_input:{($f):$u}, tool_response:$r,
          post_tool_use:{tool_name:$tool, tool_input:{($f):$u}, tool_response:($r|fromjson)}}' ;;
    string-noinput)
      jq -cn --arg tool "mcp__chorus__$tool" --arg r "$resp" \
        '{hook_event_name:"PostToolUse", tool_name:$tool, tool_input:{}, tool_response:$r}' ;;
    nested-only)
      jq -cn --arg tool "mcp__chorus__$tool" --arg f "$field" --arg u "$T" \
        '{hook_event_name:"PostToolUse", tool_name:$tool, tool_response:"not json",
          post_tool_use:{tool_name:$tool, tool_input:{($f):$u}}}' ;;
    *)
      jq -cn --arg tool "mcp__chorus__$tool" --arg f "$field" --arg u "$T" --argjson r "$resp" \
        '{hook_event_name:"PostToolUse", tool_name:$tool, tool_input:{($f):$u}, tool_response:$r}' ;;
  esac
}

# assert_spawn_wording <runtime> <text> <label>
assert_spawn_wording() {
  if [ "$1" = trae ]; then
    printf '%s' "$2" | grep -Fq 'Agent({' || fail "TRAE Agent tool ($3)"
    printf '%s' "$2" | grep -Fq 'spawn_agent' && fail "spawn_agent leaked under TRAE ($3)"
  else
    printf '%s' "$2" | grep -Fq 'spawn_agent(' || fail "Codex spawn_agent ($3)"
    # Codex 0.162.1 rejects a spawn_agent skill item without `name`.
    if printf '%s' "$2" | grep -Eq 'type: ?\\?"skill\\?", ?path:'; then fail "skill item without name ($3)"; fi
    printf '%s' "$2" | grep -Fq 'TRAE' && fail "TRAE wording leaked under Codex ($3)"
  fi
  return 0
}

for rt in codex trae; do
  if [ "$rt" = trae ]; then root=$TRAE_ROOT; else root=$CODEX_ROOT; fi
  export PLUGIN_ROOT="$root"
  for shape in object string string-noinput nested-only; do
    out=$(event "$shape" chorus_pm_submit_proposal proposalUuid | bash "$root/hooks/on-post-submit-proposal.sh" | ctx)
    printf '%s' "$out" | grep -Fq "Proposal ${T} has been submitted" || fail "proposal uuid ($rt/$shape)"
    printf '%s' "$out" | grep -Fq "review proposal ${T}" || printf '%s' "$out" | grep -Fq "Review proposal ${T}" ||
      fail "proposal uuid in reviewer prompt ($rt/$shape)"
    printf '%s' "$out" | grep -Fq 'chorus:chorus-proposal-reviewer' || fail "proposal reviewer skill ($rt/$shape)"
    assert_spawn_wording "$rt" "$out" "proposal $shape"
    ok

    out=$(event "$shape" chorus_submit_for_verify taskUuid | bash "$root/hooks/on-post-submit-for-verify.sh" | ctx)
    printf '%s' "$out" | grep -Fq "Task ${T} has been submitted" || fail "task uuid ($rt/$shape)"
    printf '%s' "$out" | grep -Fq 'chorus:chorus-task-reviewer' || fail "task reviewer skill ($rt/$shape)"
    assert_spawn_wording "$rt" "$out" "task $shape"
    ok
  done

  # Empty stdin still emits the generic reminder.
  out=$(bash "$root/hooks/on-post-submit-for-verify.sh" </dev/null | ctx)
  printf '%s' "$out" | grep -Fq 'Task <uuid> has been submitted' || fail "empty-event fallback ($rt)"
  ok

  # ---- 4. PostToolUse: admin_verify_task -----------------------------------
  for shape in object string string-noinput nested-only; do
    : > "$TMP/mcp.log"
    out=$(cd "$TMP/project" && event "$shape" chorus_admin_verify_task taskUuid |
      bash "$root/hooks/on-post-verify-task.sh" 2>"$TMP/err" | ctx)
    [ ! -s "$TMP/err" ] || fail "verify-task wrote stderr ($rt/$shape): $(cat "$TMP/err")"
    printf '%s' "$out" | grep -Fq 'admin verification to `done`' || fail "literal \`done\` lost ($rt/$shape)"
    grep -Fq "chorus_get_task {\"taskUuid\":\"${T}\"}" "$TMP/mcp.log" || fail "verify-task lookup ($rt/$shape)"
    printf '%s' "$out" | grep -Fq 'spawn code-reviewer' || fail "code-review branch ($rt/$shape)"
    printf '%s' "$out" | grep -Fq "idea ${ID}" || fail "code-review idea uuid ($rt/$shape)"
    printf '%s' "$out" | grep -Fq 'chorus:chorus-code-reviewer' || fail "code-reviewer skill ($rt/$shape)"
    assert_spawn_wording "$rt" "$out" "verify-task $shape"
    printf '%s' "$out" | grep -Fq 'create idea-completion report' || fail "report branch ($rt/$shape)"
    cr=$(printf '%s\n' "$out" | grep -n 'Code-Review Gateway Trigger' | cut -d: -f1)
    rp=$(printf '%s\n' "$out" | grep -n 'Idea-Completion Report Trigger' | cut -d: -f1)
    [ "$cr" -lt "$rp" ] || fail "branch order ($rt/$shape)"
    ok
  done

  # No UUID anywhere -> silent, no MCP calls.
  : > "$TMP/mcp.log"
  out=$(printf '{"hook_event_name":"PostToolUse","tool_input":{},"tool_response":"null"}' |
    bash "$root/hooks/on-post-verify-task.sh")
  [ -z "$out" ] && [ ! -s "$TMP/mcp.log" ] || fail "verify-task without uuid should be silent ($rt)"
  ok
done
unset PLUGIN_ROOT

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
  CHORUS_MCP_CALL="$TMP/mcp2" bash "$HOOKS/on-post-verify-task.sh")
[ -z "$out" ] || fail "verify-task should be silent while tasks remain"
ok

# Bash 3.2 compat: the shared scripts parse under /bin/bash (macOS: 3.2).
for f in "$HOOKS"/*.sh; do
  /bin/bash -n "$f" || fail "/bin/bash -n $f"
done
ok

echo "shared-hooks: ${pass} passed"
