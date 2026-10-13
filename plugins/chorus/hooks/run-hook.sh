#!/usr/bin/env bash
# run-hook.sh — hook dispatcher shared by the Codex and TRAE CLI ports.
#
# Usage (from hooks.json):
#   ${PLUGIN_ROOT}/hooks/run-hook.sh <hook-name> [args...]
#
# Codex CLI and TRAE CLI install the SAME plugin package and the SAME
# hooks.json, so a TRAE-specific script needs a runtime selection point:
#
#   - TRAE runtime marker present AND hooks/trae/<hook-name>.sh exists
#       -> exec hooks/trae/<hook-name>.sh
#   - otherwise
#       -> exec hooks/<hook-name>.sh (the original Codex script, unedited)
#
# Either way the target is exec'd with the same stdin, args and env, so the
# Codex path's stdout/stderr/exit code are byte-identical to invoking the
# original script directly.
#
# TRAE runtime marker (determined empirically against traecli 0.209.1):
#   traecli exports NO TRAE-specific env var to hook processes (no TRAE_CLI,
#   and it does not export TRAE_HOME). It does export PLUGIN_ROOT (also
#   CLAUDE_PLUGIN_ROOT / PLUGIN_DATA), as a canonical (symlink-resolved) path
#   to the installed plugin under <trae-home>/plugins/cache/. The marker is
#   therefore: the plugin root (PLUGIN_ROOT, or this script's parent dir when
#   unset) resolves to a path inside "${TRAE_HOME:-$HOME/.trae}/plugins/".
#   Codex installs under "${CODEX_HOME:-$HOME/.codex}/plugins/", which never
#   matches.
#
#   CHORUS_HOOK_RUNTIME=trae|codex forces the choice (tests / manual runs).
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

HOOK_DIR="$(dirname "$0")"
HOOK_NAME="${1:-}"

case "$HOOK_NAME" in
  ""|*/*|.*|*[!A-Za-z0-9._-]*)
    echo "run-hook.sh: invalid hook name '${HOOK_NAME}'" >&2
    exit 2
    ;;
esac
shift

# Returns 0 when this hook process runs under TRAE CLI.
chorus_is_trae_runtime() {
  case "${CHORUS_HOOK_RUNTIME:-}" in
    trae) return 0 ;;
    codex) return 1 ;;
  esac

  local root root_p trae_home plugins_p
  root="${PLUGIN_ROOT:-}"
  if [ -z "$root" ]; then
    root="${HOOK_DIR}/.."
  fi
  root_p=$(cd "$root" 2>/dev/null && pwd -P) || return 1
  [ -n "$root_p" ] || return 1

  trae_home="${TRAE_HOME:-}"
  if [ -z "$trae_home" ]; then
    [ -n "${HOME:-}" ] || return 1
    trae_home="${HOME}/.trae"
  fi
  plugins_p=$(cd "${trae_home}/plugins" 2>/dev/null && pwd -P) || return 1
  [ -n "$plugins_p" ] || return 1

  case "${root_p}/" in
    "${plugins_p}/"*) return 0 ;;
  esac
  return 1
}

if [ -f "${HOOK_DIR}/trae/${HOOK_NAME}.sh" ] && chorus_is_trae_runtime; then
  exec "${HOOK_DIR}/trae/${HOOK_NAME}.sh" "$@"
fi

exec "${HOOK_DIR}/${HOOK_NAME}.sh" "$@"
