#!/usr/bin/env bash
# test-skill-harness-fidelity.sh — keep shipped skill/manifest/hook text from
# re-asserting three specific claims that are false about the harnesses we ship to:
#
#   1. `TeamCreate` — a tool no harness in this repo exposes.
#   2. Five literal phrases promising a reviewer runs in the foreground / returns
#      its VERDICT inline, on the surfaces where that is untrue.
#   3. `.chorus/specs/TEMPLATE` — a path that exists nowhere on disk.
#
# SCOPE — read this before extending the guard. It is a string blacklist, nothing
# more. It does NOT verify that the reviewer-wait contract or the round-qualified
# "read THIS round's VERDICT" instruction is present, correct, or even still in the
# file: deleting those paragraphs outright leaves all three checks green. That gate
# is held by review and by the acceptance criteria of the changes that write those
# paragraphs, not here. It also does NOT check that the spec-lite templates are
# inlined anywhere — deliberately, by owner decision.
#
# Bash 3.2 compatible.
set -u

# Repo root = four levels up from this script (tests → bin → chorus-plugin → public → repo).
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
# This guard and its negative-case harness both have to spell every blacklisted
# literal out in order to forbid / plant it, so both are excluded from their own
# scans. Nothing else is exempt — a violation hidden in these two files would go
# unseen, which is the same tradeoff every self-excluding linter makes.
SELF_REL="public/chorus-plugin/bin/tests/test-skill-harness-fidelity.sh"
SELF_REL2="public/chorus-plugin/bin/tests/test-skill-harness-fidelity-negative.sh"

if [ ! -d "$ROOT/public/chorus-plugin" ]; then
  echo "FATAL: repo root looks wrong (no public/chorus-plugin under $ROOT)" >&2
  exit 1
fi

PASS=0
FAIL=0

# --exclude-dir matches a directory BASENAME, not a path, so `worktrees` covers
# `.claude/worktrees/` (and any other worktrees dir) — intentionally broader.
EXCLUDES="--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=cdk.out --exclude-dir=worktrees --exclude-dir=.git"

# Scan-error flag. This is a FILE, not a shell variable, on purpose: every call
# site invokes hits() inside `$( )`, which runs it in a subshell — a variable
# assignment there is discarded when the substitution ends, so the guard would
# print the error and still exit 0. A file survives the subshell.
SCAN_ERR_FILE="$(mktemp)"
trap 'rm -f "$SCAN_ERR_FILE"' EXIT

# hits <literal> <path>... — print repo-relative files containing the literal,
# minus this guard's own source (it necessarily spells every pattern out).
#
# A grep that cannot scan is NOT a pass. grep exits 0 on match, 1 on no match and
# >=2 on error (unreadable path, missing directory, a path mangled by word
# splitting). Swallowing stderr and treating >=2 like "no match" is how a guard
# reports PASS while having searched nothing — so the rc is inspected and recorded
# in SCAN_ERR_FILE, which fails the run at the end. Every call site must pass each
# path as its own quoted argument for the same reason.
hits() {
  local _lit _out _rc _err
  _lit="$1"; shift
  _err="$(mktemp)"
  # shellcheck disable=SC2086
  _out="$(grep -rlIF $EXCLUDES -- "$_lit" "$@" 2>"$_err")"
  _rc=$?
  if [ "$_rc" -ge 2 ]; then
    echo "$_lit" >> "$SCAN_ERR_FILE"
    echo "  ERROR scan failed for \"$_lit\" (grep rc=$_rc) — a failed scan is not a PASS:" >&2
    sed 's/^/          /' "$_err" >&2
  fi
  rm -f "$_err"
  [ -n "$_out" ] || return 0
  printf '%s\n' "$_out" \
    | sed "s|^$ROOT/||" \
    | grep -v "^$SELF_REL\$" \
    | grep -v "^$SELF_REL2\$" \
    | sort
}

