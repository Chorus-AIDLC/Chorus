#!/usr/bin/env bash
# test-on-post-verify-task.sh — Fixture-based shell test for the
# on-post-verify-task.sh hooks (Claude Code + Codex variants).
#
# We can't talk to a real Chorus backend in CI, so we shim out the MCP
# wrapper and the openspec CLI: the test creates a sandbox PATH and a
# replacement "chorus-api.sh" / "chorus-mcp-call.sh" that echo canned JSON
# responses keyed off the (tool_name, fixture_id) pair carried via the
# CHORUS_FIXTURE env var. The replacement scripts are invoked because the
# hook resolves them by directory next to itself (Claude Code) or sources
# hook-output.sh by directory (Codex). We exploit this by COPYING the
# hook into a sandbox dir alongside our shim wrapper — the hook's
# `dirname "$0"` lookup then picks up our shim, not the real wrapper.
#
# Fixtures cover all gating branches:
#   positive       — last task verified, slug present, openspec/ folder + CLI both present
#                    -> stdout MUST contain `openspec archive my-feature`
#   not-last-task  — slug present, both signals present, but one task still in_progress
#                    -> stdout MUST NOT contain `openspec archive`
#   no-slug        — proposal description has no `OpenSpec change slug:` line
#                    -> stdout MUST NOT contain `openspec archive`
#   no-cli         — openspec/ folder present but `openspec` CLI not on PATH
#                    -> stdout MUST NOT contain `openspec archive`
#   no-folder      — CLI on PATH but no openspec/ directory in project root
#                    -> stdout MUST NOT contain `openspec archive`
#   mode-off       — CHORUS_OPENSPEC_MODE=off (explicit opt-out), even with both signals present
#                    -> stdout MUST NOT contain `openspec archive`
#
# All fixtures must end with exit 0.
#
# Bash 3.2 compatible. Run:
#   /bin/bash public/chorus-plugin/bin/tests/test-on-post-verify-task.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CLAUDE_HOOK="$REPO_ROOT/public/chorus-plugin/bin/on-post-verify-task.sh"
CODEX_HOOK="$REPO_ROOT/plugins/chorus/hooks/on-post-verify-task.sh"
CODEX_HOOK_OUTPUT="$REPO_ROOT/plugins/chorus/hooks/hook-output.sh"

[ -x "$CLAUDE_HOOK" ] || { echo "FAIL: $CLAUDE_HOOK is not executable" >&2; exit 1; }
[ -x "$CODEX_HOOK" ]  || { echo "FAIL: $CODEX_HOOK is not executable" >&2; exit 1; }

PASS=0
FAIL=0
FAILED=""

# ----- Build sandbox -----

SANDBOX=$(mktemp -d)
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

# Sandbox layout:
#   $SANDBOX/claude/    — copy of Claude hook + shim chorus-api.sh
#   $SANDBOX/codex/     — copy of Codex hook + shim chorus-mcp-call.sh + real hook-output.sh
#   $SANDBOX/bin/       — fake openspec CLI on PATH
#   $SANDBOX/project/   — synthetic project root (contains openspec/ for fixtures
#                         that need the folder signal to be present)
mkdir -p "$SANDBOX/claude" "$SANDBOX/codex" "$SANDBOX/bin" "$SANDBOX/project/openspec"

cp "$CLAUDE_HOOK" "$SANDBOX/claude/on-post-verify-task.sh"
cp "$CODEX_HOOK"  "$SANDBOX/codex/on-post-verify-task.sh"
cp "$CODEX_HOOK_OUTPUT" "$SANDBOX/codex/hook-output.sh"
chmod +x "$SANDBOX/claude/on-post-verify-task.sh" "$SANDBOX/codex/on-post-verify-task.sh"

