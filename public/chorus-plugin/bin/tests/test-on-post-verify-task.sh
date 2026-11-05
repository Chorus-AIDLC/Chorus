#!/usr/bin/env bash
# test-on-post-verify-task.sh — Fixture-based shell test for the
# on-post-verify-task.sh hooks (Claude Code + Codex variants, plus the
# Kiro variant for the code-review gateway fixtures — Kiro's hook is the
# Branch-C-only port and shares the Claude `chorus-api.sh mcp-tool` shim).
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
# Three independent reminder branches share the post-verify trigger:
#   - Branch A (OpenSpec archive trigger) — emits `openspec archive`
#   - Branch C (Code-review gateway)      — emits `spawn code-reviewer`
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
# Fixtures for Branch C with Quick Tasks linked to an Idea (Task.ideaUuid,
# design D6 of link-quick-task-to-idea). The shims route
# `chorus_list_tasks` calls whose args carry `"ideaUuid"` to the
# `chorus_list_tasks@idea` key; fixtures without an explicit @idea entry
# get an empty linked-task list (no linked Quick Tasks).
#   linked-positive      — verified task has NO proposalUuid but has ideaUuid;
#                          every linked Quick Task done/closed
#                          -> stdout MUST contain `spawn code-reviewer`, MUST
#                             NOT contain the report / archive reminders
#   linked-not-last      — a linked Quick Task still in_progress -> silent
#   linked-overflow      — linked list total > returned -> silent
#   linked-unlinked      — no proposalUuid AND no ideaUuid (plain Quick Task);
#                          @idea data would fire if the gate were broken -> silent
#   linked-toggle-off    — linked-positive data, code reviewer disabled -> silent
#   proposal-linked-open — proposal task, all proposal tasks done, but a Quick
#                          Task linked to the idea is still open -> silent
#   proposal-linked-done — proposal task, all proposal tasks done AND all
#                          linked Quick Tasks done -> `spawn code-reviewer`
#
# The fixtures above register no chorus_get_idea response, so they exercise
# the legacy (older-server) fallback. The mixed-* fixtures (CR-R3 B3)
# answer chorus_get_idea with/without derivedStatus and assert the gateway
# fires only when the server-derived idea status is "done".
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
CODEX_HOOK_RUNTIME="$REPO_ROOT/plugins/chorus/hooks/hook-runtime.sh"
KIRO_HOOK="$REPO_ROOT/public/kiro-plugin/bin/on-post-verify-task.sh"

[ -x "$CLAUDE_HOOK" ] || { echo "FAIL: $CLAUDE_HOOK is not executable" >&2; exit 1; }
[ -x "$CODEX_HOOK" ]  || { echo "FAIL: $CODEX_HOOK is not executable" >&2; exit 1; }
[ -x "$KIRO_HOOK" ]   || { echo "FAIL: $KIRO_HOOK is not executable" >&2; exit 1; }

PASS=0
FAIL=0
FAILED=""

# ----- Build sandbox -----

SANDBOX=$(mktemp -d)
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

# Sandbox layout:
#   $SANDBOX/claude/    — copy of Claude hook + shim chorus-api.sh
#   $SANDBOX/codex/     — copy of Codex hook + shim chorus-mcp-call.sh + real hook-output.sh + hook-runtime.sh
#   $SANDBOX/bin/       — fake openspec CLI on PATH
#   $SANDBOX/project/   — synthetic project root (contains openspec/ for fixtures
#                         that need the folder signal to be present)
mkdir -p "$SANDBOX/claude" "$SANDBOX/codex" "$SANDBOX/kiro" "$SANDBOX/bin" "$SANDBOX/project/openspec"

