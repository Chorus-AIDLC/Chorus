---
slug: spec-lite
title: spec-lite — technical design
status: active
created: 2026-09-08
documentUuid:
---

# spec-lite — technical design

## Layout: durable spec + dated changes
`.chorus/specs/<slug>/` is a **durable spec** for a capability (`<slug>` kebab-case), edited in place.
Files are named by Chorus `Document.type`: `prd.md` (required), and optional `tech_design.md`,
`adr.md`, `spec.md`, `guide.md`. `prd.md` carries frontmatter (`slug`, `title`, `status`, `created`,
optional `ideaUuid`/`proposalUuid`/`documentUuid`); each optional file carries its own short
frontmatter incl. its own `documentUuid`. Each modification effort is a dated file
`changes/YYYY-MM-DD-<change-slug>.md` (frontmatter `date`/`change`/`spec: ..`/`status`; sections
`## What changes` referencing `../prd.md`, `## Why`, `## Acceptance`). Old change files are never
rewritten — a new effort gets a new dated file.

## Mode resolution (OpenSpec-first when usable, lite fallback)
Resolve `CHORUS_SPEC_MODE` to one of `{lite, openspec, off}`:
1. Explicit env `CHORUS_SPEC_MODE=lite|openspec|off` wins.
2. Unset → **openspec** when OpenSpec is usable (`openspec/` dir + CLI on PATH, not disabled);
   otherwise → **lite**. OpenSpec stays the default when present; lite is the fallback.
3. `=openspec` requires a usable OpenSpec. If not usable → fail fast: install hint
   (`npm i -g @fission-ai/openspec` / `openspec init`) when missing, config-conflict message when
   explicitly disabled (`CHORUS_OPENSPEC_MODE=off` or the Enable-OpenSpec toggle). Legacy
   `CHORUS_OPENSPEC_MODE=off` forces not-openspec (→ lite when unset).

The SessionStart hook (`bin/on-session-start.sh`) sources the pure resolver `bin/resolve-spec-mode.sh`,
computes the resolved mode + a human reason, and prints a `## Spec Mode` section; the
proposal/develop/yolo skills branch on the resolved value.

## Mirroring (always, one-way local → Chorus; persistent Document per durable doc)
Each durable `<type>.md` maps to **one persistent** Chorus Document of that `type`, tracked by
`documentUuid` in the file's frontmatter, mirrored byte-exact via the existing tools and the
`--arg-file` transport (no re-typed content):

```bash
# first time a doc is specced (draft under the introducing proposal)
chorus mcp call chorus_pm_add_document_draft \
  '{"proposalUuid":"<uuid>","type":"prd","title":"PRD: <title>"}' \
  --arg-file content=.chorus/specs/<slug>/prd.md

# later edits (Document already materialized; version auto-increments each call)
chorus mcp call chorus_pm_update_document \
  '{"documentUuid":"<uuid>"}' \
  --arg-file content=.chorus/specs/<slug>/prd.md
```

Before approval, edit the draft via `chorus_pm_update_document_draft` (returned `draftUuid`); on
approval resolve the materialized Document by `(proposalUuid, type)` via `chorus_get_documents`, record
`documentUuid` in frontmatter, re-mirror once. Guard every mirror with the `chorus_check_response`
halt-on-error helper (openspec-aware §6). The Document's auto-incremented versions are the modification
record in Chorus, parallel to git history of the local file.

## Delivery (docs + one hook + templates)
No `src/`, `prisma/`, `mcp/`, or CLI changes. Files: the `spec-lite` skill, `docs/SPEC_LITE.md`,
`.chorus/specs/TEMPLATE/prd.md` + `TEMPLATE/changes/YYYY-MM-DD-change.md` + README, the `## Spec Mode`
block in `on-session-start.sh` (sourcing `resolve-spec-mode.sh`), and the mode branches in the
proposal/develop/yolo skills (+ the openspec-aware cross-reference). `.gitignore` keeps `.chorus/*` +
`!.chorus/specs/` so specs are tracked while runtime state stays ignored.
