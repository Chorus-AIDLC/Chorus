#!/usr/bin/env bash
# test-skill-harness-fidelity.sh — keep shipped skill/manifest/hook text from
# re-asserting claims that are false about the harnesses we ship to:
#
#   1. `TeamCreate` — a tool no harness in this repo exposes.
#   2. Five literal phrases promising a reviewer runs in the foreground / returns
#      its VERDICT inline, on the surfaces where that is untrue.
#   3. `.chorus/specs/TEMPLATE` — a path that exists nowhere on disk.
#   4. A proposal-reviewer definition — or the Kiro orchestrator/steering prose that
#      DESCRIBES the reviewers' tool grants — claiming the shell/Bash is unavailable:
#      false on all seven surfaces, and the claim that produced the "file is
#      missing" false positive this guard's check 4-6 exist to prevent.
#   5. A proposal-reviewer definition that does NOT carry the canonical read-only
#      shell rule (allowed commands + the confirm-before-flagging obligation).
#   6. Tool grants contradicting that rule: `Bash` back in the Claude Code agent's
#      `disallowedTools`, or `shell` dropped from Kiro's `tools`.
#
# SCOPE — read this before extending the guard. Checks 1-3 are a string blacklist,
# nothing more. They do NOT verify that the reviewer-wait contract or the
# round-qualified "read THIS round's VERDICT" instruction is present, correct, or
# even still in the file: deleting those paragraphs outright leaves all three checks
# green. That gate is held by review and by the acceptance criteria of the changes
# that write those paragraphs, not here. It also does NOT check that the spec-lite
# templates are inlined anywhere — deliberately, by owner decision.
#
# Checks 4-6 go one step further for the proposal-reviewer only (4 also covers the
# two Kiro docs that describe its grant to the orchestrator): 4 is a blacklist,
# but 5 REQUIRES two marker substrings and 6 inspects the two manifests that
# actually gate the capability. They still do not verify the full three-sentence
# wording — a surface could keep both markers while mangling the forbidden list.
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

