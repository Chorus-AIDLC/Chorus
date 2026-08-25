#!/usr/bin/env bash
# test-mcp-cli-delegation.sh — prove the prefer-CLI / curl-fallback delegation
# added to every bash MCP wrapper (Decision 1 of the "retire bootstrap + migrate
# MCP path" tech design). One shared harness covers all four bash surfaces:
#
#   Claude Code : public/chorus-plugin/bin/chorus-api.sh   (mcp-tool)
#   Kiro        : public/kiro-plugin/bin/chorus-api.sh      (mcp-tool)
#   Codex       : plugins/chorus/hooks/chorus-mcp-call.sh
#   Pi          : packages/chorus-pi/bin/chorus-mcp-call.sh
#
# (The dsh wrapper is a Node script — covered by tests/mcp-call-delegation.test.ts.)
#
# Contract asserted per surface:
#   A. `chorus` on PATH (>= 0.17.0) -> delegates `chorus mcp call <tool> <json> --url … --api-key …`,
#      propagating its stdout verbatim and exit 0.
#   B. `chorus` present but FAILING -> propagates its non-zero exit (7) and stderr;
#      NEVER falls back to curl (no double request / masked failure).
#   C. CHORUS_MCP_NO_CLI=1 (escape hatch) -> ignores the CLI, takes the curl path.
#   D. `chorus` absent -> takes the curl path.
#   E. `chorus` present at a higher version (1.2.0, major>0) -> still delegates.
#   F. `chorus` present but TOO OLD (0.16.4) -> version-gate error naming
#      `npm install -g @chorus-aidlc/chorus` + the >= 0.17.0 floor; non-zero exit;
#      NO `chorus mcp call` delegation and NO curl fallback.
#   G. `chorus` present but version UNPARSEABLE -> same upgrade error, no delegation.
#
# Bash 3.2 compatible. No `set -e`: several scenarios intentionally run commands
# that exit non-zero, and we assert on the captured exit code.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ORIG_PATH="$PATH"

# ---- shared credentials + throwaway state locations -----------------------
export CHORUS_URL="http://127.0.0.1:1"     # guaranteed-unreachable -> curl fails fast
export CHORUS_API_KEY="cho_testkey"
export CHORUS_PLUGIN_STATE_ROOT="$TMP/global"   # CC state (via chorus-paths.sh)
export CHORUS_STATE_DIR="$TMP/state"            # Kiro state (direct)
export CLAUDE_PROJECT_DIR="$TMP/proj"
export CHORUS_SESSION_ID="testsess"
export CHORUS_FAKE_ARGS="$TMP/fake-args"
export CHORUS_FAKE_MARKER="$TMP/fake-marker"
mkdir -p "$CLAUDE_PROJECT_DIR"

TOOL="chorus_checkin"
JSON='{"foo":"bar"}'   # no spaces -> deterministic "$*" comparison in the fake
EXPECTED_ARGS="mcp call $TOOL $JSON --url $CHORUS_URL --api-key $CHORUS_API_KEY"
# Profile-path (CHORUS_AGENT_PROFILE) expectations. A real agentName with a space
# proves the wrapper quotes it as a single argv element (the fake joins argv with
# spaces, so a broken quote would show up as extra tokens here).
PROFILE="Admin Claude"
EXPECTED_PROFILE_ARGS="mcp call $TOOL $JSON --agent $PROFILE"

# ---- fake `chorus` binary -------------------------------------------------
# `chorus --version` prints $CHORUS_FAKE_VERSION (a chosen X.Y.Z, or garbage to
# exercise the unparseable branch) and exits 0 WITHOUT touching the marker/args —
# so the marker proves a real `chorus mcp call` delegation, never a version probe.
# For any other argv it records its argv (joined) + a marker proving it ran, then
# succeeds with a sentinel on stdout or fails (exit 7) with a sentinel on stderr.
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/chorus" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  printf '%s\n' "${CHORUS_FAKE_VERSION:-0.17.0}"
  exit 0
fi
printf '%s\n' "$*" > "$CHORUS_FAKE_ARGS"
: > "$CHORUS_FAKE_MARKER"
if [ "${CHORUS_FAKE_MODE:-ok}" = "fail" ]; then
  printf 'CHORUS_CLI_SENTINEL_FAIL\n' >&2
  exit 7
fi
printf 'CHORUS_CLI_SENTINEL_OK\n'
exit 0
FAKE
chmod +x "$FAKEBIN/chorus"

# ---- a sanitized PATH with every real tool EXCEPT `chorus` ----------------
# Guarantees `command -v chorus` is false for scenario D even if a real chorus
# happens to be installed on the host, while keeping curl/sed/mkdir/etc. available.
CLEANBIN="$TMP/cleanbin"
mkdir -p "$CLEANBIN"
_oifs="$IFS"; IFS=:
for _d in $ORIG_PATH; do
  [ -d "$_d" ] || continue
  for _f in "$_d"/*; do
    [ -e "$_f" ] || continue
    _b="${_f##*/}"
    [ "$_b" = "chorus" ] && continue
    [ -e "$CLEANBIN/$_b" ] || ln -s "$_f" "$CLEANBIN/$_b" 2>/dev/null || true
  done
