# `.chorus/specs/` — lightweight local specs

This directory holds **spec-lite** specs: one git-tracked **folder per change** at
`.chorus/specs/<slug>/`, holding plain-markdown docs named by Chorus's own Document
types — `prd.md` (required), and optionally `tech_design.md`, `adr.md`, `spec.md`,
`guide.md`. These files are the **source of truth**; each is mirrored 1:1 to a Chorus
Document of the same `type` via the existing document tools.

The surrounding `.chorus/` directory is Chorus **plugin runtime state** (`artifacts/`,
`state.json`) and is gitignored. Only `.chorus/specs/` is version-controlled — the repo
`.gitignore` uses `.chorus/*` + `!.chorus/specs/` to ignore runtime state while tracking specs.

- **Start a new spec:** copy [`TEMPLATE/`](./TEMPLATE/) to `<slug>/` (at minimum `prd.md`).
- **Format, mode selection, and mirroring:** see the `spec-lite` skill
  (`public/chorus-plugin/skills/spec-lite/SKILL.md`) and [`docs/SPEC_LITE.md`](../../docs/SPEC_LITE.md).
- **Audit trail (留痕):** `git log --follow .chorus/specs/<slug>/` — no changelog file.
- **Living example:** [`spec-lite/prd.md`](./spec-lite/) — the spec-lite feature described in this format.
