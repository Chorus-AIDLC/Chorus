#!/usr/bin/env bash
# Run all offline tests (Layer A static + Layer B unit). No Pi session, no Chorus.
set -u
cd "$(dirname "$0")/.."
echo "══════════════════════════════════════════"
echo "  chorus-pi offline test suite (A + B)"
echo "══════════════════════════════════════════"
echo ""
echo "──────── Layer A: static ────────"
bash test/static.sh
a=$?
echo ""
echo "──────── Layer B: unit ────────"
bun test test/lib.test.ts 2>&1 | tail -6
b=$?
echo ""
echo "══════════════════════════════════════════"
if [ $a -eq 0 ] && [ $b -eq 0 ]; then
  echo "  ALL OFFLINE TESTS PASSED (A: static, B: unit)"
  exit 0
else
  echo "  FAILURES — A exit=$a, B exit=$b"
  exit 1
fi
