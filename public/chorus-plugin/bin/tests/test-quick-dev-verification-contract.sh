#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)

skills="
public/chorus-plugin/skills/quick-dev/SKILL.md
plugins/chorus/skills/quick-dev/SKILL.md
packages/openclaw-plugin/skills/quick-dev/SKILL.md
public/kiro-plugin/.kiro/skills/chorus-quick-dev/SKILL.md
packages/chorus-pi/skills/quick-dev/SKILL.md
public/skill/quick-dev-chorus/SKILL.md
"

assert_term() {
  file=$1
  term=$2
  if ! grep -Fq "$term" "$ROOT/$file"; then
    printf 'FAIL: %s missing contract term: %s\n' "$file" "$term" >&2
    exit 1
  fi
}

for file in $skills; do
  for term in \
    'chorus_checkin().agent.permissions.task' \
    'explicit `task:admin`' \
    'name, persona, preset/role label, task ownership' \
    'chorus_report_criteria_self_check' \
    'independent task review' \
    'unresolved BLOCKER' \
    'chorus_admin_verify_task' \
    'continue autonomously' \
    'evidence-rich comment' \
    '@mention the responsible human' \
    'headless daemon sessions' \
    'poll for the human response'; do
    assert_term "$file" "$term"
  done
done

if grep -Riq 'check admin role' $skills; then
  printf 'FAIL: Quick Dev still authorizes by role wording\n' >&2
  exit 1
fi

printf 'Quick Dev permission-aware verification parity: PASS\n'
