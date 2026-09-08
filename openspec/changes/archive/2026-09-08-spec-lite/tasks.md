# Tasks — spec-lite

## 1. spec-lite skill
- [ ] 1.1 Author `public/chorus-plugin/skills/spec-lite/SKILL.md`: the `.chorus/specs/<slug>.md` single-file format, mode-selection contract, authoring steps, the submit-time one-way push-sync (reusing `chorus_pm_add_document_draft --arg-file`), and the develop-time Changelog/留痕 step.

## 2. Template, README, docs, and gitignore
- [ ] 2.1 Add `.chorus/specs/TEMPLATE.md` and `.chorus/specs/README.md`.
- [ ] 2.2 Add `docs/SPEC_LITE.md` reference (when to use lite vs OpenSpec, format, sync, 留痕, token rationale).
- [ ] 2.3 Narrow `.gitignore` (`.chorus/*` + `!.chorus/specs/`) so specs are git-tracked while plugin runtime state stays ignored; verify with `git check-ignore`.

## 3. Weave spec-lite into the stage skills
- [ ] 3.1 Add a functional "Spec mode" branch to the proposal, develop, and yolo skills routing to the mode-selection order (openspec-aware vs spec-lite); add a cross-reference in openspec-aware. No change to OpenSpec authoring steps or default precedence.
