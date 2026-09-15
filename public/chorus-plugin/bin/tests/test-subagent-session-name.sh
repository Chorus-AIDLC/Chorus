#!/usr/bin/env bash
# test-subagent-session-name.sh — Regression test for Claude Code sub-agent
# session NAMING (on-pre-spawn-agent.sh + on-subagent-start.sh).
#
# The defect this guards against: `tool_input.name` does not exist on CC's Task
# tool, so the name was empty at PreToolUse time, the pending filename became
# `unknown-$(date +%s%N)`, and SubagentStart used that filename as the session
# name — every sub-agent session showed up in Chorus as `unknown-<19 digits>`.
#
# The fix: the session name comes from the SubagentStart event's own
# `agent_type`, falling back to `worker-<agent_id first 8>`. The pending file is
# only a SPAWN GATE (proof the SubagentStart came from a real Task call), never a
# name channel.
#
# Harness mechanism — why we copy the hooks:
#   Both hooks resolve their MCP wrapper as `API="${SCRIPT_DIR}/chorus-api.sh"`
#   from `dirname "$0"`, so a PATH shim would NOT be picked up. We therefore
#   COPY each hook into a sandbox dir next to a stub `chorus-api.sh` that RECORDS
#   (tool, payload) pairs to a log instead of calling a server — the same
#   convention as tests/test-on-post-verify-task.sh.
#
#   We deliberately do NOT copy `chorus-paths.sh` into the sandbox: that file
#   unconditionally recomputes CHORUS_STATE_DIR from ~/.chorus. Both hooks source
#   it fail-soft (`[ -f ... ] && ...`), so with it absent they honor the
#   CHORUS_STATE_DIR we export, and the test never touches the real ~/.chorus.
#
# Cases:
#   1. positive        — agent_type "claude"          -> session name == "claude"
#   2. fallback        — empty agent_type             -> name == worker-<agentId8>
#   3. no unknown-*    — asserted in every case, on the session name AND on the
#                        pending filename
#   4. parallel batch  — two same-second Task spawns of the same subagent_type
#                        write two DISTINCT pending files; two SubagentStart runs
#                        each claim one and each get its OWN event's agent_type
#                        as the name (FIFO mis-pairing can no longer mis-name)
#   5. gate            — SubagentStart with an empty pending dir issues NO
#                        chorus_create_session and exits 0
#   6. skip parity     — a Task spawn of a skip-listed type (chorus:task-reviewer)
#                        writes NO pending file, so it cannot be FIFO-claimed
#                        later by an unrelated agent
#   7. shared stop     — TEARDOWN of a shared type-named session (on-subagent-stop.sh).
#                        Two same-type sub-agents reuse ONE session, so the stop
#                        hook refcounts holders on disk
#                        (<state>/holders/<sanitized name>/<agentId>): the FIRST
#                        exit must NOT close the session, must NOT check the
#                        sibling's task out, must NOT auto-verify and must leave
#                        session_<name> / sessions/<name>.json /
#                        agent_for_session_<uuid> intact; the LAST exit must tear
#                        everything down exactly as before.
#   8. single stop     — the one-agent case is unchanged: close + full cleanup.
#
# Offline, self-contained, Bash 3.2 compatible. Run:
#   /bin/bash public/chorus-plugin/bin/tests/test-subagent-session-name.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
PRE_SPAWN_HOOK="$REPO_ROOT/public/chorus-plugin/bin/on-pre-spawn-agent.sh"
SUBAGENT_START_HOOK="$REPO_ROOT/public/chorus-plugin/bin/on-subagent-start.sh"
SUBAGENT_STOP_HOOK="$REPO_ROOT/public/chorus-plugin/bin/on-subagent-stop.sh"

[ -f "$PRE_SPAWN_HOOK" ] || { echo "FAIL: missing $PRE_SPAWN_HOOK" >&2; exit 1; }
[ -f "$SUBAGENT_START_HOOK" ] || { echo "FAIL: missing $SUBAGENT_START_HOOK" >&2; exit 1; }
[ -f "$SUBAGENT_STOP_HOOK" ] || { echo "FAIL: missing $SUBAGENT_STOP_HOOK" >&2; exit 1; }

