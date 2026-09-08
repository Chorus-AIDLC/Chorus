---
date: 2026-09-08
change: chorus-native-and-model-b
spec: ..                 # the durable spec-lite folder this change establishes
status: in-progress      # proposed | in-progress | done
proposalUuid:
---

# Chorus-native spec-lite, durable-spec + dated-change (model B)

## What changes
Introduces **spec-lite** as Chorus's lightweight, spec-driven mode and lands it in the
"durable spec + dated change docs" shape (superpowers-faithful). See `../prd.md` for the full spec.

- A capability is a **durable** folder `.chorus/specs/<slug>/` of Chorus-typed plain-markdown docs
  (`prd.md` required, optional `tech_design.md`/`adr.md`/`spec.md`/`guide.md`), **edited in place**
  across changes — not one folder per change.
- Each modification effort is a dated `changes/YYYY-MM-DD-<change-slug>.md` (What / Why / Acceptance),
  referencing the durable spec. This file is the first such record.
- Each durable `<type>.md` mirrors to a **persistent** Chorus Document of that `type`
  (`chorus_pm_add_document_draft` the first time, `chorus_pm_update_document` after — version
  auto-increments = modification history), via the `--arg-file` byte-exact transport. No new tool/CLI.
- The proposal `description` carries a locator line
  `Spec-lite: .chorus/specs/<slug>/ (change: changes/YYYY-MM-DD-<change-slug>.md)` (replacing the old
  `Spec-lite change slug:` marker) so develop finds both artifacts.
- Mode resolution and the `## Spec Mode` SessionStart hook are unchanged: explicit `CHORUS_SPEC_MODE`
  wins, else OpenSpec when usable, else lite (`bin/resolve-spec-mode.sh`).

## Why
Many capabilities only need a durable, human-readable, git-tracked record of intent + requirements
that also shows up in Chorus — without OpenSpec's four-file scaffold, `SHALL`/scenario grammar, or CLI.
Separating the *durable spec* (edited in place, one per capability) from *dated change records* (one
per effort) mirrors how superpowers keeps a lasting spec alongside dated per-effort plans, so a spec's
history reads cleanly while each change stays a small, self-contained, git-tracked note.

## Acceptance
- [x] `.chorus/specs/spec-lite/prd.md` is a durable capability spec (Intent / plain-prose Requirements + `- [ ]` / Non-goals), edited in place — no per-change-only framing.
- [x] This dated change file exists under `changes/`, referencing `../prd.md`, with What / Why / Acceptance.
- [x] `spec-lite` SKILL.md, `docs/SPEC_LITE.md`, `.chorus/specs/README.md`, and the TEMPLATE describe the durable-spec + dated-change (model B) shape and always-mirror-to-persistent-Document.
- [x] proposal / develop / yolo spec-lite branches speak model B (durable folder, dated change doc, locator line, persistent-Document mirror).
- [x] No version bumps; mode resolution + `## Spec Mode` hook untouched; no new MCP tool/CLI/backend.
