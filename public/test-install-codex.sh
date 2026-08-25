#!/usr/bin/env bash
# Test public/install-codex.sh — now a DEPRECATION STUB that redirects to
# `chorus agents add`. Verifies bash 3.2 compatibility + the stub shape:
#   - names the replacement `npm install -g @chorus-aidlc/chorus@0.17.0` + `chorus agents add`
#   - prints a deprecation notice
#   - run non-interactively (no TTY, e.g. curl | bash in CI) it exits non-zero
#   - installs nothing (writes no config.toml)
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

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'

PASS=0; FAIL=0; FAIL_NOTES=""

pass() { printf "  ${GREEN}PASS${RESET}  %s\n" "$*"; PASS=$((PASS + 1)); }
fail() { printf "  ${RED}FAIL${RESET}  %s\n" "$*"; FAIL=$((FAIL + 1)); FAIL_NOTES="$FAIL_NOTES
  - $*"; }

echo "${BOLD}Testing:${RESET} $SCRIPT"
echo "${BOLD}Using:${RESET}   $TEST_BASH ($("$TEST_BASH" --version | head -1))"
echo ""

# [1/3] Static scan — reject bash 4+ constructs
echo "${BOLD}[1/3]${RESET} Static scan for bash 4+ constructs"
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

# [2/3] Parse
echo ""
echo "${BOLD}[2/3]${RESET} Parse with $TEST_BASH -n"
if "$TEST_BASH" -n "$SCRIPT" 2>/tmp/install-codex-parse.$$; then
  pass "parses without syntax errors"
else
  fail "parse error"
  sed 's/^/         /' /tmp/install-codex-parse.$$
fi
rm -f /tmp/install-codex-parse.$$

# [3/3] Non-interactive stub behavior: redirect to `chorus agents add`, exit non-zero,
# install nothing. Stdin from /dev/null + stdout redirected to a file → neither
# is a TTY, so the stub must take the print-and-fail path (never exec).
echo ""
echo "${BOLD}[3/3]${RESET} Non-interactive stub behavior (no TTY → print + non-zero)"

TMP_HOME="$(mktemp -d -t chorus-install-test.XXXXXX)"
trap 'rm -rf "$TMP_HOME"' EXIT

run_out="$TMP_HOME/run.log"
set +e
env \
  HOME="$TMP_HOME" \
  CODEX_HOME="$TMP_HOME/.codex" \
  "$TEST_BASH" "$SCRIPT" </dev/null >"$run_out" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  pass "exits non-zero when non-interactive (rc=$rc)"
else
  fail "exited 0 (expected non-zero for a no-TTY deprecation stub)"
  sed 's/^/         /' "$run_out"
fi

grep -q 'npm install -g @chorus-aidlc/chorus' "$run_out" \
  && pass "names 'npm install -g @chorus-aidlc/chorus'" \
  || { fail "did not print the npm install guidance"; sed 's/^/         /' "$run_out"; }

grep -q 'chorus agents add' "$run_out" \
  && pass "names 'chorus agents add'" \
  || { fail "did not print the chorus agents add command"; sed 's/^/         /' "$run_out"; }

grep -qi 'deprecat' "$run_out" \
  && pass "prints a deprecation notice" \
  || { fail "no deprecation notice printed"; sed 's/^/         /' "$run_out"; }

[ ! -f "$TMP_HOME/.codex/config.toml" ] \
  && pass "installs nothing (no config.toml written)" \
  || fail "wrote config.toml (stub must install nothing)"

echo ""
echo "${BOLD}Summary:${RESET} $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  printf "${RED}%s${RESET}\n" "$FAIL_NOTES"
  exit 1
fi
echo "${GREEN}All checks passed.${RESET}"
