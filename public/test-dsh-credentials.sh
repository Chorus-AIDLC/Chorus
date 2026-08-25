#!/usr/bin/env bash
# Tests for public/dsh-credentials.sh — now a DEPRECATION STUB that redirects to
# `chorus agents add`. Verifies the stub shape: a non-interactive run names the
# replacement command, prints a deprecation notice, exits non-zero, and writes
# NO $DSH_HOME/.env (installs/writes nothing). Bash 3.2 compatible.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/dsh-credentials.sh"
fail=0

ok() { printf 'ok   %s\n' "$1"; }
no() { printf 'FAIL %s\n' "$1"; fail=1; }

# 1. Non-interactive (no TTY): prints the chorus agents add command + deprecation
#    notice, exits non-zero, and writes no .env. stdin from /dev/null and stdout
#    captured (command substitution) → neither is a TTY → print-and-fail path.
T="$(mktemp -d)"
out="$(env -u CHORUS_URL -u CHORUS_API_KEY DSH_HOME="$T" bash "$SCRIPT" </dev/null 2>&1)"
rc=$?
[ "$rc" -ne 0 ] && ok "exits non-zero when non-interactive" || no "exits non-zero when non-interactive"
printf '%s\n' "$out" | grep -q 'npm install -g @chorus-aidlc/chorus' && ok "names npm install -g @chorus-aidlc/chorus" || no "names npm install -g @chorus-aidlc/chorus"
printf '%s\n' "$out" | grep -q 'chorus agents add' && ok "names chorus agents add" || no "names chorus agents add"
printf '%s\n' "$out" | grep -qi 'deprecat' && ok "prints a deprecation notice" || no "prints a deprecation notice"
[ ! -f "$T/.env" ] && ok "writes no .env" || no "writes no .env"
rm -rf "$T"

# 2. Even with CHORUS_URL/CHORUS_API_KEY set, the stub installs nothing: it still
#    exits non-zero (no TTY) and writes no .env. This proves the old inline
#    credential-writing logic is gone.
T="$(mktemp -d)"
env DSH_HOME="$T" CHORUS_URL="https://c.example" CHORUS_API_KEY="cho_x" bash "$SCRIPT" </dev/null >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "non-zero even with creds set (installs nothing)" || no "non-zero even with creds set"
[ ! -f "$T/.env" ] && ok "writes no .env even with creds set" || no "writes no .env even with creds set"
rm -rf "$T"

if [ "$fail" -eq 0 ]; then printf '\nALL PASS\n'; else printf '\nFAILURES\n'; fi
exit "$fail"
