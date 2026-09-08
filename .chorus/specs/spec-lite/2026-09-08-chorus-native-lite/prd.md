---
title: "PRD: Chorus-native spec-lite (durable spec + dated change folders)"
spec: ../spec.md
proposalUuid:
documentUuid:
---

# Chorus-native spec-lite — durable spec + dated change folders

<!-- Per-change PRD for the first spec-lite change effort. Synced 1:1 into a persistent Chorus
     Document of type `prd`. The durable cumulative spec is ../spec.md (local only, never synced). -->

## Intent
Land spec-lite as Chorus's lightweight spec mode in its final shape: a durable local `spec.md` per
capability (never synced) plus one dated folder per change effort holding the Chorus-typed docs that
ARE synced. This first effort establishes the model and dogfoods it on spec-lite itself.

## Requirements
See ../spec.md for the cumulative capability spec. This change delivers:

- A durable `<slug>/spec.md` (edited in place, no Chorus ids, never mirrored) and per-change dated
  folders `<slug>/<YYYY-MM-DD>-<change-slug>/` (no `changes/` wrapper) of Chorus-typed docs (`prd.md`
  primary, optional `tech_design.md`/…) mirrored 1:1 into persistent Chorus Documents via `--arg-file`.
- The proposal `description` locator line `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`
  so develop finds the change docs.
- Mode resolution + `## Spec Mode` hook unchanged (explicit wins, else OpenSpec when usable, else lite).

- [ ] `.chorus/specs/spec-lite/spec.md` is the durable local spec (Intent / Requirements + `- [ ]` / Non-goals), edited in place, no Chorus ids, never mirrored.
- [ ] This dated folder `2026-09-08-chorus-native-lite/` holds the synced change docs (`prd.md` + `tech_design.md`) with `proposalUuid`/`documentUuid` frontmatter.
- [ ] `spec-lite` SKILL.md, `docs/SPEC_LITE.md`, `.chorus/specs/README.md`, and the TEMPLATE describe the durable-spec + dated-folder model; only dated-folder docs mirror.
- [ ] proposal / develop / yolo spec-lite branches speak this model (durable `spec.md`, dated change folder, locator line → dated folder, persistent-Document mirror of dated docs only).
- [ ] No version bumps; mode resolution + `## Spec Mode` hook untouched; no new MCP tool/CLI/backend.

## Non-goals
- No bidirectional pull, no new CLI/MCP/backend, no propagation to other plugin surfaces, no validation grammar (see ../spec.md Non-goals).
