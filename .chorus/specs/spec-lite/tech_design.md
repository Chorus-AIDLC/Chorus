---
slug: spec-lite
title: spec-lite — technical design
status: active
created: 2026-09-08
---

# spec-lite — technical design

## Folder format
`.chorus/specs/<slug>/` — one folder per change, `<slug>` kebab-case and unique. Files are named
by Chorus `Document.type`: `prd.md`, `tech_design.md`, `adr.md`, `spec.md`, `guide.md`. `prd.md`
carries frontmatter (`slug`, `title`, `status`, `created`, optional `ideaUuid`/`proposalUuid`/
`documentUuid`); other files may repeat a short frontmatter or none. Only `prd.md` is required.

## Mode resolution (lite default)
Resolve `CHORUS_SPEC_MODE` to one of `{lite, openspec, off}`:
1. Env `CHORUS_SPEC_MODE=lite|openspec|off` wins.
2. Unset → **lite** (the default).
3. `=openspec` requires a usable OpenSpec (`openspec/` dir + CLI on PATH, not disabled). If not
   usable → fail fast: install hint (`npm i -g @fission-ai/openspec` / `openspec init`) when
   missing, config-conflict message when explicitly disabled (`CHORUS_OPENSPEC_MODE=off` or the
   Enable-OpenSpec toggle). Legacy `CHORUS_OPENSPEC_MODE=off` forces not-openspec.

The SessionStart hook (`bin/on-session-start.sh`) computes the resolved mode + a human reason and
prints a `## Spec Mode` section; the proposal/develop/yolo skills branch on the resolved value.

## Mirroring (always, one-way local → Chorus)
Each `<type>.md` mirrors to a Chorus Document of that `type`, byte-exact, via the existing tools
and the `--arg-file` transport (no re-typed content):

```bash
chorus mcp call chorus_pm_add_document_draft \
  '{"proposalUuid":"<uuid>","type":"prd","title":"PRD: <title>"}' \
  --arg-file content=.chorus/specs/<slug>/prd.md
```

Post-approval edits use `chorus_pm_update_document` against the materialized Document UUID. Guard
every mirror with the `chorus_check_response` halt-on-error helper (openspec-aware §6). Record
`proposalUuid`/`documentUuid` in `prd.md` frontmatter once known and re-mirror so local == Chorus.

## Delivery (docs + one hook + templates)
No `src/`, `prisma/`, `mcp/`, or CLI changes. Files: the `spec-lite` skill, `docs/SPEC_LITE.md`,
`.chorus/specs/TEMPLATE/prd.md` + README, the `## Spec Mode` block in `on-session-start.sh`, and
the mode branches in the proposal/develop/yolo skills (+ the openspec-aware cross-reference).
`.gitignore` keeps `.chorus/*` + `!.chorus/specs/` so specs are tracked while runtime state stays ignored.