cp "$CLAUDE_HOOK" "$SANDBOX/claude/on-post-verify-task.sh"
cp "$CODEX_HOOK"  "$SANDBOX/codex/on-post-verify-task.sh"
cp "$CODEX_HOOK_OUTPUT" "$SANDBOX/codex/hook-output.sh"
cp "$CODEX_HOOK_RUNTIME" "$SANDBOX/codex/hook-runtime.sh"
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
    # chorus_list_tasks filtered by ideaUuid (linked Quick Tasks) gets its
    # own routing key so fixtures can answer it separately from the
    # proposal-scoped list.
    if [ "$tool" = "chorus_list_tasks" ]; then
      case "${2:-}" in *'"ideaUuid"'*) tool="chorus_list_tasks@idea" ;; esac
    fi
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
      # codereview-toggle-off uses the same canned data as codereview-positive;
      # the difference is the CLAUDE_PLUGIN_OPTION_ENABLECODEREVIEWER=false env
      # set by the runner, which must make Branch C silent on otherwise-firing data.
      codereview-toggle-off) fixture=codereview-positive ;;
      linked-toggle-off) fixture=linked-positive ;;
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
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":100}'
        ;;
      not-last-task:chorus_get_task)
        echo '{"uuid":"task-2","title":"Task 2","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      not-last-task:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-1","title":"P1","description":"Intro.\nOpenSpec change slug: my-feature\nMore.","inputType":"idea","inputUuids":["idea-1"]}'
        ;;
      not-last-task:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"in_progress"}],"total":3,"page":1,"pageSize":100}'
        ;;
      no-slug:chorus_get_task)
        echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-2","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      no-slug:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-2","title":"P2","description":"Free-form proposal description with no slug marker.","inputType":"idea","inputUuids":["idea-2"]}'
        ;;
      no-slug:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":100}'
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
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      report-positive:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
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
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      report-existing:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
        ;;

      # report-not-last: a task is still in_progress -> silent skip.
      report-not-last:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      report-not-last:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      report-not-last:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"in_progress","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      report-not-last:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
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
        echo '{"tasks":[{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
        ;;
      report-quick-task:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
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
        echo '{"tasks":[{"uuid":"t1","status":"done","proposalUuid":"prop-9"},{"uuid":"t2","status":"done","proposalUuid":"prop-9"},{"uuid":"t3","status":"done","proposalUuid":"prop-9"},{"uuid":"t4","status":"done","proposalUuid":"prop-9"},{"uuid":"t5","status":"done","proposalUuid":"prop-9"}],"total":25,"page":1,"pageSize":100}'
        ;;
      report-task-overflow:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
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
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      report-doc-overflow:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-other","type":"report","title":"Some other report","proposalUuid":"prop-OTHER"}],"total":25,"page":1,"pageSize":100}'
        ;;

      # ----- Branch C fixtures (code-review gateway reminder) -----
      # codereview-positive: idea-rooted proposal, all tasks done, a report
      # Document already exists (so Branch B is silent) -> ONLY Branch C
      # fires, isolating the `spawn code-reviewer` assertion.
      codereview-positive:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      codereview-positive:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no OpenSpec slug.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      codereview-positive:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      codereview-positive:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
        ;;

      # codereview-not-idea: proposal.inputType != "idea" -> Branch C must
      # skip at the idea-rooted gate.
      codereview-not-idea:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      codereview-not-idea:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Manual proposal.","inputType":"manual","inputUuids":[]}'
        ;;
      codereview-not-idea:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
        ;;
      codereview-not-idea:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
        ;;

      # codereview-not-last: a task is still in_progress -> Branch C silent.
      codereview-not-last:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      codereview-not-last:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      codereview-not-last:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"in_progress","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      codereview-not-last:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
        ;;

      # codereview-ordering: idea-rooted, all done, NO report Document ->
      # BOTH Branch C (spawn code-reviewer) and Branch B (create idea-
      # completion report) fire. Used to assert C precedes B in the output.
      codereview-ordering:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      codereview-ordering:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no slug.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      codereview-ordering:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
        ;;
      codereview-ordering:chorus_get_documents)
        echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
        ;;

      # ----- Branch C fixtures: Quick Tasks linked to an Idea (D6) -----
      linked-positive:chorus_get_task)
        echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":"idea-L","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      linked-positive:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-1","status":"closed"},{"uuid":"qt-2","status":"done"}],"total":2,"page":1,"pageSize":100}'
        ;;
      linked-not-last:chorus_get_task)
        echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":"idea-L","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      linked-not-last:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-1","status":"in_progress"},{"uuid":"qt-2","status":"done"}],"total":2,"page":1,"pageSize":100}'
        ;;
      linked-overflow:chorus_get_task)
        echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":"idea-L","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      linked-overflow:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-1","status":"done"},{"uuid":"qt-2","status":"done"}],"total":30,"page":1,"pageSize":100}'
        ;;
      linked-unlinked:chorus_get_task)
        echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":null,"project":{"uuid":"proj-1","name":"P"}}'
        ;;
      linked-unlinked:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-2","status":"done"}],"total":1,"page":1,"pageSize":100}'
        ;;
      proposal-linked-open:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      proposal-linked-open:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      proposal-linked-open:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":2,"page":1,"pageSize":100}'
        ;;
      proposal-linked-open:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-1","status":"open","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      proposal-linked-open:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
        ;;
      proposal-linked-done:chorus_get_task)
        echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      proposal-linked-done:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
        ;;
      proposal-linked-done:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":2,"page":1,"pageSize":100}'
        ;;
      proposal-linked-done:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-1","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      proposal-linked-done:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
        ;;

      # ----- Branch C: server-derived idea status (CR-R3 B3) -----
      # chorus_get_idea derivedStatus is authoritative; its absence (older
      # server) falls back to the client-side task-count check.
      mixed-qt-first:chorus_get_task)
        echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-qt-first:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-qt-first:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"in_progress","badgeHint":"x"}'
        ;;
      mixed-prop-first:chorus_get_task)
        echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-prop-first:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
        ;;
      mixed-prop-first:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-prop-first:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"in_progress","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-prop-first:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"in_progress","badgeHint":"x"}'
        ;;
      mixed-prop-first:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-done-qt:chorus_get_task)
        echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-done-qt:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-done-qt:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"done","badgeHint":"x"}'
        ;;
      mixed-done-prop:chorus_get_task)
        echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-done-prop:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
        ;;
      mixed-done-prop:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-done-prop:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-done-prop:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"done","badgeHint":"x"}'
        ;;
      mixed-done-prop:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-server-done:chorus_get_task)
        echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-server-done:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"in_progress","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-server-done:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"done","badgeHint":"x"}'
        ;;
      mixed-verify-pending:chorus_get_task)
        echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-verify-pending:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
        ;;
      mixed-verify-pending:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-verify-pending:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-verify-pending:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"human_conduct_required","badgeHint":"x"}'
        ;;
      mixed-verify-pending:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-qt:chorus_get_task)
        echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-legacy-qt:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-qt:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M"}'
        ;;
      mixed-legacy-prop-open:chorus_get_task)
        echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-legacy-prop-open:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
        ;;
      mixed-legacy-prop-open:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-prop-open:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"open","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-prop-open:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M"}'
        ;;
      mixed-legacy-prop-open:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-prop-done:chorus_get_task)
        echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
        ;;
      mixed-legacy-prop-done:chorus_get_proposal)
        printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
        ;;
      mixed-legacy-prop-done:chorus_list_tasks)
        echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-prop-done:chorus_list_tasks@idea)
        echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
        ;;
      mixed-legacy-prop-done:chorus_get_idea)
        echo '{"uuid":"idea-M","title":"Idea M"}'
        ;;
      mixed-legacy-prop-done:chorus_get_documents)
        echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
        ;;

      # Default for fixtures without explicit linked data: no Quick Tasks
      # are linked to the idea.
      *:chorus_list_tasks@idea)
        echo '{"tasks":[],"total":0,"page":1,"pageSize":100}'
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

