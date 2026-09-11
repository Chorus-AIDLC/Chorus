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
           "$_r/public/chorus-plugin/agents" \
           "$_r/public/kiro-plugin/.kiro/skills" \
           "$_r/public/kiro-plugin/.kiro/agents" \
           "$_r/public/kiro-plugin/.kiro/steering" \
           "$_r/public/skill/proposal-reviewer-chorus" \
           "$_r/packages/chorus-dsh/skills" \
           "$_r/packages/chorus-dsh/skills/proposal-reviewer-chorus" \
           "$_r/packages/chorus-pi/agents" \
           "$_r/packages/openclaw-plugin/skills/proposal-reviewer" \
           "$_r/plugins/chorus/skills" \
           "$_r/plugins/chorus/skills/chorus-proposal-reviewer" \
           "$_r/docs"
  printf 'clean skill text, wait using your harness mechanism\n' \
    > "$_r/public/chorus-plugin/skills/develop/SKILL.md"
  printf '# SPEC_LITE\nthe template is inlined here\n' > "$_r/docs/SPEC_LITE.md"
  cp "$GUARD" "$_r/public/chorus-plugin/bin/tests/$(basename "$GUARD")"

  # ── The seven proposal-reviewer surfaces, all carrying the canonical rule.
  # Checks 4-6 fail on a missing enumerated path, so a clean tree needs all seven
  # present AND compliant. The truthful "Any shell command beyond read-only
  # inspection —" sentence is included deliberately: it must not trip check 4.
  for _pr in "public/chorus-plugin/agents/proposal-reviewer.md" \
             "plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md" \
             "packages/chorus-pi/agents/chorus-proposal-reviewer.md" \
             "packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md" \
             "packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md" \
             "public/skill/proposal-reviewer-chorus/SKILL.md"; do
    printf 'Bash is READ-ONLY inspection only: ls, cat, grep/rg, find.\n' > "$_r/$_pr"
    printf 'No file writes, no git write ops, no installs, no test/build runs.\n' >> "$_r/$_pr"
    printf 'Any shell command beyond read-only inspection — no file writes.\n' >> "$_r/$_pr"
    printf 'Use it to confirm a file or directory exists before flagging it as missing.\n' >> "$_r/$_pr"
  done
  # Claude Code's file additionally needs the frontmatter list check 6 reads.
  cat > "$_r/public/chorus-plugin/agents/proposal-reviewer.md" <<'CCAGENT'
---
disallowedTools:
  - Agent
  - Edit
  - Write
