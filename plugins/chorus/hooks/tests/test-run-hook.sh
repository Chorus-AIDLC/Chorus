#!/usr/bin/env bash
# test-run-hook.sh — hooks/run-hook.sh dispatcher contract.
#
#   1. No TRAE marker: run-hook.sh <name> is byte-identical (stdout + exit
#      code) to invoking hooks/<name>.sh directly, for every dispatched hook.
#   2. TRAE marker (PLUGIN_ROOT under ${TRAE_HOME:-$HOME/.trae}/plugins/,
#      symlinks resolved) + a hooks/trae/<name>.sh copy -> the TRAE copy runs.
#   3. TRAE marker but no copy -> the original runs.
#   4. CHORUS_HOOK_RUNTIME=codex|trae forces the choice; bad names rejected.
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

cat > "$TMP/mcp" <<'EOF'
#!/usr/bin/env bash
printf '{"agent":{"name":"Fixture"},"notifications":{"unread":0}}'
EOF
chmod +x "$TMP/mcp"

# Hermetic env: no ambient TRAE install, no CLI profile/creds leakage.
mkdir -p "$TMP/home" "$TMP/project"
export HOME="$TMP/home"
unset TRAE_HOME CHORUS_HOOK_RUNTIME CHORUS_AGENT_PROFILE CHORUS_SPEC_MODE 2>/dev/null || true
export CHORUS_MCP_NO_CLI=1
export CHORUS_MCP_CALL="$TMP/mcp"

T=11111111-2222-4333-8444-555555555555
EV_SS='{"source":"startup","session_id":"s","hook_event_name":"SessionStart"}'
EV_TASK=$(printf '{"hook_event_name":"PostToolUse","tool_name":"mcp__chorus__chorus_submit_for_verify","tool_input":{"taskUuid":"%s"},"tool_response":{"content":[{"type":"text","text":"{\\"uuid\\":\\"%s\\"}"}]}}' "$T" "$T")
EV_PROP=$(printf '{"hook_event_name":"PostToolUse","tool_name":"mcp__chorus__chorus_pm_submit_proposal","tool_input":{"proposalUuid":"%s"}}' "$T")

event_for() {
  case "$1" in
    on-session-start) printf '%s' "$EV_SS" ;;
    on-post-submit-proposal) printf '%s' "$EV_PROP" ;;
    *) printf '%s' "$EV_TASK" ;;
  esac
}

# run <cmd...> — prints "<stdout>\n--rc=<n>" with the event on stdin.
run_with() {
  local name=$1; shift
  local out rc=0
  out=$(cd "$TMP/project" && event_for "$name" | "$@") || rc=$?
  printf '%s\n--rc=%s' "$out" "$rc"
}

# ---- 1. Codex: byte-identical without a TRAE marker ----------------------
for configured in yes no; do
  if [ "$configured" = yes ]; then
    export CHORUS_URL="https://chorus.test/api/mcp" CHORUS_API_KEY="cho_test"
  else
    unset CHORUS_URL CHORUS_API_KEY
  fi
  for name in on-session-start on-post-submit-proposal on-post-submit-for-verify on-post-verify-task; do
    for root_mode in plugin_root unset codex_home; do
      case "$root_mode" in
        plugin_root) export PLUGIN_ROOT="$ROOT" ;;
        unset) unset PLUGIN_ROOT ;;
        codex_home)
          # A Codex install while TRAE is ALSO installed on the machine.
          mkdir -p "$TMP/home/.trae/plugins" "$TMP/home/.codex/plugins/cache/chorus-plugins/chorus"
          [ -e "$TMP/home/.codex/plugins/cache/chorus-plugins/chorus/0.0.0" ] ||
            cp -R "$ROOT" "$TMP/home/.codex/plugins/cache/chorus-plugins/chorus/0.0.0"
          export PLUGIN_ROOT="$TMP/home/.codex/plugins/cache/chorus-plugins/chorus/0.0.0"
          ;;
      esac
      base="${PLUGIN_ROOT:-$ROOT}/hooks"
      direct=$(run_with "$name" "$base/$name.sh")
      via=$(run_with "$name" "$base/run-hook.sh" "$name")
      [ "$direct" = "$via" ] ||
        fail "codex output differs for $name (configured=$configured root=$root_mode)"
      printf '%s' "$via" | grep -q 'TRAE port' &&
        fail "TRAE copy selected without marker for $name"
      ok
    done
  done
