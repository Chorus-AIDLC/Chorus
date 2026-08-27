#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [codex-plugin-root]" >&2
  exit 2
fi

if [ "$#" -eq 1 ]; then
  ROOT=$(cd "$1" && pwd)
else
  ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fi

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  file=$1
  shift
  for term in "$@"; do
    grep -Fq "$term" "$ROOT/$file" ||
      fail "$file missing contract term: $term"
  done
}

# The current Codex spawn schema has no legacy role-selection parameter.
# Split the pattern so this test does not flag its own source.
if grep -RInE 'agent[_]type' "$ROOT" \
  --include='*.md' --include='*.sh' --include='*.json'; then
  fail "obsolete spawn role parameter found"
fi

fixed_roles_a='only (ships|has) (three|four) built[-]in'
fixed_roles_b='default/explorer/'"worker"
fixed_roles_c='built[-]in (sub-)?agent role'
if grep -RInE "$fixed_roles_a|$fixed_roles_b|$fixed_roles_c" "$ROOT" \
  --include='*.md' --include='*.sh' --include='*.json'; then
  fail "obsolete fixed-role guidance found"
fi

assert_file_contains "skills/chorus-proposal-reviewer/SKILL.md" \
  'spawn_agent({items:' 'chorus:chorus-proposal-reviewer' '<proposal-uuid>' 'VERDICT'
assert_file_contains "skills/chorus-task-reviewer/SKILL.md" \
  'spawn_agent({items:' 'chorus:chorus-task-reviewer' '<task-uuid>' 'VERDICT'
assert_file_contains "skills/chorus-code-reviewer/SKILL.md" \
  'spawn_agent({items:' 'chorus:chorus-code-reviewer' '<idea-uuid>' 'VERDICT'

assert_file_contains "skills/develop/SKILL.md" \
  'path: "chorus:develop"' 'Task UUIDs:' 'Project UUID:' \
  'fork_context: true' 'fresh context' \
  'wait_agent' 'send_input' 'close_agent' 'resume_agent' \
  'Codex owns execution-thread orchestration' 'Chorus MCP remains authoritative'

assert_file_contains "skills/yolo/SKILL.md" \
  'path: "chorus:develop"' 'Task UUID:' 'Project UUID:' \
  'fork_context: true' 'wait_agent' 'send_input' 'close_agent' 'resume_agent' \
  'Review the aggregate code for idea <idea-uuid>. Round: N. Post VERDICT on the idea.'

yolo_close_count=$(grep -Fc 'close_agent({ target: reviewer.agent_id })' \
  "$ROOT/skills/yolo/SKILL.md")
[ "$yolo_close_count" -ge 3 ] ||
  fail "skills/yolo/SKILL.md does not close every stored reviewer.agent_id"

assert_file_contains "hooks/on-post-submit-proposal.sh" \
  'chorus:chorus-proposal-reviewer' 'Review proposal ${PROPOSAL_UUID:-<uuid>}' \
  'fork_context: true' 'send_input' 'resume_agent'
assert_file_contains "hooks/on-post-submit-for-verify.sh" \
  'chorus:chorus-task-reviewer' 'Review Chorus task ${TASK_UUID:-<uuid>}' \
  'fork_context: true' 'send_input' 'resume_agent'
assert_file_contains "hooks/on-post-verify-task.sh" \
  'chorus:chorus-code-reviewer' 'idea ${idea_uuid}' 'Post VERDICT'

if command -v jq >/dev/null 2>&1; then
  VERSION=$(jq -r '.version' "$ROOT/.codex-plugin/plugin.json")
else
  VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$ROOT/.codex-plugin/plugin.json" | head -n 1)
fi
[ -n "$VERSION" ] || fail "cannot read plugin version"

for skill in "$ROOT"/skills/*/SKILL.md; do
  grep -Fq "  version: \"$VERSION\"" "$skill" ||
    fail "${skill#"$ROOT/"} version does not match $VERSION"
done

grep -Fq "\"version\":\"$VERSION\"" "$ROOT/hooks/chorus-mcp-call.sh" ||
  fail "hooks/chorus-mcp-call.sh clientInfo.version does not match $VERSION"

printf 'Codex subagent contract: PASS (%s)\n' "$ROOT"
