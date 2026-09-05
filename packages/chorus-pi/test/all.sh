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
echo "──────── Layer B: unit (pure helpers) ────────"
bun test test/lib.test.ts 2>&1 | tail -6
b=$?
echo ""
echo "──────── Layer B: extension events ────────"
# Drive the real chorus.ts factory with a fake pi + mocked fetch (no network).
# Runs in its own bun invocation for isolation — it overrides global fetch at
# module load. Covers the P1-1/P1-2/P1-3/P2-1 session-lifecycle fixes.
bun test test/ext-events.test.ts 2>&1 | tail -8
be=$?
echo ""
echo ""
echo "══════════════════════════════════════════"
if [ $a -eq 0 ] && [ $b -eq 0 ] && [ $be -eq 0 ]; then
  echo "  ALL OFFLINE TESTS PASSED (A: static, B: unit + extension events)"
  exit 0
else
  echo "  FAILURES — A exit=$a, B exit=$b, B-ext exit=$be"
  exit 1
fi
