---
slug: spec-lite
title: Lightweight Chorus-native local spec management
status: active           # draft | active | done
created: 2026-09-08
---

# Lightweight Chorus-native local spec management

## Intent
Give Chorus a genuinely lightweight, spec-driven mechanism that is *native to Chorus* rather than a
re-skin of OpenSpec. Many capabilities only need a durable, human-readable, git-tracked record of
intent + requirements — without OpenSpec's four-file scaffold, `SHALL`/scenario grammar, or CLI
subprocess. This file is itself the living example: the durable spec-lite spec, describing spec-lite.

## Requirements
A capability is a folder `.chorus/specs/<slug>/` (`<slug>` names the capability, not one change) with
two kinds of thing:

- **`<slug>/spec.md` — the durable local spec.** One cumulative, human-readable file, **edited in
  place** by every change. Minimal frontmatter only (`slug`, `title`, `status`, `created`) then plain
  prose (Intent / Requirements + `- [ ]` / Non-goals). It is the local "current truth", **never synced
  to Chorus and carries no Chorus ids** — its git history is the record. It NEVER enters the mirror loop.
- **One dated folder per change effort — `<slug>/<YYYY-MM-DD>-<change-slug>/`** (directly under
  `<slug>/`, **no `changes/` wrapper**). It holds the Chorus-typed docs for THAT change: `prd.md`
  (primary), optional `tech_design.md` / `adr.md` / `guide.md` / `spec.md`. These **are** mirrored 1:1,
  byte-exact, into **persistent** Chorus Documents of the matching type via the existing document tools
  (`chorus_pm_add_document_draft --arg-file` the first time, `chorus_pm_update_document --arg-file`
  after — version auto-increments). Their frontmatter carries `proposalUuid` / `documentUuid`. A
  different change to the same capability is a different dated folder; the current change's folder is
  edited/re-mirrored until delivery, and only previously-delivered folders are left frozen.

The proposal `description` carries one locator line pointing at the dated change folder. There is no
`tasks.md` (tasks live in Chorus), no new MCP tool, CLI, backend, or schema. Naming caution: the
durable file is `<slug>/spec.md` (local only, no ids); a per-change `spec`-type doc would live at
`<slug>/<date>-<slug>/spec.md` (synced, carries ids) — prefer `prd.md` as the per-change primary doc.
Mode: an explicit `CHORUS_SPEC_MODE=lite|openspec|off` wins; when unset, OpenSpec stays the default
whenever usable and lite is the fallback; `=openspec` fails fast when OpenSpec is unusable. Mode logic
lives in `bin/resolve-spec-mode.sh` and the `## Spec Mode` SessionStart hook.

- [ ] `<slug>/spec.md` is the durable local spec — edited in place, minimal frontmatter, no Chorus ids, never mirrored.
- [ ] Each change effort is one dated folder `<slug>/<YYYY-MM-DD>-<change-slug>/` (no `changes/` wrapper) of Chorus-typed docs; the current change's folder is editable/re-mirrored until delivery, only previously-delivered folders are frozen.
- [ ] Each dated-folder `<type>.md` mirrors to a persistent Chorus Document of that type (`--arg-file`, byte-exact, never re-typed); frontmatter carries `proposalUuid`/`documentUuid`.
- [ ] Identity resolves by `documentUuid` / `(proposalUuid, type)`; zero/multi match halts (never by title alone). `spec.md` is never in the mirror loop.
- [ ] The proposal `description` carries one locator line `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` so develop finds the change docs.
- [ ] Mode resolution + `## Spec Mode` hook (`bin/resolve-spec-mode.sh`) unchanged: explicit wins, else OpenSpec when usable, else lite.
- [ ] The `spec-lite` skill, `docs/SPEC_LITE.md`, `.chorus/specs/README.md`, the TEMPLATE, and the proposal/develop/yolo branches all speak this durable-spec + dated-folder model.

## Non-goals
- No bidirectional (Chorus → local) pull; mirroring stays one-way, local → Chorus, and only for dated-folder docs.
- No new `chorus spec` CLI, MCP tool, backend service, or DB schema change.
- No propagation to the other plugin surfaces (Codex/Kiro/OpenClaw/Pi/dsh) in this pass — Claude Code plugin only.
- No validation grammar — the format is intentionally unvalidated markdown.