---
Bash is READ-ONLY inspection only: ls, cat, grep/rg, find.
No file writes, no git write ops, no installs, no test/build runs.
Any shell command beyond read-only inspection — no file writes.
Use it to confirm a file or directory exists before flagging it as missing.
CCAGENT
  # Kiro states the rule inside a JSON prompt string and names its tool `shell`.
  cat > "$_r/public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json" <<'KIROAGENT'
{
  "name": "chorus-proposal-reviewer",
  "tools": [
    "read",
    "shell",
    "@chorus"
  ],
  "prompt": "Shell is READ-ONLY inspection only: ls, cat, grep/rg, find. No file writes, no git write ops, no installs, no test/build runs. Use it to confirm a file or directory exists before flagging it as missing."
}
KIROAGENT
  # ── Check 4's extra scope: the Kiro orchestrator prompt and steering doc.
  # Not reviewer definitions (so check 5 never looks at them), but they describe the
  # grant to the agent that spawns the reviewer — a false claim here misleads it.
  printf 'chorus-proposal-reviewer is scoped `tools: ["read", "shell", "@chorus"]`.\n' \
    > "$_r/public/kiro-plugin/.kiro/agents/chorus.md"
  printf 'chorus-proposal-reviewer is scoped `tools: ["read", "shell", "@chorus"]`.\n' \
    > "$_r/public/kiro-plugin/.kiro/steering/chorus.md"
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
  printf 'the launch returns the VERDICT inline\n' \
    >> "$R/public/chorus-plugin/skills/develop/SKILL.md"
  expect "check 2 catches 'returns the VERDICT inline'" "$R" nonzero

  # dsh legitimately keeps run_in_background: false, so only this exact
  # parenthesised imperative is blacklisted — not the flag itself.
  R="$(case_in "$dirname")"
  printf 'wait for it (do NOT set run_in_background)\n' \
    >> "$R/packages/chorus-dsh/skills/SKILL.md"
  expect "check 2 catches '(do NOT set run_in_background)' (dsh)" "$R" nonzero

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

  # dsh's real wording must stay green. If someone later replaces the literal
  # blacklist with a proximity rule pairing run_in_background against
  # "foreground"/"synchronous"/"inline", this case fails a correct tree — which
  # is exactly the regression the guard's header forbids.
  R="$(case_in "$dirname")"
  printf 'Spawn the reviewer with run_in_background: false and read its result.\n' \
    >> "$R/packages/chorus-dsh/skills/SKILL.md"
  expect "check 2 allows dsh's legitimate run_in_background: false" "$R" zero

  # A scan that cannot run must never look like "no hits".
  R="$(case_in "$dirname")"
  rm -rf "$R/packages/chorus-dsh"
  expect "missing scope path fails instead of passing" "$R" nonzero

  # ── Check 4 — shell-disabled claims, one fixture per phrasing family ──────
  R="$(case_in "$dirname")"
  printf -- '- **You are READ-ONLY.** Do NOT run Bash.\n' \
    >> "$R/packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md"
  expect "check 4 catches 'Do NOT run Bash' (dsh reviewer)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'You have `read` and `@chorus` tools — no `shell`, no `write`.\n' \
    >> "$R/public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json"
  expect "check 4 catches 'no \`shell\`' (kiro reviewer)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'Bash is disabled for this agent.\n' \
    >> "$R/packages/chorus-pi/agents/chorus-proposal-reviewer.md"
  expect "check 4 catches 'Bash is disabled' (pi reviewer)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'Running any shell commands is prohibited.\n' \
    >> "$R/plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md"
  expect "check 4 catches 'Running any shell commands' (codex reviewer)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'You cannot run shell commands.\n' \
    >> "$R/public/skill/proposal-reviewer-chorus/SKILL.md"
  expect "check 4 catches 'cannot run shell' (standalone skill)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'Do not edit files or run Bash commands.\n' \
    >> "$R/packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md"
  expect "check 4 catches 'or run Bash commands' (openclaw reviewer)" "$R" nonzero

  # Check 4's extra scope: the orchestrator prompt and the steering doc. These two
  # carried the "no `shell`" claim while sitting outside the guard, which is how the
  # false statement survived the fix — so each gets its own fixture.
  R="$(case_in "$dirname")"
  printf 'Each reviewer is scoped `tools: ["read", "@chorus"]`, no `shell`.\n' \
    >> "$R/public/kiro-plugin/.kiro/agents/chorus.md"
  expect "check 4 catches 'no \`shell\`' (kiro orchestrator prompt)" "$R" nonzero

  R="$(case_in "$dirname")"
  printf 'The reviewer cannot run shell commands.\n' \
    >> "$R/public/kiro-plugin/.kiro/steering/chorus.md"
  expect "check 4 catches 'cannot run shell' (kiro steering doc)" "$R" nonzero

  R="$(case_in "$dirname")"
  rm -f "$R/public/kiro-plugin/.kiro/agents/chorus.md"
  expect "a deleted check-4-only file fails instead of being skipped" "$R" nonzero

  # The clean tree passes with neither of those two files carrying the canonical
  # rule markers — that is check 5 correctly ignoring them (they are orchestrator
  # prose, not reviewer definitions). Adding them to PR_FILES would break it.

  # The truthful sentence every surface keeps must NOT trip check 4. This is the
  # false positive an under-anchored blacklist (a bare "shell"/"Bash") would cause.
  R="$(case_in "$dirname")"
  printf 'Any shell command beyond read-only inspection — no git write ops.\n' \
    >> "$R/public/skill/proposal-reviewer-chorus/SKILL.md"
  expect "check 4 allows the truthful 'beyond read-only inspection' prose" "$R" zero

  # ── Check 5 — the canonical rule must be present, all three markers ───────
  R="$(case_in "$dirname")"
  grep -v 'READ-ONLY inspection only' \
    "$R/packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md"
  expect "check 5 catches a missing read-only-inspection marker (openclaw)" "$R" nonzero

  R="$(case_in "$dirname")"
  grep -v 'before flagging it as missing' \
    "$R/packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md"
  expect "check 5 catches a missing existence-check obligation (dsh)" "$R" nonzero

  R="$(case_in "$dirname")"
  grep -v 'no installs, no test/build runs' \
    "$R/packages/chorus-pi/agents/chorus-proposal-reviewer.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/packages/chorus-pi/agents/chorus-proposal-reviewer.md"
  expect "check 5 catches a missing forbidden-command list (pi)" "$R" nonzero

  # ── Enumerated path deleted — must FAIL, never be silently skipped ────────
  R="$(case_in "$dirname")"
  rm -f "$R/public/skill/proposal-reviewer-chorus/SKILL.md"
  expect "a deleted enumerated surface fails instead of being skipped" "$R" nonzero

  # ── Check 6 — the tool grants behind the rule ────────────────────────────
  R="$(case_in "$dirname")"
  # awk, not `sed 's/…/…\n…/'` — BSD sed (macOS) does not expand \n in the
  # replacement, so the sed form would silently insert a literal "n" and the
  # fixture would prove nothing.
  awk '{print} /^  - Agent$/{print "  - Bash"}' \
    "$R/public/chorus-plugin/agents/proposal-reviewer.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/public/chorus-plugin/agents/proposal-reviewer.md"
  expect "check 6 catches '- Bash' re-added to disallowedTools (claude code)" "$R" nonzero

  # Two evasions of a whole-line `- Bash` match, both of which YAML accepts and a
  # harness would honour: flow style, and a quoted entry.
  R="$(case_in "$dirname")"
  awk '/^disallowedTools:$/{print "disallowedTools: [Bash, Agent, Edit, Write]"; skip=1; next}
       skip&&/^[[:space:]]*-[[:space:]]/{next} {skip=0; print}' \
    "$R/public/chorus-plugin/agents/proposal-reviewer.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/public/chorus-plugin/agents/proposal-reviewer.md"
  expect "check 6 catches Bash in a YAML flow-style disallowedTools (claude code)" "$R" nonzero

  R="$(case_in "$dirname")"
  awk '{print} /^  - Agent$/{print "  - \"Bash\""}' \
    "$R/public/chorus-plugin/agents/proposal-reviewer.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/public/chorus-plugin/agents/proposal-reviewer.md"
  expect "check 6 catches a quoted '- \"Bash\"' entry (claude code)" "$R" nonzero

  # Two more evasions YAML accepts inside the list: a `#` comment line and a blank
  # line before `- Bash`. An extractor that treats either as the end of the list
  # reports PASS on a tree whose deny list really does contain Bash.
  R="$(case_in "$dirname")"
  awk '{print} /^  - Agent$/{print "  # restrict shell"; print "  - Bash"}' \
    "$R/public/chorus-plugin/agents/proposal-reviewer.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/public/chorus-plugin/agents/proposal-reviewer.md"
  expect "check 6 catches '- Bash' after a comment line in the list (claude code)" "$R" nonzero

  R="$(case_in "$dirname")"
  awk '{print} /^  - Agent$/{print ""; print "  - Bash"}' \
    "$R/public/chorus-plugin/agents/proposal-reviewer.md" > "$R/tmp.md"
  mv "$R/tmp.md" "$R/public/chorus-plugin/agents/proposal-reviewer.md"
  expect "check 6 catches '- Bash' after a blank line in the list (claude code)" "$R" nonzero

  R="$(case_in "$dirname")"
  grep -v '"shell",' "$R/public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json" \
    > "$R/tmp.json"
  mv "$R/tmp.json" "$R/public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json"
  expect "check 6 catches \`shell\` dropped from kiro's tools" "$R" nonzero

  # A `Bash` mention elsewhere in the Claude Code agent body is not a tool denial —
  # only a `- Bash` entry inside the disallowedTools list is.
  R="$(case_in "$dirname")"
  printf 'Bash inspection findings belong in the VERDICT comment.\n' \
    >> "$R/public/chorus-plugin/agents/proposal-reviewer.md"
  expect "check 6 does not fire on 'Bash' outside the disallowedTools list" "$R" zero

  echo ""
done

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
