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
Chorus* rather than a re-skin of OpenSpec. Many changes just need a durable, human-readable,
git-tracked record of intent + requirements that also shows up in Chorus — without OpenSpec's
four-file scaffold, `SHALL`/scenario grammar, or CLI subprocess. This file is itself the living
example: a spec-lite spec, describing spec-lite.

## Requirements
A change is a folder `.chorus/specs/<slug>/` holding plain-markdown docs named by Chorus's own
Document types (`prd.md`, `tech_design.md`, `adr.md`, `spec.md`, `guide.md`). `prd.md` is the
only required file; the rest are added when the change warrants them. Each `<type>.md` mirrors
1:1, byte-exact, to a Chorus Document of that `type` via the existing document tools — no new
MCP tool, CLI, backend, or schema. The local folder is the source of truth; git history is the
audit trail (no changelog file). Mode: an explicit `CHORUS_SPEC_MODE=lite|openspec|off` wins;
when unset, **OpenSpec stays the default whenever it is usable** (`openspec/` dir + CLI, not
disabled) and **lite is the fallback** only when OpenSpec is absent or disabled. `=openspec` fails
fast with a clear reason when OpenSpec is unusable.

- [ ] A change lives in `.chorus/specs/<slug>/` with at least `prd.md`; no `tasks.md`, no changelog section, no OpenSpec grammar.
- [ ] Each `<type>.md` mirrors to a Chorus Document of the same `type` via `chorus_pm_add_document_draft` / `chorus_pm_update_document` with `--arg-file content=<file>` (byte-exact).
- [ ] When `CHORUS_SPEC_MODE` is unset, the mode resolves to `openspec` if OpenSpec is usable else `lite`; explicit `lite`/`openspec`/`off` win; legacy `CHORUS_OPENSPEC_MODE=off` still forces not-openspec (→ lite when unset).
- [ ] `CHORUS_SPEC_MODE=openspec` halts with an install hint (missing dir/CLI) or a config-conflict message (explicitly disabled) — never silently falls back.
- [ ] The SessionStart hook prints a `## Spec Mode` section that always states the active mode + a one-line routing note; passes `test-syntax.sh` (Bash 3.2).
- [ ] The `spec-lite` skill, `docs/SPEC_LITE.md`, and the proposal/develop/yolo mode branches all speak Chorus-native (prd/tech_design), lite-default, always-mirror.

## Non-goals
- No bidirectional (Chorus → local) pull; mirroring stays one-way, local → Chorus.
- No new `chorus spec` CLI, MCP tool, backend service, or DB schema change.
- No propagation to the other plugin surfaces (Codex/Kiro/OpenClaw/Pi/dsh) in this pass — Claude Code plugin only.
- No validation grammar — the format is intentionally unvalidated markdown.