# Kiro uses the same `chorus-api.sh mcp-tool` interface as Claude Code;
# its hook prints plain text (no hook-output envelope), so the shim copy
# is all it needs.
cp "$KIRO_HOOK" "$SANDBOX/kiro/on-post-verify-task.sh"
cp "$SANDBOX/claude/chorus-api.sh" "$SANDBOX/kiro/chorus-api.sh"
chmod +x "$SANDBOX/kiro/on-post-verify-task.sh" "$SANDBOX/kiro/chorus-api.sh"

# ----- Shim: chorus-mcp-call.sh (Codex shape) -----
# Codex wrapper interface:
#   chorus-mcp-call.sh <tool> <json_args>   -> echo canned JSON
cat > "$SANDBOX/codex/chorus-mcp-call.sh" <<'SHIM_CODEX'
#!/usr/bin/env bash
set -euo pipefail
tool="${1:-}"
# Route ideaUuid-filtered chorus_list_tasks separately (see claude shim).
if [ "$tool" = "chorus_list_tasks" ]; then
  case "${2:-}" in *'"ideaUuid"'*) tool="chorus_list_tasks@idea" ;; esac
fi
# Alias gate-test fixtures to "positive" canned data so a broken gate
# would let the hook proceed and emit an archive reminder, failing the
# "no archive reminder" assertion. See claude shim for full rationale.
fixture="${CHORUS_FIXTURE:-positive}"
case "$fixture" in
  mode-off|no-folder|no-cli) fixture=positive ;;
  codereview-toggle-off) fixture=codereview-positive ;;
  linked-toggle-off) fixture=linked-positive ;;
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
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":100}'
    ;;
  not-last-task:chorus_get_task)
    echo '{"uuid":"task-2","title":"Task 2","status":"done","proposalUuid":"prop-1","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  not-last-task:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-1","title":"P1","description":"Intro.\nOpenSpec change slug: my-feature\nMore.","inputType":"idea","inputUuids":["idea-1"]}'
    ;;
  not-last-task:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"in_progress"}],"total":3,"page":1,"pageSize":100}'
    ;;
  no-slug:chorus_get_task)
    echo '{"uuid":"task-3","title":"Task 3","status":"done","proposalUuid":"prop-2","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  no-slug:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-2","title":"P2","description":"Free-form proposal description with no slug marker.","inputType":"idea","inputUuids":["idea-2"]}'
    ;;
  no-slug:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-1","status":"done"},{"uuid":"task-2","status":"done"},{"uuid":"task-3","status":"done"}],"total":3,"page":1,"pageSize":100}'
    ;;

  # ----- Branch B fixtures (idea-completion report reminder) -----
  report-positive:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-positive:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no OpenSpec slug here.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-positive:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  report-positive:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  report-existing:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-existing:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-existing:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  report-existing:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
    ;;

  report-not-last:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-not-last:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-not-last:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"in_progress","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  report-not-last:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  report-quick-task:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-quick-task:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"manual","inputUuids":[]}'
    ;;
  report-quick-task:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
    ;;
  report-quick-task:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  # report-task-overflow: tasks total > returned -> silent skip.
  report-task-overflow:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-task-overflow:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-task-overflow:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"t1","status":"done","proposalUuid":"prop-9"},{"uuid":"t2","status":"done","proposalUuid":"prop-9"},{"uuid":"t3","status":"done","proposalUuid":"prop-9"},{"uuid":"t4","status":"done","proposalUuid":"prop-9"},{"uuid":"t5","status":"done","proposalUuid":"prop-9"}],"total":25,"page":1,"pageSize":100}'
    ;;
  report-task-overflow:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  # report-doc-overflow: docs total > returned -> silent skip.
  report-doc-overflow:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  report-doc-overflow:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  report-doc-overflow:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  report-doc-overflow:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-other","type":"report","title":"Some other report","proposalUuid":"prop-OTHER"}],"total":25,"page":1,"pageSize":100}'
    ;;

  # ----- Branch C fixtures (code-review gateway reminder) -----
  # codereview-positive: idea-rooted, all done, report Document already
  # exists (Branch B silent) -> ONLY Branch C fires.
  codereview-positive:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  codereview-positive:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no OpenSpec slug.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  codereview-positive:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  codereview-positive:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
    ;;

  # codereview-not-idea: inputType != "idea" -> Branch C silent.
  codereview-not-idea:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  codereview-not-idea:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Manual proposal.","inputType":"manual","inputUuids":[]}'
    ;;
  codereview-not-idea:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
    ;;
  codereview-not-idea:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  # codereview-not-last: a task still in_progress -> Branch C silent.
  codereview-not-last:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  codereview-not-last:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  codereview-not-last:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"in_progress","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  codereview-not-last:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  # codereview-ordering: idea-rooted, all done, NO report -> BOTH C and B
  # fire; used to assert C precedes B in the combined output.
  codereview-ordering:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  codereview-ordering:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal — no slug.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  codereview-ordering:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-7","status":"done","proposalUuid":"prop-9"},{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":3,"page":1,"pageSize":100}'
    ;;
  codereview-ordering:chorus_get_documents)
    echo '{"documents":[],"total":0,"page":1,"pageSize":100}'
    ;;

  # ----- Branch C fixtures: Quick Tasks linked to an Idea (D6) -----
  linked-positive:chorus_get_task)
    echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":"idea-L","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  linked-positive:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-1","status":"closed"},{"uuid":"qt-2","status":"done"}],"total":2,"page":1,"pageSize":100}'
    ;;
  linked-not-last:chorus_get_task)
    echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":"idea-L","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  linked-not-last:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-1","status":"in_progress"},{"uuid":"qt-2","status":"done"}],"total":2,"page":1,"pageSize":100}'
    ;;
  linked-overflow:chorus_get_task)
    echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":"idea-L","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  linked-overflow:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-1","status":"done"},{"uuid":"qt-2","status":"done"}],"total":30,"page":1,"pageSize":100}'
    ;;
  linked-unlinked:chorus_get_task)
    echo '{"uuid":"qt-2","title":"QT 2","status":"done","proposalUuid":null,"ideaUuid":null,"project":{"uuid":"proj-1","name":"P"}}'
    ;;
  linked-unlinked:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-2","status":"done"}],"total":1,"page":1,"pageSize":100}'
    ;;
  proposal-linked-open:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  proposal-linked-open:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  proposal-linked-open:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":2,"page":1,"pageSize":100}'
    ;;
  proposal-linked-open:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-1","status":"open","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  proposal-linked-open:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
    ;;
  proposal-linked-done:chorus_get_task)
    echo '{"uuid":"task-9","title":"Task 9","status":"done","proposalUuid":"prop-9","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  proposal-linked-done:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-9","title":"P9","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-9"]}'
    ;;
  proposal-linked-done:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-8","status":"closed","proposalUuid":"prop-9"},{"uuid":"task-9","status":"done","proposalUuid":"prop-9"}],"total":2,"page":1,"pageSize":100}'
    ;;
  proposal-linked-done:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-1","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  proposal-linked-done:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-r1","type":"report","title":"Idea 9 — completion report","proposalUuid":"prop-9"}],"total":1,"page":1,"pageSize":100}'
    ;;

  # ----- Branch C: server-derived idea status (CR-R3 B3) -----
  # chorus_get_idea derivedStatus is authoritative; its absence (older
  # server) falls back to the client-side task-count check.
  mixed-qt-first:chorus_get_task)
    echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-qt-first:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-qt-first:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"in_progress","badgeHint":"x"}'
    ;;
  mixed-prop-first:chorus_get_task)
    echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-prop-first:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
    ;;
  mixed-prop-first:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-prop-first:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"in_progress","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-prop-first:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"in_progress","badgeHint":"x"}'
    ;;
  mixed-prop-first:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-done-qt:chorus_get_task)
    echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-done-qt:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-done-qt:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"done","badgeHint":"x"}'
    ;;
  mixed-done-prop:chorus_get_task)
    echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-done-prop:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
    ;;
  mixed-done-prop:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-done-prop:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-done-prop:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"done","badgeHint":"x"}'
    ;;
  mixed-done-prop:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-server-done:chorus_get_task)
    echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-server-done:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"in_progress","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-server-done:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"done","badgeHint":"x"}'
    ;;
  mixed-verify-pending:chorus_get_task)
    echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-verify-pending:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
    ;;
  mixed-verify-pending:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-verify-pending:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-verify-pending:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M","derivedStatus":"human_conduct_required","badgeHint":"x"}'
    ;;
  mixed-verify-pending:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-qt:chorus_get_task)
    echo '{"uuid":"qt-M","title":"QT M","status":"done","proposalUuid":null,"ideaUuid":"idea-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-legacy-qt:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-qt:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M"}'
    ;;
  mixed-legacy-prop-open:chorus_get_task)
    echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-legacy-prop-open:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
    ;;
  mixed-legacy-prop-open:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-prop-open:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"open","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-prop-open:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M"}'
    ;;
  mixed-legacy-prop-open:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-prop-done:chorus_get_task)
    echo '{"uuid":"task-M","title":"Task M","status":"done","proposalUuid":"prop-M","project":{"uuid":"proj-1","name":"P"}}'
    ;;
  mixed-legacy-prop-done:chorus_get_proposal)
    printf '%s' '{"uuid":"prop-M","title":"PM","description":"Free-form proposal.","inputType":"idea","inputUuids":["idea-M"]}'
    ;;
  mixed-legacy-prop-done:chorus_list_tasks)
    echo '{"tasks":[{"uuid":"task-M","status":"done","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-prop-done:chorus_list_tasks@idea)
    echo '{"tasks":[{"uuid":"qt-M","status":"done","proposalUuid":null}],"total":1,"page":1,"pageSize":100}'
    ;;
  mixed-legacy-prop-done:chorus_get_idea)
    echo '{"uuid":"idea-M","title":"Idea M"}'
    ;;
  mixed-legacy-prop-done:chorus_get_documents)
    echo '{"documents":[{"uuid":"doc-rM","type":"report","title":"Idea M — completion report","proposalUuid":"prop-M"}],"total":1,"page":1,"pageSize":100}'
    ;;

  # Default for fixtures without explicit linked data: no Quick Tasks
  # are linked to the idea.
  *:chorus_list_tasks@idea)
    echo '{"tasks":[],"total":0,"page":1,"pageSize":100}'
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
# variant in {claude, codex, kiro}
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
  elif [ "$variant" = "kiro" ]; then
    hook_dir="$SANDBOX/kiro"
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

  # The "codereview-toggle-off" fixture disables Branch C via the plugin
  # option env var; everything else leaves it unset (defaults to enabled).
  local CODEREVIEW_OPT_FOR_RUN=""
  if [ "$fixture" = "codereview-toggle-off" ] || [ "$fixture" = "linked-toggle-off" ]; then
    CODEREVIEW_OPT_FOR_RUN="false"
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
        CLAUDE_PLUGIN_OPTION_ENABLECODEREVIEWER="$CODEREVIEW_OPT_FOR_RUN" \
        CHORUS_ENABLE_CODE_REVIEWER="${CODEREVIEW_OPT_FOR_RUN:-true}" \
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
  elif [ "$assertion_mode" = "must-precede" ]; then
    # $expected MUST appear, $forbidden MUST appear, and $expected's first
    # occurrence MUST come before $forbidden's. Used to assert Branch C
    # (code-review) is injected before Branch B (completion report). The
    # whole payload is a single JSON line, so compare byte offsets (grep
    # -bo), not line numbers.
    local off_expected off_forbidden
    off_expected=$(printf '%s' "$stdout" | grep -bo "$expected" | head -1 | cut -d: -f1)
    off_forbidden=$(printf '%s' "$stdout" | grep -bo "$forbidden" | head -1 | cut -d: -f1)
    if [ -z "$off_expected" ] || [ -z "$off_forbidden" ]; then
      echo "  FAIL  $name [$variant]: expected both '$expected' and '$forbidden' present (got offsets '$off_expected' / '$off_forbidden')"
      printf '%s\n' "$stdout" | sed 's/^/         /'
      FAIL=$((FAIL + 1))
      FAILED="$FAILED $name[$variant]"
    elif [ "$off_expected" -lt "$off_forbidden" ]; then
      echo "  PASS  $name [$variant]"
      PASS=$((PASS + 1))
    else
      echo "  FAIL  $name [$variant]: '$expected' (offset $off_expected) does not precede '$forbidden' (offset $off_forbidden)"
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