# ----- Shim: chorus-api.sh (Claude Code shape) -----
# Subcommand interface:
#   chorus-api.sh mcp-tool <tool> <json_args>   -> echo canned JSON
#   chorus-api.sh hook-output "" "$CONTEXT" "PostToolUse"
# We delegate hook-output to a real jq invocation so the emitted JSON
# matches the production wrapper's shape.
cat > "$SANDBOX/claude/chorus-api.sh" <<'SHIM_CLAUDE'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  mcp-tool)
    tool="$1"
    # CHORUS_FIXTURE picks the canned response set. Some fixtures
    # (mode-off / no-folder / no-cli) test the OpenSpec gates that fire
    # BEFORE any MCP call; we route them to the same canned data as
    # "positive" so that if a gate is silently broken the hook reaches
    # MCP, gets a positive result, and emits an archive reminder —
    # failing the "no archive reminder" assertion. Without this aliasing
    # the test would pass for the wrong reason (silent-skip at empty
    # TASK_JSON instead of at the gate).
    fixture="${CHORUS_FIXTURE:-positive}"
    case "$fixture" in
      mode-off|no-folder|no-cli) fixture=positive ;;
    esac
    case "${fixture}:${tool}" in
      positive:chorus_get_task)
        echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      positive:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-1","title":"P1","description":"Some intro line.\nOpenSpec change slug: my-feature\nMore body.","inputUuids":["idea-1"]}'
        ;;
      positive:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
        ;;
      not-last-task:chorus_get_task)
        echo '{"uuid":"task-2","title":"Task 2","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      not-last-task:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-1","title":"P1","description":"Intro.\nOpenSpec change slug: my-feature\nMore.","inputUuids":["idea-1"]}'
        ;;
      not-last-task:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"in_progress"}],"total":3,"page":1,"pageSize":200}'
        ;;
      no-slug:chorus_get_task)
        echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-2","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      no-slug:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-2","title":"P2","description":"Free-form proposal description with no slug marker.","inputUuids":["idea-2"]}'
        ;;
      no-slug:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
        ;;
      *)
        # Unhandled (tool, fixture) — return empty, hook should silent-skip.
        echo ""
        ;;
    esac
    ;;
  hook-output)
    sm="${1:-}"; ac="${2:-}"; hen="${3:-}"
    if [ -n "$ac" ]; then
      jq -n --arg sm "$sm" --arg ac "$ac" --arg hen "$hen" \
        '{systemMessage:$sm, hookSpecificOutput:{hookEventName:$hen, additionalContext:$ac}}'
    else
      jq -n --arg sm "$sm" '{systemMessage:$sm}'
    fi
    ;;
  *)
    echo "shim chorus-api.sh: unknown cmd $cmd" >&2; exit 2 ;;
esac
SHIM_CLAUDE
chmod +x "$SANDBOX/claude/chorus-api.sh"

# ----- Shim: chorus-mcp-call.sh (Codex shape) -----
# Codex wrapper interface:
#   chorus-mcp-call.sh <tool> <json_args>   -> echo canned JSON
cat > "$SANDBOX/codex/chorus-mcp-call.sh" <<'SHIM_CODEX'
#!/usr/bin/env bash
set -euo pipefail
tool="${1:-}"
# Alias gate-test fixtures to "positive" canned data so a broken gate
# would let the hook proceed and emit an archive reminder, failing the
# "no archive reminder" assertion. See claude shim for full rationale.
fixture="${CHORUS_FIXTURE:-positive}"
case "$fixture" in
  mode-off|no-folder|no-cli) fixture=positive ;;
esac
case "${fixture}:${tool}" in
  positive:chorus_get_task)
    echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  positive:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-1","title":"P1","description":"Some intro line.\nOpenSpec change slug: my-feature\nMore body.","inputUuids":["idea-1"]}'
    ;;
  positive:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
    ;;
  not-last-task:chorus_get_task)
    echo '{"uuid":"task-2","title":"Task 2","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  not-last-task:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-1","title":"P1","description":"Intro.\nOpenSpec change slug: my-feature\nMore.","inputUuids":["idea-1"]}'
    ;;
  not-last-task:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"in_progress"}],"total":3,"page":1,"pageSize":200}'
    ;;
  no-slug:chorus_get_task)
    echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-2","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  no-slug:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-2","title":"P2","description":"Free-form proposal description with no slug marker.","inputUuids":["idea-2"]}'
    ;;
  no-slug:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
    ;;
  *)
    echo "" ;;