PASS=0
FAIL=0
FAILED=""

pass() {
  echo "  PASS  $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL  $1: $2"
  FAIL=$((FAIL + 1))
  FAILED="$FAILED $1"
}

# ----- Sandbox -----

SANDBOX=$(mktemp -d)
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

HOOK_DIR="$SANDBOX/hooks"
mkdir -p "$HOOK_DIR"
cp "$PRE_SPAWN_HOOK" "$HOOK_DIR/on-pre-spawn-agent.sh"
cp "$SUBAGENT_START_HOOK" "$HOOK_DIR/on-subagent-start.sh"
cp "$SUBAGENT_STOP_HOOK" "$HOOK_DIR/on-subagent-stop.sh"
chmod +x "$HOOK_DIR/on-pre-spawn-agent.sh" "$HOOK_DIR/on-subagent-start.sh" \
  "$HOOK_DIR/on-subagent-stop.sh"

# ----- Stub: chorus-api.sh -----
# Records every call as one line: <cmd>|<tool>|<payload>  in $CHORUS_RECORD.
#   mcp-tool chorus_list_sessions   -> the sessions this sandbox has created so
#                                      far (a per-case registry file), so
#                                      reuse-by-name behaves like production
#   mcp-tool chorus_create_session  -> a fresh canned uuid, appended to the registry
#   mcp-tool chorus_reopen_session  -> flips registry status back to active
#   mcp-tool chorus_close_session   -> flips registry status to closed
#   mcp-tool chorus_get_session     -> $CHORUS_STUB_SESSION_JSON if set, else {}
#   state-set/get/delete            -> recorded AND backed by a real file store,
#                                      so SubagentStop's state lookups resolve
#   hook-output                     -> real jq, same JSON shape as production
cat > "$HOOK_DIR/chorus-api.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
rec="${CHORUS_RECORD:-/dev/null}"
store="${CHORUS_STATE_DIR:-/tmp}/stubstate"
sessions_db="${CHORUS_STATE_DIR:-/tmp}/stub-sessions.json"
key_file() { printf '%s/%s' "$store" "$(printf '%s' "$1" | tr -c '[:alnum:]._-' '_')"; }
case "$cmd" in
  mcp-tool)
    tool="${1:-}"; payload="${2:-}"
    printf 'mcp-tool|%s|%s\n' "$tool" "$payload" >> "$rec"
    [ -f "$sessions_db" ] || echo '[]' > "$sessions_db"
    case "$tool" in
      chorus_list_sessions)
        jq -c '{sessions: ., total: length}' "$sessions_db"
        ;;
      chorus_create_session)
        nm=$(printf '%s' "$payload" | jq -r '.name // empty')
        n=$(jq 'length' "$sessions_db")
        uuid=$(printf '11111111-2222-3333-4444-%012d' "$((n + 1))")
        tmp=$(mktemp)
        jq --arg u "$uuid" --arg n "$nm" '. + [{uuid:$u, name:$n, status:"active"}]' \
          "$sessions_db" > "$tmp" && mv "$tmp" "$sessions_db"
        jq -n --arg u "$uuid" --arg n "$nm" '{uuid:$u, name:$n}'
        ;;
      chorus_reopen_session)
        u=$(printf '%s' "$payload" | jq -r '.sessionUuid // empty')
        tmp=$(mktemp)
        jq --arg u "$u" 'map(if .uuid == $u then .status = "active" else . end)' \
          "$sessions_db" > "$tmp" && mv "$tmp" "$sessions_db"
        jq -n --arg u "$u" '{uuid:$u}'
        ;;
      chorus_close_session)
        u=$(printf '%s' "$payload" | jq -r '.sessionUuid // empty')
        tmp=$(mktemp)
        jq --arg u "$u" 'map(if .uuid == $u then .status = "closed" else . end)' \
          "$sessions_db" > "$tmp" && mv "$tmp" "$sessions_db"
        echo '{}'
        ;;
      chorus_get_session)
        if [ -n "${CHORUS_STUB_SESSION_JSON:-}" ] && [ -f "${CHORUS_STUB_SESSION_JSON}" ]; then
          cat "${CHORUS_STUB_SESSION_JSON}"
        else
          echo '{}'
        fi
        ;;
      *) echo '{}' ;;
    esac
    ;;
  state-set)
    printf 'state-set|%s|%s\n' "${1:-}" "${2:-}" >> "$rec"
    mkdir -p "$store" 2>/dev/null || true
    printf '%s' "${2:-}" > "$(key_file "${1:-}")"
    ;;
  state-get)
    printf 'state-get|%s|\n' "${1:-}" >> "$rec"
    f="$(key_file "${1:-}")"
    if [ -f "$f" ]; then cat "$f"; else echo ""; fi
    ;;
  state-delete)
    printf 'state-delete|%s|\n' "${1:-}" >> "$rec"
    rm -f "$(key_file "${1:-}")" 2>/dev/null || true
    ;;
  hook-output)
    sm="${1:-}"; ac="${2:-}"; hen="${3:-}"
    printf 'hook-output|%s|%s\n' "$hen" "$sm" >> "$rec"
    if [ -n "$ac" ]; then
      jq -n --arg sm "$sm" --arg ac "$ac" --arg hen "$hen" \
        '{systemMessage:$sm, hookSpecificOutput:{hookEventName:$hen, additionalContext:$ac}}'
    else
      jq -n --arg sm "$sm" '{systemMessage:$sm}'
    fi
    ;;
  *)
    echo "stub chorus-api.sh: unknown cmd $cmd" >&2; exit 2 ;;