report() {
  local _label _found
  _label="$1"; _found="$2"
  if [ -z "$_found" ]; then
    PASS=$((PASS + 1)); echo "  PASS  $_label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL  $_label — found in:"
    echo "$_found" | sed 's/^/          /'
  fi
}

echo "skill/harness fidelity guard (string blacklist only — see header for what it does NOT cover):"
echo ""

# ── Check 1 — no TeamCreate anywhere in shipped files ────────────────────────
# packages/chorus-pi/test/{static.sh,README.md} name it in order to forbid it.
echo "Check 1 — no \`TeamCreate\` (no harness in this repo exposes it)"
FOUND=$(hits 'TeamCreate' "$ROOT/public" "$ROOT/plugins" "$ROOT/packages" \
  | grep -v '^packages/chorus-pi/test/static\.sh$' \
  | grep -v '^packages/chorus-pi/test/README\.md$')
report "no TeamCreate reference" "$FOUND"
echo ""

# ── Check 2 — no foreground / inline-VERDICT reviewer promise ────────────────
# Scoped to the surfaces where the promise is false: on Claude Code the sub-agent
# launch result is never the verdict, and Kiro/dsh word their waiting differently.
# packages/chorus-pi/ is EXCLUDED on purpose — its bundled `subagent` genuinely
# blocks and returns the VERDICT, so its skill says so truthfully.
# Literal phrases only. Do NOT add a proximity rule pairing `run_in_background`
# with "foreground"/"synchronous"/"inline": dsh legitimately keeps
# `run_in_background: false`, so such a rule would fail a correct tree.
echo "Check 2 — no foreground/inline-VERDICT reviewer promise (chorus-plugin, kiro-plugin, chorus-dsh)"
# Three separate quoted arguments, NOT one space-joined string: a repo checked out
# under a path containing a space (e.g. /Users/me/My Repos/Chorus) would have that
# string word-split into non-existent paths, grep would error, and the guard would
# have reported PASS having scanned nothing. Bash 3.2 has indexed arrays (only
# associative ones are 4+), so an array is fine here.
SCOPE2=("$ROOT/public/chorus-plugin" "$ROOT/public/kiro-plugin" "$ROOT/packages/chorus-dsh")
CHECK2_FAILED=0
# Bash 3.2: no arrays / no readarray — one literal per line, split on newlines.
PATTERNS_2='reviewer synchronously
returns the VERDICT inline
waits and returns the VERDICT
in **foreground**
(do NOT set run_in_background)'
OLD_IFS="$IFS"
IFS='
'
for pat in $PATTERNS_2; do
  IFS="$OLD_IFS"
  FOUND=$(hits "$pat" "${SCOPE2[@]}")
  if [ -n "$FOUND" ]; then
    CHECK2_FAILED=1
    echo "  FAIL  literal \"$pat\" — found in:"
    echo "$FOUND" | sed 's/^/          /'
  fi
  IFS='
'
done
IFS="$OLD_IFS"
if [ "$CHECK2_FAILED" -eq 0 ]; then
  PASS=$((PASS + 1)); echo "  PASS  none of the 5 blacklisted literals present"
else
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Check 3 — no dangling .chorus/specs/TEMPLATE path ───────────────────────
echo "Check 3 — no \`.chorus/specs/TEMPLATE\` path (no such directory is shipped)"
FOUND=$(hits '.chorus/specs/TEMPLATE' "$ROOT/public" "$ROOT/plugins" "$ROOT/packages" "$ROOT/docs/SPEC_LITE.md")
report "no .chorus/specs/TEMPLATE reference" "$FOUND"
echo ""

if [ -s "$SCAN_ERR_FILE" ]; then
  FAIL=$((FAIL + 1))
  echo "  FAIL  at least one grep could not scan its paths — see the ERROR lines above."
  echo "        A scan that never ran cannot certify anything; fix the paths and re-run."
  echo ""
fi

echo "Results: $PASS check(s) passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
