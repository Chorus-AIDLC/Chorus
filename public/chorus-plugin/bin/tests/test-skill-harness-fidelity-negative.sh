#!/usr/bin/env bash
# test-skill-harness-fidelity-negative.sh — negative cases for the fidelity guard.
#
# A blacklist guard that passes on a tree it never scanned is worse than no guard,
# so this harness plants each blacklisted literal into a synthetic repo and asserts
# the guard actually FAILS. Every case runs twice: once under a plain path and once
# under a path containing a space, because the original guard word-split its scope
# string and reported "3 PASS" on a repo checked out under e.g.
# "/Users/me/My Repos/Chorus" while having searched nothing.
#
# Bash 3.2 compatible.
set -u

GUARD="$(cd "$(dirname "$0")" && pwd)/test-skill-harness-fidelity.sh"
if [ ! -x "$GUARD" ]; then
  echo "FATAL: guard not found or not executable at $GUARD" >&2
  exit 1
fi

PASS=0
FAIL=0
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# scaffold <repo-root> — a minimal tree with every path the guard scans, all clean.
# Missing paths are themselves a scan error now, so the clean case must be complete.
scaffold() {
  _r="$1"
  mkdir -p "$_r/public/chorus-plugin/bin/tests" \
           "$_r/public/chorus-plugin/skills/develop" \
           "$_r/public/kiro-plugin/.kiro/skills" \
           "$_r/packages/chorus-dsh/skills" \
           "$_r/plugins/chorus/skills" \
           "$_r/docs"
  printf 'clean skill text, wait using your harness mechanism\n' \
    > "$_r/public/chorus-plugin/skills/develop/SKILL.md"
  printf '# SPEC_LITE\nthe template is inlined here\n' > "$_r/docs/SPEC_LITE.md"
  cp "$GUARD" "$_r/public/chorus-plugin/bin/tests/$(basename "$GUARD")"
}

# run_guard <repo-root> — echo the guard's exit code, discarding its output.
run_guard() {
  "$1/public/chorus-plugin/bin/tests/$(basename "$GUARD")" >/dev/null 2>&1
  echo $?
}

# expect <label> <repo-root> <want-rc-zero|want-rc-nonzero>
expect() {
  _label="$1"; _r="$2"; _want="$3"
  _rc="$(run_guard "$_r")"
  case "$_want" in
    zero)    if [ "$_rc" -eq 0 ]; then PASS=$((PASS+1)); echo "  PASS  $_label (exit 0)"
             else FAIL=$((FAIL+1)); echo "  FAIL  $_label — wanted exit 0, got $_rc"; fi ;;
    nonzero) if [ "$_rc" -ne 0 ]; then PASS=$((PASS+1)); echo "  PASS  $_label (exit $_rc)"
             else FAIL=$((FAIL+1)); echo "  FAIL  $_label — guard reported PASS but the literal is present"; fi ;;
  esac
}

# case_in <dirname> — build a fresh scaffold under TMPROOT/<dirname>, echo its path.
case_in() {
  _d="$TMPROOT/$1"
  rm -rf "$_d"; mkdir -p "$_d"
  scaffold "$_d"
  echo "$_d"
}

echo "skill/harness fidelity guard — negative cases (plain path AND path with a space):"
echo ""

for dirname in "plain" "with spaces"; do
  echo "--- repo root: .../$dirname"

  R="$(case_in "$dirname")"
  expect "clean tree passes" "$R" zero

  R="$(case_in "$dirname")"
  printf 'Use TeamCreate to spawn the team\n' >> "$R/plugins/chorus/skills/note.md"
  expect "check 1 catches TeamCreate" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'Run the reviewer synchronously and read the result\n' \
    >> "$R/public/chorus-plugin/skills/develop/SKILL.md"
  expect "check 2 catches 'reviewer synchronously'" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'the subagent waits and returns the VERDICT to you\n' \
    >> "$R/public/kiro-plugin/.kiro/skills/SKILL.md"
  expect "check 2 catches 'waits and returns the VERDICT' (kiro)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'spawn it in **foreground** so it blocks\n' >> "$R/packages/chorus-dsh/skills/SKILL.md"
  expect "check 2 catches 'in **foreground**' (dsh)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'Copy .chorus/specs/TEMPLATE/spec.md to start\n' >> "$R/docs/SPEC_LITE.md"
  expect "check 3 catches .chorus/specs/TEMPLATE" "$R" nonzero

  # chorus-pi is excluded from check 2 on purpose: its blocking `subagent` really
  # does return the VERDICT, so the phrase is true there and must NOT trip a FAIL.
  R="$(case_in "$dirname")"
  mkdir -p "$R/packages/chorus-pi/skills"
  printf 'the blocking subagent waits and returns the VERDICT\n' \
    >> "$R/packages/chorus-pi/skills/SKILL.md"
  expect "check 2 still exempts packages/chorus-pi" "$R" zero

  # A scan that cannot run must never look like "no hits".
  R="$(case_in "$dirname")"
  rm -rf "$R/packages/chorus-dsh"
  expect "missing scope path fails instead of passing" "$R" nonzero

  echo ""
done

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