# ===== Branch C: Code-review gateway reminder fixtures =====
# (assertion: must-contain `spawn code-reviewer` / must-not-contain `spawn code-reviewer`)
# These fixtures use a non-OpenSpec proposal description (no slug line),
# so Branch A silent-skips, isolating Branch C behavior.

# C1: codereview-positive — last task of an idea-rooted proposal verified,
# code-reviewer enabled (default). A report Document already exists so
# Branch B is silent; ONLY Branch C fires -> reminder MUST contain
# `spawn code-reviewer`.
run_one "codereview-positive"   "codereview-positive"   "claude" "must-contain" "spawn code-reviewer"
run_one "codereview-positive"   "codereview-positive"   "codex"  "must-contain" "spawn code-reviewer"

# C2: codereview-toggle-off — same data as positive but
# CLAUDE_PLUGIN_OPTION_ENABLECODEREVIEWER=false -> Branch C MUST be silent.
run_one "codereview-toggle-off" "codereview-toggle-off" "claude" "must-not-contain" "" "spawn code-reviewer"
run_one "codereview-toggle-off" "codereview-toggle-off" "codex"  "must-not-contain" "" "spawn code-reviewer"

# C3: codereview-not-idea — proposal.inputType != "idea" -> Branch C
# MUST skip at the idea-rooted gate.
run_one "codereview-not-idea"   "codereview-not-idea"   "claude" "must-not-contain" "" "spawn code-reviewer"
run_one "codereview-not-idea"   "codereview-not-idea"   "codex"  "must-not-contain" "" "spawn code-reviewer"

