#!/usr/bin/env bash
# test-spec-mode-resolution.sh — unit test for resolve-spec-mode.sh.
#
# resolve-spec-mode.sh is pure (env + filesystem only), so we drive it directly
# in subshells across the resolution matrix: explicit CHORUS_SPEC_MODE
# {lite, openspec, off, <invalid>} × OpenSpec {usable, missing, disabled} + unset.
# We simulate "OpenSpec usable" with a temp PROJECT_ROOT containing an openspec/
# dir plus a fake `openspec` on PATH; "missing" by dropping one of those; and
# "disabled" via CHORUS_OPENSPEC_MODE=off / CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC=false.
#
# Owner contract: explicit mode wins; UNSET → OpenSpec when usable, else lite.
# Bash 3.2 compatible (no associative arrays, no ${var,,}).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="${HERE}/../resolve-spec-mode.sh"
[ -f "$RESOLVER" ] || { echo "FATAL: resolver not found at $RESOLVER" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A repo root WITH an openspec/ dir, and one WITHOUT.
ROOT_WITH="$TMP/with"; mkdir -p "$ROOT_WITH/openspec"
ROOT_WITHOUT="$TMP/without"; mkdir -p "$ROOT_WITHOUT"

# A fake `openspec` CLI on PATH; and a clean PATH that lacks openspec.
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
printf '#!/bin/sh\nexit 0\n' > "$FAKEBIN/openspec"; chmod +x "$FAKEBIN/openspec"
CLEAN_PATH="/usr/bin:/bin"
command -v openspec >/dev/null 2>&1 && [ -x "$(command -v openspec)" ] # informational only
# Sanity: ensure the clean PATH really lacks openspec, else the "missing CLI"
# cases would be invalid on this machine.
if PATH="$CLEAN_PATH" command -v openspec >/dev/null 2>&1; then
  echo "FATAL: openspec is on the clean PATH ($CLEAN_PATH); cannot simulate missing CLI" >&2
  exit 1
fi
PATH_WITH_CLI="$FAKEBIN:$CLEAN_PATH"

PASS=0; FAIL=0

# run <label> <expect_mode> <expect_active> <expect_fail:ok|fail> -- env assignments...
run() {
  label="$1"; exp_mode="$2"; exp_active="$3"; exp_fail="$4"; shift 4
  [ "$1" = "--" ] && shift
  out="$(env -i HOME="$HOME" "$@" bash -c '
    . "'"$RESOLVER"'" >/dev/null 2>&1
    if [ -n "${SPEC_FAIL:-}" ]; then f=fail; else f=ok; fi
    printf "%s|%s|%s" "${SPEC_MODE:-}" "${CHORUS_OPENSPEC_ACTIVE:-}" "$f"
  ')"
  want="${exp_mode}|${exp_active}|${exp_fail}"
  if [ "$out" = "$want" ]; then
    PASS=$((PASS+1)); printf '  PASS  %s\n' "$label"
  else
    FAIL=$((FAIL+1)); printf '  FAIL  %s\n        want [%s] got [%s]\n' "$label" "$want" "$out"
  fi
}

echo "spec-mode resolution matrix:"

# --- unset ---
run "unset + usable → openspec"          openspec 1 ok -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH"
run "unset + no openspec dir → lite"     lite 0 ok     -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITHOUT"
run "unset + dir but no CLI → lite"      lite 0 ok     -- PATH="$CLEAN_PATH"   PROJECT_ROOT="$ROOT_WITH"
run "unset + disabled(off) → lite"       lite 0 ok     -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CHORUS_OPENSPEC_MODE=off
run "unset + disabled(toggle) → lite"    lite 0 ok     -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC=false

# --- explicit lite / off ---
run "lite + usable → lite"               lite 0 ok     -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CHORUS_SPEC_MODE=lite
run "off + usable → off"                 off 0 ok      -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CHORUS_SPEC_MODE=off

# --- explicit openspec ---
run "openspec + usable → openspec"       openspec 1 ok   -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CHORUS_SPEC_MODE=openspec
run "openspec + no dir → FAIL"           openspec 0 fail -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITHOUT" CHORUS_SPEC_MODE=openspec
run "openspec + no CLI → FAIL"           openspec 0 fail -- PATH="$CLEAN_PATH"   PROJECT_ROOT="$ROOT_WITH" CHORUS_SPEC_MODE=openspec
run "openspec + disabled → FAIL"         openspec 0 fail -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CHORUS_SPEC_MODE=openspec CHORUS_OPENSPEC_MODE=off

# --- invalid value falls back to default resolution ---
run "invalid + usable → openspec"        openspec 1 ok -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITH" CHORUS_SPEC_MODE=bogus
run "invalid + no dir → lite"            lite 0 ok     -- PATH="$PATH_WITH_CLI" PROJECT_ROOT="$ROOT_WITHOUT" CHORUS_SPEC_MODE=bogus

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
