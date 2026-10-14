#!/usr/bin/env bash
# hook-runtime.sh — shared helpers for the Codex / TRAE CLI hook scripts
# (sourced, never executed).
#
# Codex CLI and TRAE CLI install the SAME plugin package and run the SAME
# hooks/*.sh scripts. These helpers cover the two places where the runtimes
# differ:
#
#   chorus_hook_runtime <hooks-dir>
#     Prints "trae" or "codex". traecli 0.209.1 exports no TRAE-specific env
#     var to hook processes (no TRAE_CLI; TRAE_HOME is not exported either),
#     but it does export PLUGIN_ROOT as the canonical (symlink-resolved) path
#     of the installed plugin under <trae-home>/plugins/cache/. The marker is:
#     the plugin root (PLUGIN_ROOT, or <hooks-dir>/.. when unset) resolves,
#     via `pwd -P`, inside "${TRAE_HOME:-$HOME/.trae}/plugins/". Codex installs
#     under "${CODEX_HOME:-$HOME/.codex}/plugins/", which never matches, so
#     Codex is the default. CHORUS_HOOK_RUNTIME=trae|codex forces the choice
#     (tests / manual runs).
#
#   chorus_event_uuid <event-json> <field>
#     Prints the entity UUID for <field> (taskUuid | proposalUuid) from a
#     PostToolUse event, or nothing. The top-level `tool_response` may be an
#     object (Codex; direct calls on TRAE) or a JSON-ENCODED STRING (TRAE
#     code-mode / nested calls); TRAE also sends a nested
#     `post_tool_use.{tool_input,tool_response}` copy. Every shape is accepted
#     and no shape can abort the filter, so the tool_input fallback always
#     runs. Resolution order: tool_response content[0].text JSON .<field> /
#     .uuid, then tool_input.<field>, then post_tool_use.tool_input.<field>.
#
# Bash 3.2 compatible (CLAUDE.md pitfall #10).

chorus_hook_runtime() {
  case "${CHORUS_HOOK_RUNTIME:-}" in
    trae) echo trae; return 0 ;;
    codex) echo codex; return 0 ;;
  esac

  local hooks_dir root root_p trae_home plugins_p
  hooks_dir="${1:-.}"
  root="${PLUGIN_ROOT:-}"
  if [ -z "$root" ]; then
    root="${hooks_dir}/.."
  fi
  root_p=$(cd "$root" 2>/dev/null && pwd -P) || root_p=""

  trae_home="${TRAE_HOME:-}"
  if [ -z "$trae_home" ] && [ -n "${HOME:-}" ]; then
    trae_home="${HOME}/.trae"
  fi
  plugins_p=""
  if [ -n "$trae_home" ]; then
    plugins_p=$(cd "${trae_home}/plugins" 2>/dev/null && pwd -P) || plugins_p=""
  fi

  if [ -n "$root_p" ] && [ -n "$plugins_p" ]; then
    case "${root_p}/" in
      "${plugins_p}/"*) echo trae; return 0 ;;
    esac
  fi
  echo codex
}

chorus_event_uuid() {
  local event="${1:-}"
  local field="${2:-}"
  [ -n "$event" ] || return 0
  [ -n "$field" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  printf '%s' "$event" | jq -r --arg f "$field" '
    def decode: if type == "string" then (try fromjson catch null) else . end;
    def as_obj: if type == "object" then . else {} end;
    def text_of: (try (.content[0].text) catch null) // "";
    (((try .tool_response catch null) | decode)
      // ((try .post_tool_use.tool_response catch null) | decode)) as $r
    | (if ($r | type) == "object" then ($r | text_of) else "" end) as $t
    | ($t | if type == "string" then (try fromjson catch null) else null end | as_obj) as $tj
    | (.tool_input | as_obj) as $in
    | (.post_tool_use | as_obj | .tool_input | as_obj) as $pin
    | ($tj[$f] // $tj.uuid // $in[$f] // $pin[$f] // empty)
    | if type == "string" then . else empty end
  ' 2>/dev/null || true
}