# C4: codereview-not-last — a task still in_progress -> Branch C silent.
run_one "codereview-not-last"   "codereview-not-last"   "claude" "must-not-contain" "" "spawn code-reviewer"
run_one "codereview-not-last"   "codereview-not-last"   "codex"  "must-not-contain" "" "spawn code-reviewer"

# C5: codereview-ordering — idea-rooted, all done, NO report Document, so
# BOTH Branch C and Branch B fire. The code-review reminder MUST precede
# the completion-report reminder in the combined output.
run_one "codereview-ordering"   "codereview-ordering"   "claude" "must-precede" "spawn code-reviewer" "create idea-completion report"
run_one "codereview-ordering"   "codereview-ordering"   "codex"  "must-precede" "spawn code-reviewer" "create idea-completion report"

# ===== Kiro: Branch C (its only branch) on the existing gateway fixtures =====
run_one "codereview-positive"   "codereview-positive"   "kiro" "must-contain" "spawn the read-only"
run_one "codereview-toggle-off" "codereview-toggle-off" "kiro" "must-not-contain" "" "Code-Review Gateway"
run_one "codereview-not-idea"   "codereview-not-idea"   "kiro" "must-not-contain" "" "Code-Review Gateway"
run_one "codereview-not-last"   "codereview-not-last"   "kiro" "must-not-contain" "" "Code-Review Gateway"

