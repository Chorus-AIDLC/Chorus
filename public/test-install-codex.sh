#!/usr/bin/env bash
# Test public/install-codex.sh for macOS bash 3.2 compatibility.
#
# Usage:
#   bash public/test-install-codex.sh
#   BASH32=/path/to/bash-3.2 bash public/test-install-codex.sh
#
# Picks a bash: $BASH32 → /tmp/bash32-build/bash-3.2/bash (hand-built)
#              → /bin/bash (macOS system bash is 3.2.57)
#              → `bash` on PATH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/public/install-codex.sh"

if [ -n "${BASH32:-}" ] && [ -x "$BASH32" ]; then
  TEST_BASH="$BASH32"
elif [ -x "/tmp/bash32-build/bash-3.2/bash" ]; then
  TEST_BASH="/tmp/bash32-build/bash-3.2/bash"
elif [ -x "/bin/bash" ]; then
  TEST_BASH="/bin/bash"
else
  TEST_BASH="$(command -v bash)"
fi

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'

PASS=0; FAIL=0; FAIL_NOTES=""

pass() { printf "  ${GREEN}PASS${RESET}  %s\n" "$*"; PASS=$((PASS + 1)); }
fail() { printf "  ${RED}FAIL${RESET}  %s\n" "$*"; FAIL=$((FAIL + 1)); FAIL_NOTES="$FAIL_NOTES
  - $*"; }

echo "${BOLD}Testing:${RESET} $SCRIPT"
echo "${BOLD}Using:${RESET}   $TEST_BASH ($("$TEST_BASH" --version | head -1))"
echo ""

# [1/4] Static scan — reject bash 4+ constructs
echo "${BOLD}[1/4]${RESET} Static scan for bash 4+ constructs"
scan() {
  local label="$1"; local pattern="$2"
  if grep -nE "$pattern" "$SCRIPT" >/tmp/install-codex-scan.$$ 2>/dev/null; then
    fail "$label"
    sed 's/^/         /' /tmp/install-codex-scan.$$
  else
    pass "$label"
  fi
  rm -f /tmp/install-codex-scan.$$
}
scan 'no ${VAR,,} / ${VAR^^} case conversion' '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]+\])?[,^]{1,2}\}'
scan 'no "declare -A" / "typeset -A"'         '^[[:space:]]*(declare|typeset|local)[[:space:]]+-[A-Za-z]*A'
scan 'no mapfile / readarray'                 '^\s*(mapfile|readarray)\b'
scan 'no "&>" redirection'                    '[^|]&>[^>]'
scan 'no "|&" redirection'                    '\|&'
scan 'no ";;&" case fallthrough'              ';;&'

# [2/4] Parse
echo ""
echo "${BOLD}[2/4]${RESET} Parse with $TEST_BASH -n"
if "$TEST_BASH" -n "$SCRIPT" 2>/tmp/install-codex-parse.$$; then
  pass "parses without syntax errors"
else
  fail "parse error"
  sed 's/^/         /' /tmp/install-codex-parse.$$
fi
rm -f /tmp/install-codex-parse.$$

# [3/4] End-to-end dry run with an isolated CODEX_HOME
echo ""
echo "${BOLD}[3/4]${RESET} End-to-end dry run (isolated CODEX_HOME)"

TMP_HOME="$(mktemp -d -t chorus-install-test.XXXXXX)"
trap 'rm -rf "$TMP_HOME"' EXIT

FAKE_BIN="$TMP_HOME/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/codex" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "codex 0.125.0-test" ;;
  plugin)
    if [ "${2:-}" = "marketplace" ] && [ "${3:-}" = "list" ]; then
      echo ""
      exit 0
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$FAKE_BIN/codex"

run_out="$TMP_HOME/run.log"
set +e
env \
  PATH="$FAKE_BIN:$PATH" \
  HOME="$TMP_HOME" \
  CODEX_HOME="$TMP_HOME/.codex" \
  CHORUS_URL="https://chorus.test/api/mcp" \
  CHORUS_API_KEY="cho_test_key_abc123" \
  CHORUS_MARKETPLACE_SOURCE="https://github.com/Chorus-AIDLC/Chorus" \
  "$TEST_BASH" "$SCRIPT" >"$run_out" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  fail "installer exited non-zero ($rc)"
  sed 's/^/         /' "$run_out"
else
  pass "installer exited 0"
fi

cfg="$TMP_HOME/.codex/config.toml"
if [ ! -f "$cfg" ]; then
  fail "config.toml not created at $cfg"
else
  pass "config.toml created"
  grep -q '^\[mcp_servers\.chorus\]' "$cfg" && pass "[mcp_servers.chorus] block present" || fail "[mcp_servers.chorus] missing"
  grep -q 'url = "https://chorus.test/api/mcp"' "$cfg" && pass "url written literally" || fail "url not literal"
  grep -q 'Authorization = "Bearer cho_test_key_abc123"' "$cfg" && pass "Authorization header literal" || fail "Authorization not literal"
  if command -v stat >/dev/null 2>&1; then
    mode="$(stat -c '%a' "$cfg" 2>/dev/null || stat -f '%OLp' "$cfg" 2>/dev/null || echo "")"
    if [ "$mode" = "600" ]; then
      pass "config.toml mode=600"
    elif [ -n "$mode" ]; then
      fail "config.toml mode=$mode (expected 600)"
    fi
  fi
fi

# [4/4] Idempotent re-run with a rotated key
echo ""
echo "${BOLD}[4/4]${RESET} Idempotent re-run with a rotated key"
set +e
env \
  PATH="$FAKE_BIN:$PATH" \
  HOME="$TMP_HOME" \
  CODEX_HOME="$TMP_HOME/.codex" \
  CHORUS_URL="https://chorus.test/api/mcp" \
  CHORUS_API_KEY="cho_rotated_key_xyz789" \
  "$TEST_BASH" "$SCRIPT" >"$run_out" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] && pass "rerun exited 0" || { fail "rerun exited non-zero ($rc)"; sed 's/^/         /' "$run_out"; }

blocks="$(grep -c '^\[mcp_servers\.chorus\]' "$cfg" 2>/dev/null || echo 0)"
[ "$blocks" = "1" ] && pass "exactly one [mcp_servers.chorus] block" || fail "found $blocks [mcp_servers.chorus] blocks"

hdr_blocks="$(grep -c '^\[mcp_servers\.chorus\.http_headers\]' "$cfg" 2>/dev/null || echo 0)"
[ "$hdr_blocks" = "1" ] && pass "exactly one [mcp_servers.chorus.http_headers] block" || fail "found $hdr_blocks http_headers blocks"

if grep -q 'Authorization = "Bearer cho_rotated_key_xyz789"' "$cfg" && ! grep -q 'cho_test_key_abc123' "$cfg"; then
  pass "rotated key replaced the previous key"
else
  fail "rotated key not applied cleanly"
fi

echo ""
echo "${BOLD}Summary:${RESET} $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  printf "${RED}%s${RESET}\n" "$FAIL_NOTES"
  exit 1
fi
echo "${GREEN}All checks passed.${RESET}"
