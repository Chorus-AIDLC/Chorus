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
# $() captures the real bun exit code — a pipe to tail would mask it with
# tail's own (always 0) status.
b=$(bun test test/lib.test.ts 2>&1); brc=$?
printf '%s\n' "$b" | tail -6
b=$brc
echo ""
echo "──────── Layer B: extension events ────────"
# Drive the real chorus.ts factory with a fake pi + mocked fetch (no network).
# Runs in its own bun invocation for isolation — it overrides global fetch at
# module load. Covers the P1-1/P1-2/P1-3/P2-1 session-lifecycle fixes.
ev=$(bun test test/ext-events.test.ts 2>&1); berc=$?
printf '%s\n' "$ev" | tail -8
be=$berc
echo ""
echo "──────── Layer B: bundled agents frontmatter ────────"
# PR #572 review regression: an unquoted YAML scalar in an agent description
# (a `tasks: [...]` example) made parseFrontmatter throw at first dispatch,
# blocking discovery of the whole bundled dir. Every shipped agents/*.md must
# parse with the runtime parser and pass loadAgentsFromDir's acceptance line.
bag=$(bun test test/agents.test.ts 2>&1); barc=$?
printf '%s\n' "$bag" | tail -6
ba=$barc
echo ""
echo ""
echo "══════════════════════════════════════════"
if [ $a -eq 0 ] && [ $b -eq 0 ] && [ $be -eq 0 ] && [ $ba -eq 0 ]; then
  echo "  ALL OFFLINE TESTS PASSED (A: static, B: unit + extension events + agents)"
  exit 0
else
  echo "  FAILURES — A exit=$a, B exit=$b, B-ext exit=$be, B-agents exit=$ba"
  exit 1
fi