done
rm -rf "$TMP/home/.trae" "$TMP/home/.codex"
export CHORUS_URL="https://chorus.test/api/mcp" CHORUS_API_KEY="cho_test"

# ---- 2. TRAE marker selects the TRAE copy --------------------------------
TRAE_ROOT="$TMP/trae-home/plugins/cache/chorus-plugins/chorus/0.0.0"
mkdir -p "$(dirname "$TRAE_ROOT")"
cp -R "$ROOT" "$TRAE_ROOT"

assert_trae_selected() {
  local label=$1 out
  out=$(cd "$TMP/project" && printf '%s' "$EV_SS" | "$TRAE_ROOT/hooks/run-hook.sh" on-session-start)
  printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | contains("(TRAE port)")' >/dev/null ||
    fail "TRAE copy not selected ($label)"
  ok
}

# 2a. explicit TRAE_HOME
export TRAE_HOME="$TMP/trae-home" PLUGIN_ROOT="$TRAE_ROOT"
assert_trae_selected "TRAE_HOME set"

# 2b. TRAE_HOME unset (traecli does not export it); default ~/.trae is a
#     symlink while PLUGIN_ROOT is canonical, as observed on traecli 0.209.1.
unset TRAE_HOME
ln -s "$TMP/trae-home" "$TMP/home/.trae"
assert_trae_selected "default ~/.trae via symlink"

# 2c. PLUGIN_ROOT unset -> marker derived from the dispatcher's location.
unset PLUGIN_ROOT
assert_trae_selected "PLUGIN_ROOT unset"
export PLUGIN_ROOT="$TRAE_ROOT"

# ---- 3. Marker present but no TRAE copy -> original ----------------------
cat > "$TRAE_ROOT/hooks/only-original.sh" <<'EOF'
#!/usr/bin/env bash
printf 'original:%s\n' "$*"
cat
exit 7
EOF
chmod +x "$TRAE_ROOT/hooks/only-original.sh"
rc=0
out=$(printf 'stdin-payload' | "$TRAE_ROOT/hooks/run-hook.sh" only-original a 'b c') || rc=$?
[ "$rc" = "7" ] || fail "exit code not propagated (got $rc)"
[ "$out" = "original:a b c
stdin-payload" ] || fail "args/stdin not passed through: $out"
ok

# ---- 4. Overrides + validation --------------------------------------------
out=$(cd "$TMP/project" && printf '%s' "$EV_SS" | CHORUS_HOOK_RUNTIME=codex "$TRAE_ROOT/hooks/run-hook.sh" on-session-start)
printf '%s' "$out" | grep -q '(Codex port)' || fail "CHORUS_HOOK_RUNTIME=codex not honored"
ok
rm -f "$TMP/home/.trae"
out=$(cd "$TMP/project" && printf '%s' "$EV_SS" | CHORUS_HOOK_RUNTIME=trae "$ROOT/hooks/run-hook.sh" on-session-start)
printf '%s' "$out" | grep -q '(TRAE port)' || fail "CHORUS_HOOK_RUNTIME=trae not honored"
ok

for bad in "" "../on-session-start" "trae/on-session-start" ".hidden" 'a;b'; do
  rc=0
  "$ROOT/hooks/run-hook.sh" "$bad" </dev/null >/dev/null 2>&1 || rc=$?
  [ "$rc" = "2" ] || fail "invalid hook name '$bad' not rejected (rc=$rc)"
  ok
done

echo "run-hook: ${pass} passed"