esac
STUB
chmod +x "$HOOK_DIR/chorus-api.sh"

# ----- Per-case state -----

STATE_DIR=""
RECORD=""
LAST_RC=0
LAST_STDERR=""
STUB_SESSION_JSON=""

new_case() {
  # $1 = case slug
  STATE_DIR="$SANDBOX/state/$1"
  RECORD="$SANDBOX/rec/$1.log"
  mkdir -p "$STATE_DIR" "$SANDBOX/rec"
  : > "$RECORD"
  STUB_SESSION_JSON=""
}

# Start a fresh recording window inside the current case, so an assertion can
# say "this hook run issued no chorus_close_session" without earlier runs' calls
# leaking in. State and the session registry are untouched.
rec_reset() { : > "$RECORD"; }

# run_hook <hook-file> <event-json>
run_hook() {
  local hook="$1"
  local event="$2"
  local err
  err=$(mktemp)
  LAST_RC=0
  printf '%s' "$event" \
    | env -i \
        HOME="$SANDBOX/home" \
        PATH="$PATH" \
        CHORUS_URL="http://127.0.0.1:0" \
        CHORUS_API_KEY="cho_test" \
        CHORUS_STATE_DIR="$STATE_DIR" \
        CHORUS_RECORD="$RECORD" \
        CHORUS_STUB_SESSION_JSON="$STUB_SESSION_JSON" \
        CLAUDE_PROJECT_DIR="$SANDBOX/project" \
        /bin/bash "$HOOK_DIR/$hook" >/dev/null 2>"$err" || LAST_RC=$?
  LAST_STDERR=$(cat "$err")
  rm -f "$err"
}

pre_spawn() {
  # $1 = subagent_type
  run_hook "on-pre-spawn-agent.sh" \
    "$(printf '{"session_id":"cc-sess-1","tool_name":"Task","tool_input":{"subagent_type":"%s","description":"do work","prompt":"go"}}' "$1")"
}

subagent_start() {
  # $1 = agent_id, $2 = agent_type (may be empty)
  run_hook "on-subagent-start.sh" \
    "$(printf '{"session_id":"cc-sess-1","agent_id":"%s","agent_type":"%s"}' "$1" "$2")"
}

subagent_stop() {
  # $1 = agent_id
  run_hook "on-subagent-stop.sh" \
    "$(printf '{"session_id":"cc-sess-1","agent_id":"%s"}' "$1")"
}

# How many times a given MCP tool was called in the current recording window.
tool_count() {
  grep -c "^mcp-tool|$1|" "$RECORD" 2>/dev/null || true
}