# file_has <literal> <abs-path> — rc 0 when the file contains the literal, rc 1
# when it does not, rc>=2 when grep could not scan (missing/unreadable file).
#
# Unlike hits(), this is called DIRECTLY in an `if`, never inside `$( )`: a scan
# error has to be recorded for the parent shell, and an assignment made inside a
# command substitution is discarded when it ends. SCAN_ERR_FILE is a file for the
# same reason (see above) and works either way; the `if` form also keeps the rc
# distinction between "absent" (1) and "could not look" (>=2), which matters here
# because checks 5-6 REQUIRE a substring — an unreadable file would otherwise be
# indistinguishable from a file that legitimately lacks it.
file_has() {
  local _lit _path _rc _err
  _lit="$1"; _path="$2"
  _err="$(mktemp)"
  grep -qIF -- "$_lit" "$_path" 2>"$_err"
  _rc=$?
  if [ "$_rc" -ge 2 ]; then
    echo "$_lit @ $_path" >> "$SCAN_ERR_FILE"
    echo "  ERROR scan failed for \"$_lit\" in $_path (grep rc=$_rc) — a failed scan is not a PASS:" >&2
    sed 's/^/          /' "$_err" >&2
  fi
  rm -f "$_err"
  return "$_rc"
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

echo "skill/harness fidelity guard (checks 1-4 blacklist, 5-6 require — see header for what it does NOT cover):"
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

# ── The seven proposal-reviewer definitions ─────────────────────────────────
# Enumerated explicitly and NOT globbed, on purpose: shipping an eighth surface
# without adding it here is then a visible omission in this list rather than a
# silent pass by a glob that never saw the new file. A path listed here but absent
# on disk is a FAILURE, never a skip.
#
# Checks 4-6 are file-scoped, so this script spelling its own literals out cannot
# self-match the way checks 1-3 could — no SELF_REL exemption is needed or wanted.
PR_FILES='public/chorus-plugin/agents/proposal-reviewer.md
plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md
public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json
packages/chorus-pi/agents/chorus-proposal-reviewer.md
packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md
packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md
public/skill/proposal-reviewer-chorus/SKILL.md'

# ── Files in check 4's scope ONLY ────────────────────────────────────────────
# The Kiro orchestrator's own prompt and the Kiro steering doc are not reviewer
# definitions — they DESCRIBE the reviewers' tool grants to the main agent that
# spawns them. A false "the reviewer has no shell" claim here misleads the
# orchestrator just as badly as one in the reviewer's own file, so they belong in
# the blacklist check. They must NOT be added to PR_FILES: check 5 requires the
# canonical rule verbatim, which is a reviewer-definition obligation, and check 6
# reads manifests neither of these files is.
# Same contract as PR_FILES: enumerated, not globbed, and a missing path FAILS.
CHECK4_EXTRA_FILES='public/kiro-plugin/.kiro/agents/chorus.md
public/kiro-plugin/.kiro/steering/chorus.md'

# ── Check 4 — no surface claims the reviewer's shell is unavailable ──────────
# These are the exact assertions the seven files carried before the fix. Each is
# long enough to be unambiguous: the truthful prose every surface DOES keep —
# "Any shell command beyond read-only inspection — no file writes …" — must not
# match, so no bare "shell"/"Bash" substring appears in this list.
echo "Check 4 — no proposal-reviewer surface (or Kiro orchestrator/steering doc) claims shell/Bash is unavailable"
PATTERNS_SHELL_DISABLED='Bash is disabled
no `shell`
cannot run shell
Do NOT run Bash
or run Bash commands
Running any shell commands'
CHECK4_FAILED=0
CHECK4_FILES=0
while IFS= read -r _rel; do
  [ -n "$_rel" ] || continue
  CHECK4_FILES=$((CHECK4_FILES + 1))
  _abs="$ROOT/$_rel"
  if [ ! -f "$_abs" ]; then
    CHECK4_FAILED=1
    echo "  FAIL  enumerated surface MISSING (not skipped): $_rel"
    continue
  fi
  while IFS= read -r _pat; do
    [ -n "$_pat" ] || continue
    if file_has "$_pat" "$_abs"; then
      CHECK4_FAILED=1
      echo "  FAIL  shell-disabled claim \"$_pat\" — found in:"
      echo "          $_rel"
    fi
  done <<PATS4
$PATTERNS_SHELL_DISABLED
PATS4
done <<FILES4
$PR_FILES
$CHECK4_EXTRA_FILES
FILES4
if [ "$CHECK4_FAILED" -eq 0 ]; then
  PASS=$((PASS + 1))
  echo "  PASS  none of the 6 shell-disabled literals present in $CHECK4_FILES enumerated files"
else
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Check 5 — every surface carries the canonical read-only shell rule ───────
# Two markers, both required:
#   * "READ-ONLY inspection only" — NOT "Bash is READ-ONLY", because Kiro's tool is
#     named `shell` and its prompt reads "Shell is READ-ONLY inspection only".
#   * "no installs, no test/build runs" — the forbidden list. Proposal review runs
#     before any implementation exists, so test/build execution is out of scope here
#     even though the task- and code-reviewer are allowed it.
#   * "before flagging it as missing" — the existence-check obligation. Without it
#     the capability grant alone does not stop the false positive this change fixes,
#     since nothing obliges the reviewer to look before asserting a file is absent.
echo "Check 5 — every proposal-reviewer surface carries the canonical read-only rule"
CHECK5_FAILED=0
CHECK5_FILES=0
MARKERS_CANONICAL='READ-ONLY inspection only
no installs, no test/build runs
before flagging it as missing'
while IFS= read -r _rel; do
  [ -n "$_rel" ] || continue
  CHECK5_FILES=$((CHECK5_FILES + 1))
  _abs="$ROOT/$_rel"
  if [ ! -f "$_abs" ]; then
    CHECK5_FAILED=1
    echo "  FAIL  enumerated surface MISSING (not skipped): $_rel"
    continue
  fi
  while IFS= read -r _marker; do
    [ -n "$_marker" ] || continue
    if ! file_has "$_marker" "$_abs"; then
      CHECK5_FAILED=1
      echo "  FAIL  canonical rule marker \"$_marker\" MISSING from:"
      echo "          $_rel"
    fi
  done <<MARK5
$MARKERS_CANONICAL
MARK5
done <<FILES5
$PR_FILES
FILES5
if [ "$CHECK5_FAILED" -eq 0 ]; then
  PASS=$((PASS + 1))
  echo "  PASS  all 3 canonical markers present in all $CHECK5_FILES enumerated surfaces"
else
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Check 6 — the two manifests that actually gate the capability ────────────
# Prose granting read-only shell is a lie if the harness never hands the tool over.
# Claude Code and Kiro are the only two surfaces that enforce tool access; the other
# five have no enforcement mechanism, so there is nothing to assert about them.
echo "Check 6 — tool grants match the rule (Claude Code \`disallowedTools\`, Kiro \`tools\`)"
CHECK6_FAILED=0
CC_AGENT="$ROOT/public/chorus-plugin/agents/proposal-reviewer.md"
if [ ! -f "$CC_AGENT" ]; then
  CHECK6_FAILED=1
  echo "  FAIL  Claude Code agent MISSING: public/chorus-plugin/agents/proposal-reviewer.md"
elif ! file_has 'disallowedTools:' "$CC_AGENT"; then
  CHECK6_FAILED=1
  echo "  FAIL  no \`disallowedTools:\` key in public/chorus-plugin/agents/proposal-reviewer.md"
  echo "        (the guard cannot certify Bash is absent from a list it cannot find)"
else
  # The frontmatter list runs from `disallowedTools:` to the first line that is not
  # a `  - item` entry. awk, not a YAML parser — this is a 6-line literal block.
  # The key line itself is kept so YAML flow style (`disallowedTools: [Bash, Edit]`)
  # is covered too, and the match is word-boundary rather than a whole-line `- Bash`
  # so a quoted entry (`- "Bash"`) cannot slip through either.
  # Blank lines and `#` comments INSIDE the list are skipped rather than treated as
  # the end of it: YAML allows both, so exiting on one let `- Bash` placed after a
  # comment sit in the deny list while this check reported PASS.
  CC_BLOCK="$(awk '/^disallowedTools:/{f=1;print;next}
                   f&&/^[[:space:]]*$/{next}
                   f&&/^[[:space:]]*#/{next}
                   f&&/^[[:space:]]*-[[:space:]]/{print;next} f{exit}' "$CC_AGENT")"
  if printf '%s\n' "$CC_BLOCK" | grep -qw 'Bash'; then
    CHECK6_FAILED=1
    echo "  FAIL  \`- Bash\` is back in \`disallowedTools\` of:"
    echo "          public/chorus-plugin/agents/proposal-reviewer.md"
  fi
fi
KIRO_AGENT="$ROOT/public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json"
if [ ! -f "$KIRO_AGENT" ]; then
  CHECK6_FAILED=1
  echo "  FAIL  Kiro agent MISSING: public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json"
else
  # From the `"tools"` key to the line closing its array.
  KIRO_BLOCK="$(awk '/"tools"[[:space:]]*:/{f=1} f{print; if (/\]/) exit}' "$KIRO_AGENT")"
  if ! printf '%s\n' "$KIRO_BLOCK" | grep -qF '"shell"'; then
    CHECK6_FAILED=1
    echo "  FAIL  \`\"shell\"\` is not in the \`tools\` array of:"
    echo "          public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json"
  fi
fi
if [ "$CHECK6_FAILED" -eq 0 ]; then
  PASS=$((PASS + 1))
  echo "  PASS  Claude Code does not disallow Bash; Kiro grants \`shell\`"
else
  FAIL=$((FAIL + 1))
fi
echo ""

if [ -s "$SCAN_ERR_FILE" ]; then
  FAIL=$((FAIL + 1))
  echo "  FAIL  at least one grep could not scan its paths — see the ERROR lines above."
  echo "        A scan that never ran cannot certify anything; fix the paths and re-run."
  echo ""
fi

echo "Results: $PASS check(s) passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