# ===== Branch C: Quick Tasks linked to an Idea (D6) =====
# L1: last linked Quick Task of a proposal-less idea -> gateway fires for
# the task's ideaUuid; Branch A/B stay silent (proposal-only).
for v in claude codex; do
  run_one "linked-positive"         "linked-positive" "$v" "must-contain" "spawn code-reviewer"
  run_one "linked-positive-idea"    "linked-positive" "$v" "must-contain" "gateway for idea idea-L"
  run_one "linked-positive-fixqt"   "linked-positive" "$v" "must-contain" "ideaUuid=.*idea-L"
  run_one "linked-positive-no-report"  "linked-positive" "$v" "must-not-contain" "" "create idea-completion report"
  run_one "linked-positive-no-archive" "linked-positive" "$v" "must-not-contain" "" "openspec archive"
done
run_one "linked-positive"       "linked-positive" "kiro" "must-contain" "gateway for idea idea-L"
run_one "linked-positive-fixqt" "linked-positive" "kiro" "must-contain" "ideaUuid=.*idea-L"

# L2-L5: silent cases.
for v in claude codex kiro; do
  run_one "linked-not-last"      "linked-not-last"      "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "linked-overflow"      "linked-overflow"      "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "linked-unlinked"      "linked-unlinked"      "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "linked-toggle-off"    "linked-toggle-off"    "$v" "must-not-contain" "" "ode-Review Gateway"
  # P1: proposal idea with an open linked Quick Task -> gateway waits.
  run_one "proposal-linked-open" "proposal-linked-open" "$v" "must-not-contain" "" "ode-Review Gateway"
