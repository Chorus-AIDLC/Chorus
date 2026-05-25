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
# Two independent reminder branches share the post-verify trigger:
#   - Branch A (OpenSpec archive trigger) — emits `openspec archive`
#   - Branch B (Idea-completion report)   — emits `create idea-completion report`
#
# Fixtures for Branch A (legacy):
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
# Fixtures for Branch B (idea-completion report — see spec
# idea-completion-report scenarios "Hook injects a reminder ..."):
#   report-positive    — idea-rooted proposal, all its tasks are
#                        done|closed, no report Document on this proposal
#                        -> stdout MUST contain `create idea-completion report`
#   report-existing    — same as report-positive but a `type=report`
#                        Document already exists on this proposal
#                        -> stdout MUST NOT contain `create idea-completion report`
#   report-not-last    — idea-rooted, but one task is still in_progress
#                        -> stdout MUST NOT contain `create idea-completion report`
#   report-quick-task  — proposal's inputType is not "idea" (e.g. a
#                        non-idea-rooted proposal); branch B must skip
#                        regardless of task status
#                        -> stdout MUST NOT contain `create idea-completion report`
#   report-task-overflow — chorus_list_tasks returns total > tasks.length
#                          (page-1 of a wider task set, all returned tasks
#                          are done but more remain). Hook MUST refuse to
#                          conclude "all done" — silent skip.
#                          -> stdout MUST NOT contain `create idea-completion report`
#   report-doc-overflow  — chorus_get_documents returns total > documents.length
#                          (existing report sits on a later page). Hook MUST
#                          refuse to conclude "no report" — silent skip.
#                          -> stdout MUST NOT contain `create idea-completion report`
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
      # ----- Branch A fixtures (existing) -----
      # NOTE: Branch B's idea-rooted check requires `inputType:"idea"`. We
      # set it on the OpenSpec fixtures too because real proposals always
      # carry inputType. To keep Branch A fixtures independent of Branch B,
      # we deliberately DO NOT register chorus_get_proposals /
      # chorus_get_documents responses for them — Branch B hits the default
      # "unhandled" case (empty body) and silent-skips.
      positive:chorus_get_task)
        echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      positive:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-1","title":"P1","description":"Some intro line.\nOpenSpec change slug: my-feature\nMore body.","inputType":"idea","inputUuids":["idea-1"]}'
        ;;
      positive:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
        ;;
      not-last-task:chorus_get_task)
        echo '{"uuid":"task-2","title":"Task 2","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      not-last-task:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-1","title":"P1","description":"Intro.\nOpenSpec change slug: my-feature\nMore.","inputType":"idea","inputUuids":["idea-1"]}'
        ;;
      not-last-task:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"in_progress"}],"total":3,"page":1,"pageSize":200}'
        ;;
      no-slug:chorus_get_task)
        echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-2","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      no-slug:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-2","title":"P2","description":"Free-form proposal description with no slug marker.","inputType":"idea","inputUuids":["idea-2"]}'
        ;;
      no-slug:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
        ;;

      # ----- Branch B fixtures (idea-completion report reminder) -----
      # report-positive: idea-rooted proposal whose tasks are all
      # done|closed, no report Document on it -> emit.
      report-positive:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-positive:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no OpenSpec slug here.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      report-positive:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
        ;;
      report-positive:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
        ;;

      # report-existing: same as positive but a report Document already
      # exists on this proposal -> silent skip.
      report-existing:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-existing:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      report-existing:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
        ;;
      report-existing:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":200}'
        ;;

      # report-not-last: a task is still in_progress -> silent skip.
      report-not-last:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-not-last:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      report-not-last:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"in_progress","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
        ;;
      report-not-last:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
        ;;

      # report-quick-task: proposal.inputType != "idea" -> Branch B must
      # skip at the first gate, before any further calls.
      report-quick-task:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-quick-task:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"manual","inputUuids":[]}'
        ;;
      report-quick-task:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":200}'
        ;;
      report-quick-task:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
        ;;

      # report-task-overflow: chorus_list_tasks returns 5 done tasks but
      # total=25 — more tasks exist on later pages. Hook MUST refuse to
      # conclude "all done" and silent-skip Branch B.
      report-task-overflow:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-task-overflow:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      report-task-overflow:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"t1","status":"done","proposalUuid":"prop-9"},{"uuid":"t2","status":"done","proposalUuid":"prop-9"},{"uuid":"t3","status":"done","proposalUuid":"prop-9"},{"uuid":"t4","status":"done","proposalUuid":"prop-9"},{"uuid":"t5","status":"done","proposalUuid":"prop-9"}],"total":25,"page":1,"pageSize":200}'
        ;;
      report-task-overflow:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
        ;;

      # report-doc-overflow: chorus_get_documents returns 1 unrelated
      # report but total=25 — this proposal's existing report sits on a
      # later page. Hook MUST refuse to conclude "no report" and silent-skip.
      report-doc-overflow:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-doc-overflow:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      report-doc-overflow:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
        ;;
      report-doc-overflow:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-other","type":"report","title":"Some other report","proposalUuid":"prop-OTHER"}],"total":25,"page":1,"pageSize":200}'
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
  # ----- Branch A fixtures (existing) -----
  positive:chorus_get_task)
    echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  positive:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-1","title":"P1","description":"Some intro line.\nOpenSpec change slug: my-feature\nMore body.","inputType":"idea","inputUuids":["idea-1"]}'
    ;;
  positive:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
    ;;
  not-last-task:chorus_get_task)
    echo '{"uuid":"task-2","title":"Task 2","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  not-last-task:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-1","title":"P1","description":"Intro.\nOpenSpec change slug: my-feature\nMore.","inputType":"idea","inputUuids":["idea-1"]}'
    ;;
  not-last-task:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"in_progress"}],"total":3,"page":1,"pageSize":200}'
    ;;
  no-slug:chorus_get_task)
    echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-2","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  no-slug:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-2","title":"P2","description":"Free-form proposal description with no slug marker.","inputType":"idea","inputUuids":["idea-2"]}'
    ;;
  no-slug:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":200}'
    ;;

  # ----- Branch B fixtures (idea-completion report reminder) -----
  report-positive:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-positive:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no OpenSpec slug here.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-positive:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
    ;;
  report-positive:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
    ;;

  report-existing:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-existing:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-existing:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
    ;;
  report-existing:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":200}'
    ;;

  report-not-last:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-not-last:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-not-last:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"in_progress","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
    ;;
  report-not-last:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
    ;;

  report-quick-task:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-quick-task:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"manual","inputUuids":[]}'
    ;;
  report-quick-task:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":200}'
    ;;
  report-quick-task:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
    ;;

  # report-task-overflow: tasks total > returned -> silent skip.
  report-task-overflow:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-task-overflow:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-task-overflow:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"t1","status":"done","proposalUuid":"prop-9"},{"uuid":"t2","status":"done","proposalUuid":"prop-9"},{"uuid":"t3","status":"done","proposalUuid":"prop-9"},{"uuid":"t4","status":"done","proposalUuid":"prop-9"},{"uuid":"t5","status":"done","proposalUuid":"prop-9"}],"total":25,"page":1,"pageSize":200}'
    ;;
  report-task-overflow:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":200}'
    ;;

  # report-doc-overflow: docs total > returned -> silent skip.
  report-doc-overflow:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-doc-overflow:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-doc-overflow:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":200}'
    ;;
  report-doc-overflow:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-other","type":"report","title":"Some other report","proposalUuid":"prop-OTHER"}],"total":25,"page":1,"pageSize":200}'
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

