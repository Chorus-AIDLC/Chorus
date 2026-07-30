#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)

reviewers="
public/chorus-plugin/agents/code-reviewer.md
plugins/chorus/skills/chorus-code-reviewer/SKILL.md
packages/openclaw-plugin/skills/code-reviewer/SKILL.md
packages/chorus-pi/agents/chorus-code-reviewer.md
public/skill/code-reviewer-chorus/SKILL.md
"

lifecycle="
public/chorus-plugin/skills/chorus/SKILL.md
public/chorus-plugin/skills/develop/SKILL.md
public/chorus-plugin/skills/review/SKILL.md
public/chorus-plugin/skills/yolo/SKILL.md
plugins/chorus/skills/chorus/SKILL.md
plugins/chorus/skills/develop/SKILL.md
plugins/chorus/skills/review/SKILL.md
plugins/chorus/skills/yolo/SKILL.md
packages/openclaw-plugin/skills/chorus/SKILL.md
packages/openclaw-plugin/skills/develop/SKILL.md
packages/openclaw-plugin/skills/review/SKILL.md
packages/openclaw-plugin/skills/yolo/SKILL.md
public/kiro-plugin/.kiro/skills/chorus-develop/SKILL.md
public/kiro-plugin/.kiro/skills/chorus-review/SKILL.md
public/kiro-plugin/.kiro/skills/chorus-yolo/SKILL.md
packages/chorus-pi/skills/chorus/SKILL.md
packages/chorus-pi/skills/develop/SKILL.md
packages/chorus-pi/skills/review/SKILL.md
packages/chorus-pi/skills/yolo/SKILL.md
public/skill/chorus/SKILL.md
public/skill/develop-chorus/SKILL.md
public/skill/review-chorus/SKILL.md
public/skill/yolo-chorus/SKILL.md
"

assert_terms() {
  file=$1
  shift
  for term in "$@"; do
    if ! grep -Fq "$term" "$ROOT/$file"; then
      printf 'FAIL: %s missing contract term: %s\n' "$file" "$term" >&2
      exit 1
    fi
  done
}

for file in $reviewers; do
  assert_terms "$file" \
    "orchestrator" "Quick Dev" "original approved proposal" \
    "related small BLOCKERs" "independent task review" \
    "admin verification" "failed or cancelled" "maximum review rounds"
done

for file in $lifecycle; do
  assert_terms "$file" \
    "quick-dev" "approved proposal" "related small BLOCKERs" \
    "independent task review" "admin verification" \
    "failed or cancelled"
done

for file in \
  public/chorus-plugin/skills/yolo/SKILL.md \
  plugins/chorus/skills/yolo/SKILL.md \
  packages/openclaw-plugin/skills/yolo/SKILL.md \
  public/kiro-plugin/.kiro/skills/chorus-yolo/SKILL.md \
  packages/chorus-pi/skills/yolo/SKILL.md \
  public/skill/yolo-chorus/SKILL.md; do
  assert_terms "$file" "maxCodeReviewRounds"
done

printf 'Code-review recovery contract parity: PASS\n'
