# `.chorus/specs/` — lightweight local specs

This directory holds **spec-lite** specs. Each `<slug>/` is a **capability/feature** (not a single
change) and contains two kinds of thing:

- **`<slug>/spec.md` — the durable local spec.** One cumulative, human-readable, git-tracked file,
  **edited in place** as the capability evolves. It is the local "current truth", **never synced to
  Chorus and carries no Chorus ids** — its git history is the record. It never enters the mirror loop.
- **One dated folder per change effort — `<slug>/<YYYY-MM-DD>-<change-slug>/`** (directly under
  `<slug>/`, **no `changes/` wrapper**). It holds the Chorus-typed docs for that change — `prd.md`
  (primary), optionally `tech_design.md` / `adr.md` / `guide.md` / `spec.md`. These **are** mirrored
  1:1 into **persistent** Chorus Documents of the matching type (later edits bump the Document version
  = its history); their frontmatter carries `proposalUuid` / `documentUuid`. Old dated folders are
  never rewritten — a new effort gets a new dated folder.

The surrounding `.chorus/` directory is Chorus **plugin runtime state** (`artifacts/`, `state.json`)
and is gitignored. Only `.chorus/specs/` is version-controlled — the repo `.gitignore` uses
`.chorus/*` + `!.chorus/specs/` to ignore runtime state while tracking specs.

- **Start a new capability spec:** copy [`TEMPLATE/spec.md`](./TEMPLATE/) to `<slug>/spec.md`.
- **Record a change:** copy [`TEMPLATE/YYYY-MM-DD-change/`](./TEMPLATE/) to
  `<slug>/<today>-<change-slug>/` (rename the folder), write its `prd.md` (+ `tech_design.md` if
  warranted), then update `<slug>/spec.md` in place.
- **Naming caution:** the durable file is `<slug>/spec.md` (local only, no ids); a per-change
  `spec`-type doc would live at `<slug>/<date>-<slug>/spec.md` (synced, carries ids). Prefer `prd.md`
  as the per-change primary doc.
- **Format, mode selection, and mirroring:** see the `spec-lite` skill
  (`public/chorus-plugin/skills/spec-lite/SKILL.md`) and [`docs/SPEC_LITE.md`](../../docs/SPEC_LITE.md).
- **Audit trail (留痕):** `git log -- .chorus/specs/<slug>/` for the whole capability (the durable
  `spec.md`'s in-place diffs + each dated folder's change docs); the mirrored Documents' versions are
  the parallel record in Chorus. No changelog file. Only dated-folder docs mirror; `spec.md` never does.
- **Living example:** [`spec-lite/`](./spec-lite/) — the spec-lite capability in this format, with its
  first change under [`spec-lite/2026-09-08-chorus-native-lite/`](./spec-lite/2026-09-08-chorus-native-lite/).