esac
SHIM_CODEX
chmod +x "$SANDBOX/codex/chorus-mcp-call.sh"

# ----- Fake `openspec` on PATH -----
# Default behavior: `openspec --version` exits 0. The "no-openspec"
# fixture rebuilds PATH without this dir to simulate CLI absence.
cat > "$SANDBOX/bin/openspec" <<'OPENSPEC_FAKE'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "openspec 0.0.0-fixture"; exit 0 ;;
  *) echo "openspec fixture: ignoring $*"; exit 0 ;;
esac
OPENSPEC_FAKE
chmod +x "$SANDBOX/bin/openspec"

# ----- Synthetic PostToolUse event JSON -----
EVENT_JSON='{"tool_name":"chorus_admin_verify_task","tool_input":{"taskUuid":"task-3"},"tool_response":{"uuid":"task-3","status":"done","title":"Task 3"}}'

# ----- Test runner -----

# Args: name fixture variant expected_substring should_contain
# variant in {claude, codex}
# should_contain: "yes" -> stdout MUST contain expected_substring
# should_contain: "no"  -> stdout MUST NOT contain "openspec archive"
run_one() {
  local name="$1"
  local fixture="$2"
  local variant="$3"
  local should_contain="$4"
  local expected="$5"

  local hook_dir
  if [ "$variant" = "claude" ]; then
    hook_dir="$SANDBOX/claude"
  else
    hook_dir="$SANDBOX/codex"
  fi

  # Build PATH:
  # - default fixtures get $SANDBOX/bin (where the fake openspec lives)
  #   prepended in front of the inherited PATH;
  # - "no-cli" needs to actually have NO openspec on PATH. Just removing
  #   $SANDBOX/bin isn't enough — the dev machine often has a real
  #   openspec under ~/.nvm/.../bin or similar. So for no-cli we strip
  #   every PATH entry that contains an `openspec` executable.
  local PATH_FOR_RUN
  if [ "$fixture" = "no-cli" ]; then
    local _filtered=""
    local _entry
    for _entry in $(printf '%s' "$PATH" | tr ':' '\n'); do
      if [ -z "$_entry" ]; then continue; fi
      if [ -x "$_entry/openspec" ]; then continue; fi
      if [ -n "$_filtered" ]; then
        _filtered="$_filtered:$_entry"
      else
        _filtered="$_entry"
      fi
    done
    PATH_FOR_RUN="$_filtered"
  else
    PATH_FOR_RUN="$SANDBOX/bin:$PATH"
  fi

  # Pick the working directory + CLAUDE_PROJECT_DIR. The "no-folder"
  # fixture points the hook at $SANDBOX (which contains no openspec/),
  # everything else uses $SANDBOX/project (which has openspec/).
  local PROJECT_DIR_FOR_RUN
  if [ "$fixture" = "no-folder" ]; then
    PROJECT_DIR_FOR_RUN="$SANDBOX"
  else
    PROJECT_DIR_FOR_RUN="$SANDBOX/project"
  fi

  # The "mode-off" fixture sets the explicit-opt-out env var; everything
  # else leaves it unset.
  local MODE_VAR_FOR_RUN=""
  if [ "$fixture" = "mode-off" ]; then
    MODE_VAR_FOR_RUN="off"
  fi

  local stdout_file
  stdout_file=$(mktemp)
  local stderr_file
  stderr_file=$(mktemp)
  local rc=0

  printf '%s' "$EVENT_JSON" \
    | env -i \
        HOME="$HOME" \
        CHORUS_FIXTURE="$fixture" \
        PATH="$PATH_FOR_RUN" \
        CLAUDE_PROJECT_DIR="$PROJECT_DIR_FOR_RUN" \
        CHORUS_OPENSPEC_MODE="$MODE_VAR_FOR_RUN" \
        /bin/bash -c "cd \"$PROJECT_DIR_FOR_RUN\" && /bin/bash \"$hook_dir/on-post-verify-task.sh\"" \
        >"$stdout_file" 2>"$stderr_file" || rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "  FAIL  $name [$variant] exit=$rc"
    sed 's/^/         /' "$stderr_file"
    FAIL=$((FAIL + 1))
    FAILED="$FAILED $name[$variant]"
    rm -f "$stdout_file" "$stderr_file"
    return
  fi

  local stdout
  stdout=$(cat "$stdout_file")
  rm -f "$stdout_file" "$stderr_file"

  if [ "$should_contain" = "yes" ]; then
    if printf '%s' "$stdout" | grep -q "$expected"; then
      echo "  PASS  $name [$variant]"
      PASS=$((PASS + 1))
    else
      echo "  FAIL  $name [$variant]: stdout missing '$expected'"
      printf '%s\n' "$stdout" | sed 's/^/         /'
      FAIL=$((FAIL + 1))
      FAILED="$FAILED $name[$variant]"
    fi
  else
    # should_contain == "no": archive reminder MUST be absent.
    if printf '%s' "$stdout" | grep -q "openspec archive"; then
      echo "  FAIL  $name [$variant]: stdout unexpectedly contains 'openspec archive'"
      printf '%s\n' "$stdout" | sed 's/^/         /'
      FAIL=$((FAIL + 1))
      FAILED="$FAILED $name[$variant]"
    else
      echo "  PASS  $name [$variant]"
      PASS=$((PASS + 1))
    fi
  fi
}

