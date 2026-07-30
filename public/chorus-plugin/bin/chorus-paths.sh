#!/usr/bin/env bash
# chorus-paths.sh — single source of truth for the Claude Code plugin's
# GLOBAL local-state layout. Sourced by chorus-api.sh and every hook that
# touches state. NOT an executable subcommand — sourcing it defines the
# resolved path variables in the caller's shell.
#
# Layout (aligned with the daemon's global ~/.chorus/ convention):
#
#   ~/.chorus/plugin/<cwd-slug>/<sessionId>/
#     ├── state.json           (+ state.json.lock)
#     ├── sessions/            <agentName>.json
#     ├── pending/             PreToolUse:Task -> SubagentStart handoff
#     ├── claimed/             claimed pending files, keyed by agent_id
#     └── .mcp_headers.* / .mcp_response.*   MCP handshake temp files
#
# Inputs (env):
#   CHORUS_SESSION_ID          Claude Code session id (from a hook's stdin event).
#                              When empty, state falls back to a stable
#                              "<slug>/no-session" bucket so resolution NEVER fails.
#   CLAUDE_PROJECT_DIR         Project dir; defaults to $PWD.
#   CHORUS_PLUGIN_STATE_ROOT   Optional override of the global root (used by tests
#                              to point at a throwaway directory).
#
# Outputs (vars set in the caller's shell):
#   CHORUS_PLUGIN_ROOT         The global root (default ~/.chorus/plugin).
#   CHORUS_CWD_SLUG            Readable slug for the project dir.
#   CHORUS_STATE_DIR           The resolved per-session state directory.
#
# Design constraints:
#   - Pure variable assignment + function definitions. Runs no external command
#     that can make the *sourcing* shell exit non-zero (the slug helper is only
#     invoked to compute CHORUS_CWD_SLUG, and `sed` on a here-string cannot fail
#     the caller under `set -e` in the way a pipeline might — we keep it simple).
#   - Bash 3.2 compatible (macOS /bin/bash): no ${var//search/replace} global
#     substitution, no associative arrays, no `realpath`, no `readarray`.
#   - The resolved CHORUS_STATE_DIR is NEVER empty.

# --- 1. Global root (honor test override) --------------------------------
CHORUS_PLUGIN_ROOT="${CHORUS_PLUGIN_STATE_ROOT:-${HOME:-/tmp}/.chorus/plugin}"

# --- 2. cwd -> readable slug ---------------------------------------------
# Mirrors Claude Code's own ~/.claude/projects/<-abs-path> encoding:
# make the path absolute, strip trailing slashes, then replace every
# non-alphanumeric character with '-'. "/home/ubuntu/dev/ai-pm" becomes
# "-home-ubuntu-dev-ai-pm". This is a legible directory name, not a hash.
chorus_slug_for_dir() {
  local _csd_dir="${1:-$PWD}"
  # Make absolute without depending on realpath.
  case "$_csd_dir" in
    /*) : ;;
    *)  _csd_dir="$PWD/$_csd_dir" ;;
  esac
  printf '%s' "$_csd_dir" | sed -e 's#/*$##' -e 's#[^A-Za-z0-9]#-#g'
}

CHORUS_CWD_SLUG="$(chorus_slug_for_dir "${CLAUDE_PROJECT_DIR:-$PWD}")"

# --- 3. Per-session partition --------------------------------------------
# Every Claude Code hook event carries the same top-level session_id (sub-agents
# are distinguished by a separate agent_id), so all hooks in one session resolve
# to the same <sessionId> dir. When no session id is available (e.g. a hook with
# no stdin, or a manual invocation) fall back to a stable shared bucket so the
# path is always valid and non-empty.
_chorus_sid="${CHORUS_SESSION_ID:-}"
if [ -z "$_chorus_sid" ]; then
  _chorus_sid="no-session"
fi

CHORUS_STATE_DIR="${CHORUS_PLUGIN_ROOT}/${CHORUS_CWD_SLUG}/${_chorus_sid}"
