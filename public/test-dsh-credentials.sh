#!/usr/bin/env bash
# Tests for public/dsh-credentials.sh — write/merge/mode/idempotency/validation.
# Runs the real script against disposable $DSH_HOME dirs. Bash 3.2 compatible.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/dsh-credentials.sh"
fail=0

ok() { printf 'ok   %s\n' "$1"; }
no() { printf 'FAIL %s\n' "$1"; fail=1; }

# run the script with a clean env (no ambient CHORUS_*), stdin from /dev/null.
run() {
  local home="$1"; shift
  env -u CHORUS_URL -u CHORUS_API_KEY DSH_HOME="$home" "$@" bash "$SCRIPT" </dev/null >/dev/null 2>&1
}

# 1. writes both keys, preserves unrelated lines, mode 0600, normalizes URL
T="$(mktemp -d)"; printf 'DEEPSEEK_API_KEY=sk-keep\nOTHER=1\n' > "$T/.env"
run "$T" CHORUS_URL="https://c.example/api/mcp/" CHORUS_API_KEY="cho_test123"
grep -qx 'CHORUS_URL=https://c.example' "$T/.env" && ok "writes+normalizes CHORUS_URL" || no "writes+normalizes CHORUS_URL"
grep -qx 'CHORUS_API_KEY=cho_test123' "$T/.env" && ok "writes CHORUS_API_KEY" || no "writes CHORUS_API_KEY"
grep -qx 'DEEPSEEK_API_KEY=sk-keep' "$T/.env" && ok "preserves DEEPSEEK line" || no "preserves DEEPSEEK line"
grep -qx 'OTHER=1' "$T/.env" && ok "preserves OTHER line" || no "preserves OTHER line"
[ "$(stat -c '%a' "$T/.env" 2>/dev/null || stat -f '%A' "$T/.env")" = "600" ] && ok "mode 0600" || no "mode 0600"

# 2. idempotent: re-run replaces, no duplicate lines
run "$T" CHORUS_URL="https://c.example" CHORUS_API_KEY="cho_new"
[ "$(grep -c '^CHORUS_URL=' "$T/.env")" = "1" ] && ok "no duplicate CHORUS_URL" || no "no duplicate CHORUS_URL"
[ "$(grep -c '^CHORUS_API_KEY=' "$T/.env")" = "1" ] && ok "no duplicate CHORUS_API_KEY" || no "no duplicate CHORUS_API_KEY"
grep -qx 'CHORUS_API_KEY=cho_new' "$T/.env" && ok "replaced key value" || no "replaced key value"
rm -rf "$T"

# 3. drops a prior `export CHORUS_*` form too, keeps others
T="$(mktemp -d)"; printf 'export CHORUS_URL=https://old\nexport CHORUS_API_KEY=cho_old\nKEEP=2\n' > "$T/.env"
run "$T" CHORUS_URL="https://c.example" CHORUS_API_KEY="cho_fresh"
grep -q 'export CHORUS_URL' "$T/.env" && no "drops export CHORUS_URL" || ok "drops export CHORUS_URL"
grep -q 'export CHORUS_API_KEY' "$T/.env" && no "drops export CHORUS_API_KEY" || ok "drops export CHORUS_API_KEY"
grep -qx 'KEEP=2' "$T/.env" && ok "KEEP preserved" || no "KEEP preserved"
rm -rf "$T"

# 4. validation: missing creds (no TTY) / bad URL / bad key all exit non-zero, write nothing
T="$(mktemp -d)"
run "$T" && no "missing creds exits non-zero" || ok "missing creds exits non-zero"
[ ! -f "$T/.env" ] && ok "no .env written on failure" || no "no .env written on failure"
run "$T" CHORUS_URL="ftp://x" CHORUS_API_KEY="cho_x" && no "bad URL exits non-zero" || ok "bad URL exits non-zero"
run "$T" CHORUS_URL="https://x" CHORUS_API_KEY="nope" && no "bad key exits non-zero" || ok "bad key exits non-zero"
rm -rf "$T"

# 5. --help exits 0
bash "$SCRIPT" --help >/dev/null 2>&1 && ok "--help exits 0" || no "--help exits 0"

if [ "$fail" -eq 0 ]; then printf '\nALL PASS\n'; else printf '\nFAILURES\n'; fi
exit "$fail"
