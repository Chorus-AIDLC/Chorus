# `.chorus/specs/` — lightweight local specs

This directory holds **spec-lite** specs. Each `<slug>/` is a **durable spec for a capability/feature**
(not a single change): a git-tracked folder of plain-markdown docs named by Chorus's own Document types
— `prd.md` (required), and optionally `tech_design.md`, `adr.md`, `spec.md`, `guide.md`. These docs are
the **source of truth**, **edited in place** as the capability evolves; each is mirrored 1:1 to a
**persistent** Chorus Document of the same `type` (later edits bump the Document version = its history).

Each modification effort is recorded as a **dated change file** under
`.chorus/specs/<slug>/changes/YYYY-MM-DD-<change-slug>.md` — one lean file per effort (What / Why /
Acceptance), referencing the durable spec (`../prd.md`). The date prefix lets many changes to one spec
coexist; old change files are never rewritten (git history is 留痕).

The surrounding `.chorus/` directory is Chorus **plugin runtime state** (`artifacts/`, `state.json`)
and is gitignored. Only `.chorus/specs/` is version-controlled — the repo `.gitignore` uses
`.chorus/*` + `!.chorus/specs/` to ignore runtime state while tracking specs.

- **Start a new capability spec:** copy [`TEMPLATE/prd.md`](./TEMPLATE/) to `<slug>/prd.md`.
- **Record a change:** copy [`TEMPLATE/changes/YYYY-MM-DD-change.md`](./TEMPLATE/changes/) to
  `<slug>/changes/<today>-<change-slug>.md`, then edit the durable docs in place.
- **Format, mode selection, and mirroring:** see the `spec-lite` skill
  (`public/chorus-plugin/skills/spec-lite/SKILL.md`) and [`docs/SPEC_LITE.md`](../../docs/SPEC_LITE.md).
- **Audit trail (留痕):** `git log -- .chorus/specs/<slug>/` for the whole capability (dated change
  files + durable-doc diffs; `git log --follow -- <file>` to track a single renamed file) — no
  changelog file; the mirrored Documents' versions are the parallel record in Chorus.
- **Living example:** [`spec-lite/`](./spec-lite/) — the spec-lite capability described in this format,
  with its first change under [`spec-lite/changes/`](./spec-lite/changes/).
