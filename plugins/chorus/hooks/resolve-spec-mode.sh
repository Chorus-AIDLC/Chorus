#!/usr/bin/env bash
# resolve-spec-mode.sh — resolve the active Chorus spec mode for a repo.
#
# Pure (env + filesystem only; no network). Sourced by on-session-start.sh and
# driven directly by tests/test-spec-mode-resolution.sh. Bash 3.2 compatible.
#
# Inputs (env):
#   CHORUS_SPEC_MODE                    explicit override: lite | openspec | off (else unset)
#   CHORUS_OPENSPEC_MODE                legacy opt-out: "off" disables OpenSpec
#   CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC plugin toggle: "false" disables OpenSpec (default "true")
#   PROJECT_ROOT                        repo root to probe for openspec/ (defaults to $PWD)
#   command -v openspec                 OpenSpec CLI presence on PATH
#
# Outputs (vars set in the caller's shell when sourced):
#   SPEC_MODE              lite | openspec | off      (value surfaced to Claude)
#   SPEC_REASON            human-readable one-liner
#   SPEC_FAIL              non-empty => stage skill MUST halt (unsatisfiable explicit openspec)
#   OPENSPEC_USABLE        1 | 0
#   OPENSPEC_USABLE_REASON human-readable
#   OPENSPEC_HINT          install hint when OpenSpec is merely missing (else empty)
#   CHORUS_OPENSPEC_ACTIVE 1 only when the resolved mode is a USABLE openspec
#
# Resolution (per owner): an explicit CHORUS_SPEC_MODE wins; when UNSET, OpenSpec
# stays the default whenever it is usable (openspec/ dir + CLI, not disabled), and
# lite is the fallback only when OpenSpec is absent or disabled.

: "${PROJECT_ROOT:=$PWD}"

# --- Is OpenSpec usable? (needs openspec/ dir + CLI on PATH + not disabled) ---
OPENSPEC_DISABLED=0
OPENSPEC_DISABLED_REASON=""
if [ "${CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC:-true}" != "true" ]; then
  OPENSPEC_DISABLED=1
  OPENSPEC_DISABLED_REASON="enableOpenSpec userConfig=false (plugin-level opt-out)"
elif [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
  OPENSPEC_DISABLED=1
  OPENSPEC_DISABLED_REASON="CHORUS_OPENSPEC_MODE=off (legacy opt-out)"
fi

OPENSPEC_USABLE=0
OPENSPEC_USABLE_REASON=""
OPENSPEC_HINT=""
if [ "$OPENSPEC_DISABLED" = "1" ]; then
  OPENSPEC_USABLE_REASON="$OPENSPEC_DISABLED_REASON"
elif [ ! -d "${PROJECT_ROOT}/openspec" ]; then
  OPENSPEC_USABLE_REASON="no openspec/ directory at ${PROJECT_ROOT}/openspec"
  OPENSPEC_HINT="npm i -g @fission-ai/openspec && openspec init"
elif ! command -v openspec >/dev/null 2>&1; then
  OPENSPEC_USABLE_REASON="openspec/ directory present but \`openspec\` CLI not on PATH"
  OPENSPEC_HINT="npm i -g @fission-ai/openspec"
else
  OPENSPEC_USABLE=1
  OPENSPEC_USABLE_REASON="openspec/ directory + openspec CLI both present"
fi

# --- Resolve CHORUS_SPEC_MODE ---
SPEC_FAIL=""
case "${CHORUS_SPEC_MODE:-}" in
  lite)
    SPEC_MODE="lite"
    SPEC_REASON="explicit — Chorus-native lightweight specs in .chorus/specs/<slug>/"
    ;;
  off)
    SPEC_MODE="off"
    SPEC_REASON="explicit — free-form, no spec artifact"
    ;;
  openspec)
    SPEC_MODE="openspec"
    if [ "$OPENSPEC_USABLE" = "1" ]; then
      SPEC_REASON="explicit; ${OPENSPEC_USABLE_REASON}"
    elif [ "$OPENSPEC_DISABLED" = "1" ]; then
      SPEC_REASON="explicit, but OpenSpec is disabled: ${OPENSPEC_USABLE_REASON}"
      SPEC_FAIL="config conflict — CHORUS_SPEC_MODE=openspec vs OpenSpec disabled (${OPENSPEC_USABLE_REASON}); re-enable OpenSpec or set CHORUS_SPEC_MODE=lite"
    else
      SPEC_REASON="explicit, but OpenSpec is not installed: ${OPENSPEC_USABLE_REASON}"
      SPEC_FAIL="OpenSpec not usable (${OPENSPEC_USABLE_REASON})"
    fi
    ;;
  "")
    # Unset: OpenSpec is the default when usable; lite is the fallback otherwise.
    if [ "$OPENSPEC_USABLE" = "1" ]; then
      SPEC_MODE="openspec"
      SPEC_REASON="default — ${OPENSPEC_USABLE_REASON}; set CHORUS_SPEC_MODE=lite for Chorus-native specs, =off to disable"
    else
      SPEC_MODE="lite"
      SPEC_REASON="default — OpenSpec not usable (${OPENSPEC_USABLE_REASON}); using Chorus-native lightweight specs in .chorus/specs/<slug>/"
    fi
    ;;
  *)
    # Unrecognized value: treat like unset (OpenSpec-if-usable, else lite).
    if [ "$OPENSPEC_USABLE" = "1" ]; then
      SPEC_MODE="openspec"
      SPEC_REASON="CHORUS_SPEC_MODE='${CHORUS_SPEC_MODE}' unrecognized; falling back to default (${OPENSPEC_USABLE_REASON})"
    else
      SPEC_MODE="lite"
      SPEC_REASON="CHORUS_SPEC_MODE='${CHORUS_SPEC_MODE}' unrecognized; OpenSpec not usable, defaulting to lite"
    fi
    ;;
esac

# Back-compat flag for the openspec-aware skill: active only when the resolved
# mode is a USABLE openspec.
if [ "$SPEC_MODE" = "openspec" ] && [ -z "$SPEC_FAIL" ]; then
  CHORUS_OPENSPEC_ACTIVE=1
else
  CHORUS_OPENSPEC_ACTIVE=0
fi
