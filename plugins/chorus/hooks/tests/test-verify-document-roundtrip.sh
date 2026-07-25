#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/mcp-call" <<'SH'
#!/usr/bin/env bash
printf '%s' "$FIXTURE"
SH
chmod +x "$TMP/mcp-call"

pass=0
fail=0

expect_ok() {
  local name="$1"
  if CHORUS_MCP_CALL_BIN="$TMP/mcp-call" FIXTURE="$FIXTURE" "$VERIFIER" "$TMP/local" doc-1 >"$TMP/out" 2>"$TMP/err"; then
    pass=$((pass + 1))
  else
    echo "FAIL: $name" >&2
    cat "$TMP/err" >&2
    fail=$((fail + 1))
  fi
}

expect_fail() {
  local name="$1"
  if CHORUS_MCP_CALL_BIN="$TMP/mcp-call" FIXTURE="$FIXTURE" "$VERIFIER" "$TMP/local" doc-1 >"$TMP/out" 2>"$TMP/err"; then
    echo "FAIL: $name unexpectedly succeeded" >&2
    fail=$((fail + 1))
  else
    pass=$((pass + 1))
  fi
}

run_suite() {
  local variant="$1"

  printf 'first\nsecond\n' >"$TMP/local"
  FIXTURE='{"content":"first\nsecond\n","metadata":{"content":"decoy"}}'
  expect_ok "$variant: multiline content with decoy"

  : >"$TMP/local"
  FIXTURE='{"content":""}'
  expect_ok "$variant: empty content"

  printf 'same\n' >"$TMP/local"
  FIXTURE='{"content":"same"}'
  expect_fail "$variant: trailing newline drift"

  printf 'same' >"$TMP/local"
  FIXTURE='{"content":"sAme"}'
  expect_fail "$variant: single-byte drift"
  grep -q 'local  bytes=4 sha256=' "$TMP/err"
  grep -q 'remote bytes=4 sha256=' "$TMP/err"
  ! grep -q 'sAme' "$TMP/err"

  FIXTURE='{"metadata":{"content":"same"}}'
  expect_fail "$variant: missing top-level content"

  FIXTURE='{"content":null}'
  expect_fail "$variant: non-string content"

  FIXTURE='not-json'
  expect_fail "$variant: malformed response"
}

for entry in \
  "codex:$ROOT/hooks/verify-document-roundtrip.sh" \
  "claude:$REPO_ROOT/public/chorus-plugin/bin/verify-document-roundtrip.sh" \
  "kiro:$REPO_ROOT/public/kiro-plugin/bin/verify-document-roundtrip.sh"; do
  variant="${entry%%:*}"
  VERIFIER="${entry#*:}"
  run_suite "$variant"
done

grep -q 'HOOK_SCRIPTS=.*verify-document-roundtrip.sh' "$REPO_ROOT/public/install-kiro.sh" || {
  echo "FAIL: Kiro installer omits verify-document-roundtrip.sh" >&2
  fail=$((fail + 1))
}

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