# Args: name fixture variant assertion_mode expected_substring forbidden_substring
# variant in {claude, codex}
# assertion_mode:
#   "must-contain"  -> stdout MUST contain $expected_substring
#   "must-not-contain" -> stdout MUST NOT contain $forbidden_substring
# (For Branch B fixtures, $forbidden_substring is `create idea-completion report`.
#  For Branch A "no" fixtures, $forbidden_substring is `openspec archive`.)
run_one() {
  local name="$1"
  local fixture="$2"
  local variant="$3"
  local assertion_mode="$4"
  local expected="$5"
  local forbidden="${6:-openspec archive}"

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

  if [ "$assertion_mode" = "must-contain" ]; then
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
    # must-not-contain: $forbidden MUST be absent.
    if printf '%s' "$stdout" | grep -q "$forbidden"; then
      echo "  FAIL  $name [$variant]: stdout unexpectedly contains '$forbidden'"
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

# ===== Branch A: OpenSpec archive trigger fixtures =====
# (assertion: must-contain `openspec archive my-feature` / must-not-contain `openspec archive`)

# A1: positive (slug + last task + CLI)
run_one "positive"      "positive"      "claude" "must-contain" "openspec archive my-feature"
run_one "positive"      "positive"      "codex"  "must-contain" "openspec archive my-feature"

# A2: not-last-task
run_one "not-last-task" "not-last-task" "claude" "must-not-contain" "" "openspec archive"
run_one "not-last-task" "not-last-task" "codex"  "must-not-contain" "" "openspec archive"

# A3: no-slug (free-form proposal)
run_one "no-slug"       "no-slug"       "claude" "must-not-contain" "" "openspec archive"
run_one "no-slug"       "no-slug"       "codex"  "must-not-contain" "" "openspec archive"

# A4: no-cli (folder present, CLI absent). Strip $SANDBOX/bin from PATH
# so `command -v openspec` fails. Folder is still there in
# $SANDBOX/project/openspec. Hook must short-circuit at the CLI gate.
run_one "no-cli"        "no-cli"        "claude" "must-not-contain" "" "openspec archive"
run_one "no-cli"        "no-cli"        "codex"  "must-not-contain" "" "openspec archive"

# A5: no-folder (CLI present, folder absent). CLAUDE_PROJECT_DIR points
# at $SANDBOX (no openspec/ dir there). Hook must short-circuit at the
# folder gate before reaching any MCP call.
run_one "no-folder"     "no-folder"     "claude" "must-not-contain" "" "openspec archive"
run_one "no-folder"     "no-folder"     "codex"  "must-not-contain" "" "openspec archive"

# A6: mode-off (explicit opt-out via env). Both folder and CLI are
# present, but CHORUS_OPENSPEC_MODE=off. Hook must honor the opt-out.
run_one "mode-off"      "mode-off"      "claude" "must-not-contain" "" "openspec archive"
run_one "mode-off"      "mode-off"      "codex"  "must-not-contain" "" "openspec archive"

# ===== Branch B: Idea-completion report reminder fixtures =====
# (assertion: must-contain `create idea-completion report` /
#  must-not-contain `create idea-completion report`)
# These fixtures all use a non-OpenSpec proposal description (no slug
# line), so Branch A silent-skips. The PATH still has the fake openspec
# CLI and the synthetic project dir still has openspec/ so Branch A's
# folder/CLI gates pass — the slug gate is what blocks Branch A here,
# isolating the assertion to Branch B's behavior.

# B1: report-positive — last task of an Idea verified, no report
# Document yet -> reminder MUST fire.
run_one "report-positive"   "report-positive"   "claude" "must-contain" "create idea-completion report"
run_one "report-positive"   "report-positive"   "codex"  "must-contain" "create idea-completion report"

# B2: report-existing — same conditions but a report Document already
# exists for the Idea -> reminder MUST be silent.
run_one "report-existing"   "report-existing"   "claude" "must-not-contain" "" "create idea-completion report"
run_one "report-existing"   "report-existing"   "codex"  "must-not-contain" "" "create idea-completion report"

# B3: report-not-last — at least one task is still in_progress
# (non-terminal) -> reminder MUST be silent.
run_one "report-not-last"   "report-not-last"   "claude" "must-not-contain" "" "create idea-completion report"
run_one "report-not-last"   "report-not-last"   "codex"  "must-not-contain" "" "create idea-completion report"

# B4: report-quick-task — proposal.inputType != "idea" (e.g. a
# manually-created proposal) -> reminder MUST be silent at first gate.
run_one "report-quick-task" "report-quick-task" "claude" "must-not-contain" "" "create idea-completion report"
run_one "report-quick-task" "report-quick-task" "codex"  "must-not-contain" "" "create idea-completion report"

# B5: report-task-overflow — chorus_list_tasks total > returned (more
# tasks remain on later pages). Hook must refuse to assume "all done"
# and silent-skip Branch B.
run_one "report-task-overflow" "report-task-overflow" "claude" "must-not-contain" "" "create idea-completion report"
run_one "report-task-overflow" "report-task-overflow" "codex"  "must-not-contain" "" "create idea-completion report"

# B6: report-doc-overflow — chorus_get_documents total > returned (the
# proposal's existing report could be on a later page). Hook must refuse
# to assume "no report" and silent-skip Branch B.
run_one "report-doc-overflow" "report-doc-overflow" "claude" "must-not-contain" "" "create idea-completion report"
run_one "report-doc-overflow" "report-doc-overflow" "codex"  "must-not-contain" "" "create idea-completion report"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
exit 0