done
IFS="$_oifs"

# ---- assertion helpers ----------------------------------------------------
FAILS=0
ok()  { printf '    ok   %s\n' "$1"; }
bad() { printf '    FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# run_case <PATHVAL> <hatch:0|1> <fmode:ok|fail> [version]  -> stdout on fd1, stderr to $TMP/err
# [version] is what the fake `chorus --version` prints (default 0.17.0 = delegates).
run_case() {
  (
    export PATH="$1"
    export CHORUS_FAKE_MODE="$3"
    export CHORUS_FAKE_VERSION="${4:-0.17.0}"
    if [ "$2" = "1" ]; then export CHORUS_MCP_NO_CLI=1; else unset CHORUS_MCP_NO_CLI; fi
    if [ "$MODE" = "mcp-tool" ]; then
      exec bash "$WRAPPER" mcp-tool "$TOOL" "$JSON"
    else
      exec bash "$WRAPPER" "$TOOL" "$JSON"
    fi
  )
}

# run_profile_case <PATHVAL> <unset_urlkey:0|1> -> exercises CHORUS_AGENT_PROFILE
# with a usable CLI (0.17.0). unset_urlkey=1 proves profile mode needs no url/key;
# =0 proves the profile is PREFERRED even when url/key are also present.
run_profile_case() {
  (
    export PATH="$1"
    export CHORUS_FAKE_MODE="ok"
    export CHORUS_FAKE_VERSION="0.17.0"
    unset CHORUS_MCP_NO_CLI
    export CHORUS_AGENT_PROFILE="$PROFILE"
    if [ "$2" = "1" ]; then unset CHORUS_URL CHORUS_API_KEY; fi
    if [ "$MODE" = "mcp-tool" ]; then
      exec bash "$WRAPPER" mcp-tool "$TOOL" "$JSON"
    else
      exec bash "$WRAPPER" "$TOOL" "$JSON"
    fi
  )
}

# ---- per-surface scenarios ------------------------------------------------
while read -r NAME MODE REL; do
  [ -n "${NAME:-}" ] || continue
  case "$NAME" in \#*) continue ;; esac
  WRAPPER="$ROOT/$REL"
  if [ ! -f "$WRAPPER" ]; then bad "$NAME: wrapper not found: $REL"; continue; fi
  printf '  %s (%s)\n' "$NAME" "$REL"

  # A. present + ok -> delegates, verbatim stdout, verbatim args, exit 0
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$FAKEBIN:$ORIG_PATH" 0 ok 2>"$TMP/err"); RC=$?
  contains "$OUT" "CHORUS_CLI_SENTINEL_OK" && ok "A: delegates stdout verbatim" \
    || bad "A: stdout missing CLI sentinel (got: $OUT)"
  GOTARGS=$(head -1 "$CHORUS_FAKE_ARGS" 2>/dev/null || true)
  [ "$GOTARGS" = "$EXPECTED_ARGS" ] && ok "A: forwards args + explicit creds" \
    || bad "A: arg mismatch (want [$EXPECTED_ARGS] got [$GOTARGS])"
  [ "$RC" = "0" ] && ok "A: exit 0 propagated" || bad "A: exit $RC != 0"

  # B. present + fail -> propagate exit 7 and stderr, NO curl fallback
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$FAKEBIN:$ORIG_PATH" 0 fail 2>"$TMP/err"); RC=$?
  [ "$RC" = "7" ] && ok "B: propagates failing exit 7 (no curl retry)" \
    || bad "B: exit $RC != 7 (fallback masked the failure?)"
  [ -e "$CHORUS_FAKE_MARKER" ] && ok "B: CLI was invoked" || bad "B: CLI not invoked"
  contains "$(cat "$TMP/err" 2>/dev/null)" "CHORUS_CLI_SENTINEL_FAIL" \
    && ok "B: CLI stderr propagated" || bad "B: CLI stderr not propagated"

  # C. escape hatch -> skip CLI, take curl path
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$FAKEBIN:$ORIG_PATH" 1 ok 2>"$TMP/err"); RC=$?
  [ ! -e "$CHORUS_FAKE_MARKER" ] && ok "C: CHORUS_MCP_NO_CLI skips the CLI" \
    || bad "C: CLI invoked despite escape hatch"
  contains "$OUT" "CHORUS_CLI_SENTINEL_OK" && bad "C: delegated despite escape hatch" \
    || ok "C: no delegation (curl path)"

  # D. absent -> take curl path
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$CLEANBIN" 0 ok 2>"$TMP/err"); RC=$?
  [ ! -e "$CHORUS_FAKE_MARKER" ] && ok "D: absent chorus -> no delegation" \
    || bad "D: CLI invoked when absent"
  contains "$OUT" "CHORUS_CLI_SENTINEL_OK" && bad "D: delegated when absent" \
    || ok "D: fell back to curl path"

  # E. present at a higher version (1.2.0, major>0) -> still delegates
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$FAKEBIN:$ORIG_PATH" 0 ok 1.2.0 2>"$TMP/err"); RC=$?
  contains "$OUT" "CHORUS_CLI_SENTINEL_OK" && ok "E: v1.2.0 delegates" \
    || bad "E: v1.2.0 did not delegate (got: $OUT)"
  [ -e "$CHORUS_FAKE_MARKER" ] && ok "E: CLI mcp-call invoked" || bad "E: CLI not invoked"
  [ "$RC" = "0" ] && ok "E: exit 0 propagated" || bad "E: exit $RC != 0"

  # F. present but too old (0.16.4) -> upgrade error, non-zero, NO delegation, NO curl
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$FAKEBIN:$ORIG_PATH" 0 ok 0.16.4 2>"$TMP/err"); RC=$?
  ERR=$(cat "$TMP/err" 2>/dev/null || true)
  [ "$RC" != "0" ] && ok "F: too-old exits non-zero" || bad "F: too-old exited 0"
  [ ! -e "$CHORUS_FAKE_MARKER" ] && ok "F: no mcp-call delegation" || bad "F: delegated to an old CLI"
  contains "$OUT" "CHORUS_CLI_SENTINEL_OK" && bad "F: delegated stdout leaked" \
    || ok "F: no delegated stdout"
  contains "$ERR" "npm install -g @chorus-aidlc/chorus" \
    && ok "F: error names npm upgrade command" || bad "F: error missing npm upgrade command"
  contains "$ERR" "0.17.0" && ok "F: error names >= 0.17.0 floor" || bad "F: error missing floor"
  contains "$ERR" "MCP initialize failed" && bad "F: fell back to curl (gate leaked)" \
    || ok "F: no curl fallback"

  # G. present but version unparseable -> same upgrade error, non-zero, NO delegation
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_case "$FAKEBIN:$ORIG_PATH" 0 ok "not-a-version" 2>"$TMP/err"); RC=$?
  ERR=$(cat "$TMP/err" 2>/dev/null || true)
  [ "$RC" != "0" ] && ok "G: garbage version exits non-zero" || bad "G: garbage version exited 0"
  [ ! -e "$CHORUS_FAKE_MARKER" ] && ok "G: no delegation on garbage version" \
    || bad "G: delegated on garbage version"
  contains "$ERR" "npm install -g @chorus-aidlc/chorus" \
    && ok "G: garbage error names npm upgrade command" || bad "G: garbage error missing npm upgrade"

  # H. CHORUS_AGENT_PROFILE + usable CLI, NO url/key -> delegates by profile,
  #    forwarding `--agent <profile>` (and NOT --url/--api-key), exit 0.
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_profile_case "$FAKEBIN:$ORIG_PATH" 1 2>"$TMP/err"); RC=$?
  contains "$OUT" "CHORUS_CLI_SENTINEL_OK" && ok "H: profile-only delegates (no url/key)" \
    || bad "H: profile-only did not delegate (out: $OUT; err: $(cat "$TMP/err" 2>/dev/null))"
  GOTARGS=$(head -1 "$CHORUS_FAKE_ARGS" 2>/dev/null || true)
  [ "$GOTARGS" = "$EXPECTED_PROFILE_ARGS" ] && ok "H: forwards --agent <profile>" \
    || bad "H: profile arg mismatch (want [$EXPECTED_PROFILE_ARGS] got [$GOTARGS])"
  [ "$RC" = "0" ] && ok "H: exit 0 propagated" || bad "H: exit $RC != 0"

  # I. CHORUS_AGENT_PROFILE is PREFERRED over url+key when both are set.
  rm -f "$CHORUS_FAKE_MARKER" "$CHORUS_FAKE_ARGS"
  OUT=$(run_profile_case "$FAKEBIN:$ORIG_PATH" 0 2>"$TMP/err"); RC=$?
  GOTARGS=$(head -1 "$CHORUS_FAKE_ARGS" 2>/dev/null || true)
  [ "$GOTARGS" = "$EXPECTED_PROFILE_ARGS" ] && ok "I: profile preferred over url+key" \
    || bad "I: expected --agent delegation, got [$GOTARGS]"
done <<EOF
CC     mcp-tool  public/chorus-plugin/bin/chorus-api.sh
KIRO   mcp-tool  public/kiro-plugin/bin/chorus-api.sh
CODEX  direct    plugins/chorus/hooks/chorus-mcp-call.sh
PI     direct    packages/chorus-pi/bin/chorus-mcp-call.sh
EOF

echo ""
if [ "$FAILS" -gt 0 ]; then
  echo "mcp-cli-delegation: $FAILS check(s) FAILED"
  exit 1
fi
echo "mcp-cli-delegation: all bash-wrapper delegation checks PASS"
