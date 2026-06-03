# Tasks

## 1. Reviewer skills (no dependencies)

- [ ] 1.1 Add `public/skill/proposal-reviewer-chorus/SKILL.md` — read-only adversarial proposal reviewer ported from the Codex `chorus-proposal-reviewer` skill, `-chorus` naming, frontmatter `version: 0.9.3`.
- [ ] 1.2 Add `public/skill/task-reviewer-chorus/SKILL.md` — read-only adversarial task reviewer ported from the Codex `chorus-task-reviewer` skill, `-chorus` naming, frontmatter `version: 0.9.3`.

## 2. yolo skill (depends on 1)

- [ ] 2.1 Add `public/skill/yolo-chorus/SKILL.md` — full lifecycle doc with framework-neutral reviewer invocation referencing the two reviewer skills.

## 3. Unify references + manifest + routing (depends on 1, 2)

- [ ] 3.1 Add the canonical "Independent Review" section to `public/skill/chorus/SKILL.md`; update Skill Files table, both install scripts, Check-for-Updates note, and Skill Routing table; bump frontmatter version to 0.9.3.
- [ ] 3.2 Rewrite reviewer references in `develop-chorus/SKILL.md` and `review-chorus/SKILL.md` to the neutral pattern; bump their frontmatter versions to 0.9.3.
- [ ] 3.3 Update `public/skill/package.json` (files maps, triggers, version 0.9.3) and bump remaining `public/skill/*/SKILL.md` frontmatter versions to 0.9.3 (idea-chorus, proposal-chorus, brainstorm-chorus, quick-dev-chorus).
