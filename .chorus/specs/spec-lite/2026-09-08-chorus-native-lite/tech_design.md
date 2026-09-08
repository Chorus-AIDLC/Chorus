---
title: "Tech Design: spec-lite storage + mirror mechanics"
spec: ../spec.md
proposalUuid:
documentUuid:
---

# spec-lite — technical design (durable spec + dated change folders)

<!-- Per-change tech design. Synced 1:1 into a persistent Chorus Document of type `tech_design`.
     Durable cumulative spec: ../spec.md (local only, never synced). -->

## Layout
`.chorus/specs/<slug>/spec.md` is the **durable local spec** for a capability (`<slug>` kebab-case),
edited in place, never synced, minimal frontmatter (`slug`/`title`/`status`/`created`). Each change
effort is a **dated folder** `<slug>/<YYYY-MM-DD>-<change-slug>/` (directly under `<slug>/`, no
`changes/` wrapper) of Chorus-typed docs: `prd.md` (primary), optional
`tech_design.md`/`adr.md`/`guide.md`/`spec.md`. Each such file carries `spec: ../spec.md`,
`proposalUuid`, `documentUuid`; its Document type is implied by the filename. Old dated folders are
never rewritten — a new effort gets a new dated folder.

> Naming: the durable `<slug>/spec.md` (local only, no ids) is distinct from a per-change `spec`-type
> doc that would live at `<slug>/<date>-<slug>/spec.md` (synced, carries ids). Prefer `prd.md` as the
> per-change primary doc.

## Mode resolution (unchanged)
`CHORUS_SPEC_MODE` resolves to `{lite, openspec, off}` in `bin/resolve-spec-mode.sh`: explicit env
wins; unset → OpenSpec when usable (`openspec/` dir + CLI, not disabled) else lite; `=openspec` fails
fast (install hint / config-conflict) when unusable. The SessionStart hook sources the resolver and
prints the `## Spec Mode` section; proposal/develop/yolo branch on the resolved value. This effort does
not touch that logic.

## Mirroring (only dated-folder docs; never spec.md)
Each dated-folder `<type>.md` maps to **one persistent** Chorus Document of that type, tracked by
`documentUuid`, mirrored byte-exact via `--arg-file` (no re-typed content):

```bash
# first time a doc is authored (draft under the introducing proposal)
chorus mcp call chorus_pm_add_document_draft \
  '{"proposalUuid":"<uuid>","type":"prd","title":"PRD: <title>"}' \
  --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/prd.md

# later edits (Document materialized; version auto-increments each call)
chorus mcp call chorus_pm_update_document \
  '{"documentUuid":"<uuid>"}' \
  --arg-file content=.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/prd.md
```

Before approval, edit the draft via `chorus_pm_update_document_draft`; on approval resolve the Document
by `(proposalUuid, type)` via `chorus_get_documents`, record `documentUuid`, re-mirror once. Guard
every mirror with the `chorus_check_response` halt-on-error helper (openspec-aware §6); fall back to
`chorus-api.sh` + `json_encode_file` when `chorus` isn't on `PATH`. `<slug>/spec.md` is NEVER mirrored.

## Delivery (docs + templates only)
No `src/`, `prisma/`, `mcp/`, or CLI changes. Files: the `spec-lite` skill, `docs/SPEC_LITE.md`,
`.chorus/specs/TEMPLATE/spec.md` + `TEMPLATE/YYYY-MM-DD-change/prd.md` (+ `tech_design.md`) + README,
and the mode branches in the proposal/develop/yolo skills (+ the chorus/openspec-aware cross-refs).
`.gitignore` keeps `.chorus/*` + `!.chorus/specs/`. Mode resolver + `## Spec Mode` hook untouched.