# Stub state store introspection (same key sanitization as the stub).
state_key_file() {
  printf '%s/stubstate/%s' "$STATE_DIR" "$(printf '%s' "$1" | tr -c '[:alnum:]._-' '_')"
}

state_has() {
  [ -f "$(state_key_file "$1")" ]
}

state_val() {
  cat "$(state_key_file "$1")" 2>/dev/null || true
}

holder_count() {
  # $1 = sanitized session name
  ls -1 "$STATE_DIR/holders/$1" 2>/dev/null | grep -c . || true
}

pending_count() {
  ls -1 "$STATE_DIR/pending" 2>/dev/null | grep -c . || true
}

pending_names() {
  ls -1 "$STATE_DIR/pending" 2>/dev/null || true
}

# All names passed to chorus_create_session, one per line, in call order.
created_names() {
  grep '^mcp-tool|chorus_create_session|' "$RECORD" 2>/dev/null \
    | sed 's/^mcp-tool|chorus_create_session|//' \
    | while IFS= read -r payload; do
        printf '%s' "$payload" | jq -r '.name // empty'
      done
}

created_count() {
  grep -c '^mcp-tool|chorus_create_session|' "$RECORD" 2>/dev/null || true
}

# Guard used by every case: a name must never look like the pre-fix placeholder.
assert_not_unknown() {
  # $1 = case name, $2 = label, $3 = value
  case "$3" in
    unknown-*)
      fail "$1" "$2 is the pre-fix placeholder shape 'unknown-*' (got '$3')"
      return 1
      ;;
  esac
  return 0
}

echo "Sandbox: $SANDBOX"
echo ""

# ===== Case 1: positive — session name == event agent_type =====
new_case "positive"
pre_spawn "claude"
if [ "$LAST_RC" -ne 0 ]; then
  fail "positive" "on-pre-spawn-agent.sh exited $LAST_RC: $LAST_STDERR"
else
  pending="$(pending_names)"
  if ! assert_not_unknown "positive-pending-filename" "pending filename" "$pending"; then
    :
  else
    pass "positive-pending-filename (no unknown-* filename: '$pending')"
  fi

  subagent_start "agentid00deadbeef" "claude"
  if [ "$LAST_RC" -ne 0 ]; then
    fail "positive" "on-subagent-start.sh exited $LAST_RC: $LAST_STDERR"
  else
    name="$(created_names)"
    if [ "$name" != "claude" ]; then
      fail "positive" "expected chorus_create_session name 'claude', got '$name'"
    elif ! assert_not_unknown "positive" "session name" "$name"; then
      :
    else
      pass "positive (session name == event agent_type 'claude')"
    fi
  fi
fi

# ===== Case 2: fallback — empty agent_type -> worker-<agentId first 8> =====
# The pending file is written by a normal "claude" spawn; the SubagentStart event
# then arrives with an EMPTY agent_type. The name must be derived from agent_id,
# never from the pending file's name/filename.
new_case "fallback"
pre_spawn "claude"
if [ "$LAST_RC" -ne 0 ]; then
  fail "fallback" "on-pre-spawn-agent.sh exited $LAST_RC: $LAST_STDERR"
else
  subagent_start "abcdef1234567890" ""
  if [ "$LAST_RC" -ne 0 ]; then
    fail "fallback" "on-subagent-start.sh exited $LAST_RC: $LAST_STDERR"
  else
    name="$(created_names)"
    if [ "$name" != "worker-abcdef12" ]; then
      fail "fallback" "expected name 'worker-abcdef12' (worker- + agent_id first 8), got '$name'"
    elif ! assert_not_unknown "fallback" "session name" "$name"; then
      :
    else
      pass "fallback (empty agent_type -> 'worker-abcdef12')"
    fi
  fi
fi

# ===== Case 3: parallel batch — two same-second spawns of the SAME type =====
# Two PreToolUse:Task invocations of "claude" within the same second must produce
# two DISTINCT pending files (BSD date has no %N, so uniqueness comes from $$).
# Then two SubagentStart events — deliberately of DIFFERENT types — each claim
# one file FIFO and each must be named after their OWN event's agent_type, which
# is what makes plain FIFO claiming safe in a mixed batch.
new_case "parallel"
pre_spawn "claude"
rc1=$LAST_RC
pre_spawn "claude"
rc2=$LAST_RC
if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ]; then
  fail "parallel-distinct-pending" "on-pre-spawn-agent.sh exited $rc1/$rc2: $LAST_STDERR"