done

# P2: proposal idea whose linked Quick Tasks are all done -> gateway fires.
run_one "proposal-linked-done" "proposal-linked-done" "claude" "must-contain" "spawn code-reviewer"
run_one "proposal-linked-done" "proposal-linked-done" "codex"  "must-contain" "spawn code-reviewer"
run_one "proposal-linked-done" "proposal-linked-done" "kiro"   "must-contain" "gateway for idea idea-9"

# ===== Branch C: server-derived idea status gates the gateway (CR-R3 B3) =====
# M1: linked Quick Task verified first while the idea's approved-proposal
#     task is still in_progress — the linked list alone is all-done (legacy
#     logic would fire), but derivedStatus=in_progress -> silent.
# M2: reverse order — proposal tasks done, linked Quick Task in_progress -> silent.
# M3/M4: both sides done (derivedStatus=done) -> fires from either path.
# M5: server says done though the client-visible linked list is stale -> fires
#     (server is the single source of truth, no client-side counting).
# M6: derivedStatus=human_conduct_required (verify pending elsewhere) -> silent.
# L*: derivedStatus absent (older server) -> legacy task-count behaviour.
for v in claude codex kiro; do
  run_one "mixed-qt-first"         "mixed-qt-first"         "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "mixed-prop-first"       "mixed-prop-first"       "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "mixed-done-qt"          "mixed-done-qt"          "$v" "must-contain" "gateway for idea idea-M"
  run_one "mixed-done-prop"        "mixed-done-prop"        "$v" "must-contain" "gateway for idea idea-M"
  run_one "mixed-server-done"      "mixed-server-done"      "$v" "must-contain" "gateway for idea idea-M"
  run_one "mixed-verify-pending"   "mixed-verify-pending"   "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "mixed-legacy-qt"        "mixed-legacy-qt"        "$v" "must-contain" "gateway for idea idea-M"
  run_one "mixed-legacy-prop-open" "mixed-legacy-prop-open" "$v" "must-not-contain" "" "ode-Review Gateway"
  run_one "mixed-legacy-prop-done" "mixed-legacy-prop-done" "$v" "must-contain" "gateway for idea idea-M"
done
run_one "mixed-done-qt-wording"  "mixed-done-qt" "claude" "must-contain" "any approved-proposal tasks"
run_one "mixed-done-qt-no-report" "mixed-done-qt" "claude" "must-not-contain" "" "create idea-completion report"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED"
  exit 1
fi
exit 0
