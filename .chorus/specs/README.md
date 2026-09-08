# `.chorus/specs/` — lightweight local specs

This directory holds **spec-lite** specs: one git-tracked `<slug>.md` per change, each carrying the change's intent, requirements + acceptance criteria, tasks, and an append-only timestamped changelog (the local audit trail / 留痕). These files are the **source of truth**; Chorus mirrors them one-way as `spec` documents.

Note the surrounding `.chorus/` directory is Chorus **plugin runtime state** (`artifacts/`, `state.json`) and is gitignored. Only `.chorus/specs/` is version-controlled — the repo `.gitignore` uses `.chorus/*` + `!.chorus/specs/` to ignore runtime state while tracking specs.

- **Start a new spec:** copy [`TEMPLATE.md`](./TEMPLATE.md) to `<slug>.md`.
- **Format, mode-selection, and sync:** see the `spec-lite` skill (`public/chorus-plugin/skills/spec-lite/SKILL.md`) and [`docs/SPEC_LITE.md`](../../docs/SPEC_LITE.md).