else
  n="$(pending_count)"
  if [ "$n" != "2" ]; then
    fail "parallel-distinct-pending" "expected 2 distinct pending files from 2 same-second spawns of the same type, got $n: $(pending_names | tr '\n' ' ')"
  else
    bad=0
    for f in $(pending_names); do
      assert_not_unknown "parallel-distinct-pending" "pending filename" "$f" || bad=1
    done
    [ "$bad" -eq 0 ] && pass "parallel-distinct-pending (2 distinct non-unknown pending files)"
  fi

  subagent_start "aaaaaaaa11112222" "claude"
  rc1=$LAST_RC
  subagent_start "bbbbbbbb33334444" "general-purpose"
  rc2=$LAST_RC
  if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ]; then
    fail "parallel-names" "on-subagent-start.sh exited $rc1/$rc2: $LAST_STDERR"
  else
    names="$(created_names | tr '\n' ',')"
    if [ "$names" != "claude,general-purpose," ]; then
      fail "parallel-names" "expected each session named after its OWN event agent_type ('claude','general-purpose'), got '$names'"
    else
      pass "parallel-names (each spawn named from its own event agent_type)"
    fi
    if [ "$(pending_count)" != "0" ]; then
      fail "parallel-claimed" "expected both pending files claimed, still pending: $(pending_names | tr '\n' ' ')"
    else
      pass "parallel-claimed (both pending files claimed exactly once)"
    fi
  fi
fi

# ===== Case 4: gate — empty pending dir -> no session, exit 0 =====
new_case "gate"
mkdir -p "$STATE_DIR/pending"
subagent_start "cccccccc55556666" "claude"
if [ "$LAST_RC" -ne 0 ]; then
  fail "gate" "expected exit 0 with an empty pending dir, got $LAST_RC: $LAST_STDERR"
elif [ "$(created_count)" != "0" ]; then
  fail "gate" "expected NO chorus_create_session with an empty pending dir, got $(created_count): $(created_names | tr '\n' ' ')"
else
  pass "gate (empty pending dir -> no session created, exit 0)"
fi

# ===== Case 5: skip-list parity — skipped type writes no pending file =====
# on-subagent-start.sh exits early on chorus:task-reviewer, so
# on-pre-spawn-agent.sh must not leave a pending file for it — otherwise that
# orphan could be FIFO-claimed by an unrelated internal agent, defeating the gate.
new_case "skip-parity"
pre_spawn "chorus:task-reviewer"
if [ "$LAST_RC" -ne 0 ]; then
  fail "skip-parity" "on-pre-spawn-agent.sh exited $LAST_RC: $LAST_STDERR"
elif [ "$(pending_count)" != "0" ]; then
  fail "skip-parity" "skip-listed type left an orphan pending file: $(pending_names | tr '\n' ' ')"
else
  pass "skip-parity (chorus:task-reviewer leaves no pending file)"
fi

# ===== Case 6: same-type parallel — FIRST stop must NOT tear down the session ==
# Two "claude" sub-agents run in parallel. Because the session name is the
# repeating agent_type, the second SubagentStart reuses the FIRST one's session,
# so ONE session row has TWO holders. When the first sibling exits, the stop hook
# must leave everything the surviving sibling depends on alone.
SHARED_A="aaaa000011112222"
SHARED_B="bbbb000033334444"

new_case "shared-stop"
printf '%s\n' \
  '{"checkins":[{"taskUuid":"task-of-a","checkoutAt":null},{"taskUuid":"task-of-b","checkoutAt":null}]}' \
  > "$STATE_DIR/session-detail.json"
STUB_SESSION_JSON="$STATE_DIR/session-detail.json"

pre_spawn "claude"; rc1=$LAST_RC
pre_spawn "claude"; rc2=$LAST_RC
subagent_start "$SHARED_A" "claude"; rc3=$LAST_RC
subagent_start "$SHARED_B" "claude"; rc4=$LAST_RC