echo "Sandbox: $SANDBOX"
echo ""

# ----- Branch 1: positive (slug + last task + CLI) -----
run_one "positive"      "positive"      "claude" "yes" "openspec archive my-feature"
run_one "positive"      "positive"      "codex"  "yes" "openspec archive my-feature"

# ----- Branch 2: not-last-task -----
run_one "not-last-task" "not-last-task" "claude" "no"  ""
run_one "not-last-task" "not-last-task" "codex"  "no"  ""

# ----- Branch 3: no-slug (free-form proposal) -----
run_one "no-slug"       "no-slug"       "claude" "no"  ""
run_one "no-slug"       "no-slug"       "codex"  "no"  ""

# ----- Branch 4: no-cli (folder present, CLI absent) -----
# Strip $SANDBOX/bin from PATH so `command -v openspec` fails. Folder is
# still there in $SANDBOX/project/openspec. Hook must short-circuit at
# step 4 (CLI gate) and emit no archive reminder.
run_one "no-cli"        "no-cli"        "claude" "no"  ""
run_one "no-cli"        "no-cli"        "codex"  "no"  ""

# ----- Branch 5: no-folder (CLI present, folder absent) -----
# CLAUDE_PROJECT_DIR points at $SANDBOX (no openspec/ dir there). Hook
# must short-circuit at step 4 (folder gate) before trying any MCP calls.
# We don't actually exercise any MCP fixture here — the hook should bail
# before reaching the wrappers. We pass "positive" only because the
# unhandled-fixture branch in the shim returns an empty body and the hook
# would then silent-skip on get_task. Either way the assertion ("no
# archive reminder") holds.
run_one "no-folder"     "no-folder"     "claude" "no"  ""
run_one "no-folder"     "no-folder"     "codex"  "no"  ""

# ----- Branch 6: mode-off (explicit opt-out via env) -----
# Both folder and CLI are present, but CHORUS_OPENSPEC_MODE=off. Hook
# must honor the opt-out and exit silently.
run_one "mode-off"      "mode-off"      "claude" "no"  ""
run_one "mode-off"      "mode-off"      "codex"  "no"  ""

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
exit 0
