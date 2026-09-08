#!/usr/bin/env bash
# test-resolver-drift.sh — enforce the single-source invariant for the bash
# spec-mode resolver. resolve-spec-mode.sh is COPIED into each bash plugin port
# (Claude Code, Codex, Kiro, …); those copies MUST stay byte-identical to the
# canonical Claude Code copy, or the "one computation of the mode" guarantee
# silently rots as ports diverge. The 13-case matrix test covers the canonical
# copy; this guard makes every other copy equal to it. Bash 3.2 compatible.
set -u

# Repo root = four levels up from this script (tests → bin → chorus-plugin → public → repo).
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CANON="$ROOT/public/chorus-plugin/bin/resolve-spec-mode.sh"

if [ ! -f "$CANON" ]; then
  echo "FATAL: canonical resolver not found at $CANON" >&2
  exit 1
fi

PASS=0
FAIL=0
echo "resolver drift-guard (canonical: public/chorus-plugin/bin/resolve-spec-mode.sh):"

# Every bash copy under public/ or plugins/ (excludes node_modules / build output).
COPIES=$(find "$ROOT/public" "$ROOT/plugins" -name resolve-spec-mode.sh 2>/dev/null \
  | grep -v '/node_modules/' | sort)

for f in $COPIES; do
  rel="${f#$ROOT/}"
  if [ "$f" = "$CANON" ]; then
    echo "  --    $rel (canonical)"
    continue
  fi
  if diff -q "$CANON" "$f" >/dev/null 2>&1; then
    PASS=$((PASS + 1)); echo "  PASS  $rel (byte-identical)"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL  $rel DIFFERS from canonical:"
    diff "$CANON" "$f" | sed 's/^/        /'
  fi
done

echo ""
echo "Results: $PASS identical copy(ies), $FAIL drifted"
[ "$FAIL" -eq 0 ]