if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ] || [ "$rc3" -ne 0 ] || [ "$rc4" -ne 0 ]; then
  fail "shared-stop-setup" "setup hooks exited $rc1/$rc2/$rc3/$rc4: $LAST_STDERR"
else
  SHARED_UUID="$(state_val "session_claude")"
  if [ "$(created_count)" != "1" ]; then
    fail "shared-stop-setup" "expected the 2nd same-type start to REUSE one session (1 create), got $(created_count) creates"
  elif [ -z "$SHARED_UUID" ]; then
    fail "shared-stop-setup" "no shared session uuid in state key session_claude"
  elif [ "$(holder_count claude)" != "2" ]; then
    fail "shared-stop-holders" "expected 2 holder entries in holders/claude, got $(holder_count claude): $(ls -1 "$STATE_DIR/holders/claude" 2>/dev/null | tr '\n' ' ')"
  else
    pass "shared-stop-holders (2 same-type starts share 1 session and register 2 holders)"
  fi

  # --- first sibling exits ---
  rec_reset
  subagent_stop "$SHARED_A"
  if [ "$LAST_RC" -ne 0 ]; then
    fail "shared-stop-first" "on-subagent-stop.sh exited $LAST_RC: $LAST_STDERR"
  else
    bad=""
    [ "$(tool_count chorus_close_session)" = "0" ] \
      || bad="$bad closed-the-shared-session"
    [ "$(tool_count chorus_session_checkout_task)" = "0" ] \
      || bad="$bad checked-out-a-siblings-task"
    [ "$(tool_count chorus_get_task)" = "0" ] \
      || bad="$bad ran-the-auto-verify-block"
    [ -f "$STATE_DIR/sessions/claude.json" ] \
      || bad="$bad removed-sessions/claude.json"
    state_has "session_claude" \
      || bad="$bad deleted-name-keyed-state"
    state_has "agent_for_session_${SHARED_UUID}" \
      || bad="$bad deleted-reverse-map-agent_for_session"
    state_has "session_${SHARED_B}" \
      || bad="$bad deleted-siblings-session_<agentId>"
    [ "$(holder_count claude)" = "1" ] \
      || bad="$bad holder-count-not-1-after-own-entry-removed"
    if state_has "session_${SHARED_A}" || state_has "name_for_agent_${SHARED_A}"; then
      bad="$bad kept-own-id-keyed-state"
    fi
    [ -f "$STATE_DIR/claimed/${SHARED_A}" ] && bad="$bad kept-own-claimed-file" || true
    if [ -n "$bad" ]; then
      fail "shared-stop-first" "first stop of a shared session:$bad"
    else
      pass "shared-stop-first (no close/checkout/auto-verify; shared state + sessions/claude.json intact; own state gone)"
    fi
  fi

  # --- last sibling exits: full teardown, exactly as the single-agent case ---
  rec_reset
  subagent_stop "$SHARED_B"
  if [ "$LAST_RC" -ne 0 ]; then
    fail "shared-stop-last" "on-subagent-stop.sh exited $LAST_RC: $LAST_STDERR"
  else
    bad=""
    [ "$(tool_count chorus_close_session)" = "1" ] \
      || bad="$bad close_session-calls=$(tool_count chorus_close_session)"
    [ "$(tool_count chorus_session_checkout_task)" = "2" ] \
      || bad="$bad checkout-calls=$(tool_count chorus_session_checkout_task)(expected both open checkins)"
    [ "$(tool_count chorus_get_task)" -ge 1 ] 2>/dev/null \
      || bad="$bad auto-verify-block-did-not-run"
    [ -f "$STATE_DIR/sessions/claude.json" ] && bad="$bad sessions/claude.json-not-removed" || true
    [ -d "$STATE_DIR/holders/claude" ] && bad="$bad holder-dir-not-removed" || true
    state_has "session_claude" && bad="$bad session_<name>-not-deleted" || true
    state_has "agent_for_session_${SHARED_UUID}" && bad="$bad agent_for_session-not-deleted" || true
    state_has "session_${SHARED_B}" && bad="$bad session_<agentId>-not-deleted" || true
    state_has "name_for_agent_${SHARED_B}" && bad="$bad name_for_agent-not-deleted" || true
    [ -f "$STATE_DIR/claimed/${SHARED_B}" ] && bad="$bad claimed-file-not-removed" || true
    if [ -n "$bad" ]; then
      fail "shared-stop-last" "last stop of a shared session:$bad"
    else
      pass "shared-stop-last (close + auto-checkout of both checkins + all 4 state keys, session file, holder dir and claimed file removed)"
    fi
  fi
