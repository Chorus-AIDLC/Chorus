---
slug: spec-lite
title: Lightweight Chorus-native local spec management
status: active           # draft | active | done
created: 2026-09-08
ideaUuid:                # 1b6475a7 (recorded in project memory; not required here)
proposalUuid:
documentUuid:
---

# Lightweight Chorus-native local spec management

## Intent
Give Chorus a genuinely lightweight, spec-driven-development mechanism that is *native to
Chorus* rather than a re-skin of OpenSpec. Many capabilities just need a durable, human-readable,
git-tracked record of intent + requirements that also shows up in Chorus — without OpenSpec's
four-file scaffold, `SHALL`/scenario grammar, or CLI subprocess. This file is itself the living
example: a durable spec-lite spec, describing spec-lite.

## Requirements
A capability is a **durable folder** `.chorus/specs/<slug>/` (`<slug>` names the capability, not one
change) holding plain-markdown docs named by Chorus's own Document types (`prd.md`, `tech_design.md`,
`adr.md`, `spec.md`, `guide.md`). `prd.md` is the only required file; the rest are added when the
capability warrants them. The durable docs are **edited in place** as the capability evolves, and each
`<type>.md` mirrors 1:1, byte-exact, to a **persistent** Chorus Document of that `type` via the
existing document tools — created as a draft the first time, then updated (version auto-increments) on
later edits. Each modification effort is captured as a dated change file
`changes/YYYY-MM-DD-<change-slug>.md` (What / Why / Acceptance for that effort), referencing the
durable spec. No new MCP tool, CLI, backend, or schema. Git history is the local audit trail (no
changelog file). Mode: an explicit `CHORUS_SPEC_MODE=lite|openspec|off` wins; when unset, **OpenSpec
stays the default whenever it is usable** (`openspec/` dir + CLI, not disabled) and **lite is the
fallback** only when OpenSpec is absent or disabled. `=openspec` fails fast with a clear reason when
OpenSpec is unusable.

- [ ] A capability lives in a durable `.chorus/specs/<slug>/` with at least `prd.md`; docs are edited in place across changes; no `tasks.md`, no changelog section, no OpenSpec grammar.
- [ ] Each modification effort adds one dated `changes/YYYY-MM-DD-<change-slug>.md` (frontmatter `date`/`change`/`spec: ..`/`status`, then `## What changes` / `## Why` / `## Acceptance`), referencing `../prd.md`; old change files are never rewritten.
- [ ] Each durable `<type>.md` mirrors to a **persistent** Chorus Document of the same `type`: `chorus_pm_add_document_draft --arg-file` the first time, `chorus_pm_update_document --arg-file` (version auto-increments) on later edits — byte-exact, never re-typed.
- [ ] Each file maps deterministically to its Document via `documentUuid` (recorded in frontmatter after approval) or `(proposalUuid, type)`; zero/multi match → halt (never by title alone).
- [ ] The proposal `description` carries one locator line — `Spec-lite: .chorus/specs/<slug>/ (change: changes/YYYY-MM-DD-<change-slug>.md)` — so develop finds both the durable folder and the effort's change doc.
- [ ] When `CHORUS_SPEC_MODE` is unset, the mode resolves to `openspec` if OpenSpec is usable else `lite`; explicit `lite`/`openspec`/`off` win; legacy `CHORUS_OPENSPEC_MODE=off` still forces not-openspec (→ lite when unset).
- [ ] `CHORUS_SPEC_MODE=openspec` halts with an install hint (missing dir/CLI) or a config-conflict message (explicitly disabled) — never silently falls back.
- [ ] The mode resolver lives in `bin/resolve-spec-mode.sh` (pure); the SessionStart hook sources it and prints a `## Spec Mode` section; `test-syntax.sh` and `tests/test-spec-mode-resolution.sh` (Bash 3.2) both pass.
- [ ] The `spec-lite` skill, `docs/SPEC_LITE.md`, and the proposal/develop/yolo mode branches all speak the durable-spec + dated-change model (Chorus-native prd/tech_design, always-mirror, OpenSpec-default-when-usable / lite-fallback).

## Non-goals
- No bidirectional (Chorus → local) pull; mirroring stays one-way, local → Chorus.
- No new `chorus spec` CLI, MCP tool, backend service, or DB schema change.
- No propagation to the other plugin surfaces (Codex/Kiro/OpenClaw/Pi/dsh) in this pass — Claude Code plugin only.
- No validation grammar — the format is intentionally unvalidated markdown.