fi

# ===== Case 7: single agent — teardown on its only stop is unchanged =====
new_case "single-stop"
printf '%s\n' '{"checkins":[{"taskUuid":"task-solo","checkoutAt":null}]}' \
  > "$STATE_DIR/session-detail.json"
STUB_SESSION_JSON="$STATE_DIR/session-detail.json"
SOLO="dddd000077778888"

pre_spawn "claude"; rc1=$LAST_RC
subagent_start "$SOLO" "claude"; rc2=$LAST_RC
if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ]; then
  fail "single-stop-setup" "setup hooks exited $rc1/$rc2: $LAST_STDERR"
else
  SOLO_UUID="$(state_val "session_claude")"
  rec_reset
  subagent_stop "$SOLO"
  if [ "$LAST_RC" -ne 0 ]; then
    fail "single-stop" "on-subagent-stop.sh exited $LAST_RC: $LAST_STDERR"
  else
    bad=""
    [ "$(tool_count chorus_close_session)" = "1" ] \
      || bad="$bad close_session-calls=$(tool_count chorus_close_session)"
    [ "$(tool_count chorus_session_checkout_task)" = "1" ] \
      || bad="$bad checkout-calls=$(tool_count chorus_session_checkout_task)"
    [ -f "$STATE_DIR/sessions/claude.json" ] && bad="$bad session-file-not-removed" || true
    [ -d "$STATE_DIR/holders/claude" ] && bad="$bad holder-dir-not-removed" || true
    state_has "session_claude" && bad="$bad session_<name>-not-deleted" || true
    state_has "agent_for_session_${SOLO_UUID}" && bad="$bad agent_for_session-not-deleted" || true
    state_has "session_${SOLO}" && bad="$bad session_<agentId>-not-deleted" || true
    state_has "name_for_agent_${SOLO}" && bad="$bad name_for_agent-not-deleted" || true
    [ -f "$STATE_DIR/claimed/${SOLO}" ] && bad="$bad claimed-file-not-removed" || true
    if [ -n "$bad" ]; then
      fail "single-stop" "single-agent stop regressed:$bad"
    else
      pass "single-stop (only holder -> close + full cleanup, unchanged behaviour)"
    fi
  fi
fi

# ===== Case 8: no unknown-* anywhere across all cases =====
# Belt-and-braces sweep: no session name recorded by ANY case may match
# unknown-*, and no pending filename left behind may either. (We match on the
# `name` field only — the create description legitimately contains
# "type: unknown" for the empty-agent_type fallback.)
sweep_bad=""
for rec in "$SANDBOX"/rec/*.log; do
  [ -f "$rec" ] || continue
  while IFS= read -r payload; do
    [ -n "$payload" ] || continue
    nm=$(printf '%s' "$payload" | jq -r '.name // empty')
    case "$nm" in
      unknown-*) sweep_bad="$sweep_bad $(basename "$rec"):$nm" ;;
    esac
  done <<SWEEP
$(grep '^mcp-tool|chorus_create_session|' "$rec" 2>/dev/null | sed 's/^mcp-tool|chorus_create_session|//')
SWEEP
done
for f in $(find "$SANDBOX/state" -type f -name 'unknown-*' 2>/dev/null); do
  sweep_bad="$sweep_bad file:$f"
done
if [ -n "$sweep_bad" ]; then
  fail "no-unknown-sweep" "found pre-fix 'unknown-*' artifacts:$sweep_bad"
else
  pass "no-unknown-sweep (no unknown-* session name or pending filename anywhere)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
exit 0
