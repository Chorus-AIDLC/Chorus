# Design — spec-lite

## Goal

A lightweight, git-tracked local spec format that costs a fraction of the OpenSpec ceremony in tokens and time, keeps a human-readable local audit trail (留痕), and mirrors one-way into Chorus — delivered purely as a skill + convention + docs, with no new CLI, MCP tool, or backend.

## The file format: `.chorus/specs/<slug>.md`

One file per change. `<slug>` is kebab-case, derived from the idea/change title, unique within `.chorus/specs/`.

```markdown
---
slug: add-export-csv
title: Add CSV export to the reports page
status: draft            # draft | active | done
created: 2026-09-08
ideaUuid: <optional Chorus idea uuid>
proposalUuid: <optional, filled after Chorus sync>
---

## Intent
<1-2 sentences: the business/user intent this change serves.>

## Requirements
### R1: <requirement name>
<what must be true. Plain prose — no SHALL/MUST grammar required.>
- [ ] AC: <testable acceptance criterion>
- [ ] AC: <testable acceptance criterion>

### R2: <requirement name>
...

## Tasks
- [ ] T1: <task — the unit of work>
- [ ] T2: <task> (depends: T1)

## Changelog
- 2026-09-08T03:00:00Z — created (spec-lite)
```

Design notes are **optional and inline** (a `## Design` section may be added when a change warrants it) — deliberately not a separate file, to stay at one file per change.

### Why single-file with frontmatter

- **Fewest tokens.** One file to read and one to write per change vs. OpenSpec's four. Frontmatter carries the machine-readable metadata (slug/status/uuids) so a reader can skip the body when it only needs state.
- **留痕 falls out of git.** The Changelog section is an append-only, timestamped human log; `git log --follow .chorus/specs/<slug>.md` is the full machine history. No separate `audit.md` needed (contrast AI-DLC, which splits state/audit — we fold both into one file for v1 frugality).
- **Human-editable, offline-first.** No tool is required to read, write, or diff it.

## Mode selection (coexist, opt-in)

spec-lite and OpenSpec **coexist**. Resolution order for the active spec mode:

1. `CHORUS_SPEC_MODE=lite` → spec-lite. `CHORUS_SPEC_MODE=openspec` → OpenSpec. `off` → neither (free-form).
2. Else, if OpenSpec is active (`CHORUS_OPENSPEC_ACTIVE=1`, per `openspec-aware` §1) → OpenSpec (unchanged default).
3. Else, if a `.chorus/specs/` directory exists → spec-lite.
4. Else → free-form (no spec artifact), exactly as today.

This keeps every existing OpenSpec project on its current path (no behavior change) while letting any project opt into the lighter format. Graduating spec-lite to the default later is a one-line change to step 2's precedence.

## Sync: one-way push, local → Chorus

- **Direction:** push only. The local file is the source of truth; Chorus is a mirror. No reverse pull in v1.
- **Trigger:** at proposal submit (and on subsequent local edits before/after approval), mirror the file into a Chorus `spec` document.
- **Transport (reused, not new):** `chorus mcp call chorus_pm_add_document_draft '{"proposalUuid":"…","type":"spec","title":"Spec: <title>"}' --arg-file content=.chorus/specs/<slug>.md` — the same byte-exact `--arg-file` mechanism `openspec-aware` §3.6 already uses. `chorus_pm_update_document_draft` / `chorus_pm_update_document` for later edits. `type: "spec"` is an existing `Document.type` — **no schema change**.
- **No new MCP tool, no new CLI, no sync daemon.** The "sync engine" is one documented `chorus mcp call` per change.

## Lifecycle wiring (fulfils Q1 "woven into proposal/develop/yolo" + Q7 "auto at submit")

spec-lite is a **shared sub-procedure**, exactly like `openspec-aware`. The stage skills route to it via the mode-selection order above:

- **proposal / yolo (authoring):** at the spec-authoring step, the skill resolves the active spec mode. If it resolves to `lite`, the flow authors `.chorus/specs/<slug>.md` (instead of scaffolding `openspec/changes/`) and, on **proposal submit**, mirrors that file into a Chorus `spec` document draft via `chorus_pm_add_document_draft … --arg-file` — the auto-sync trigger. The `spec-lite` skill owns this submit-time mirror step (the same way `openspec-aware` §3.6 owns its mirror).
- **develop:** when a spec-lite spec exists for the work, the develop flow reads `.chorus/specs/<slug>.md` for context and appends a timestamped `## Changelog` entry as tasks complete (the 留痕), mirroring edits back with `chorus_pm_update_document(_draft)`.

Each stage skill gets a short **"Spec mode" branch** that names the resolution order and points to either `openspec-aware` or `spec-lite`. This is functional routing, not a passive "see also": with the branch in place, a `CHORUS_SPEC_MODE=lite` session actually flows through spec-lite end-to-end.

## Delivery (files — skill/convention/docs + two small wiring edits)

| File | Purpose |
|---|---|
| `public/chorus-plugin/skills/spec-lite/SKILL.md` | The spec-lite skill: format, mode-selection contract, authoring steps, the submit-time one-way push-sync procedure, and the develop-time Changelog/留痕 step. |
| `.chorus/specs/TEMPLATE.md` | Copy-me starting template (the format above, empty). |
| `.chorus/specs/README.md` | One-paragraph explanation of the directory + link to the skill/doc. |
| `docs/SPEC_LITE.md` | User/developer reference: when to use lite vs OpenSpec, format, sync, 留痕, token rationale. |
| `.gitignore` | Re-include `.chorus/specs/` (see below) so specs are git-tracked while plugin runtime state stays ignored. |
| Spec-mode branch in `proposal` / `develop` / `yolo` skills + a cross-ref in `openspec-aware` | Route the lifecycle flows to the mode-selection order; no change to the OpenSpec authoring steps or its default precedence. |

No files under `src/`, `prisma/`, `mcp/`, or the CLI are touched.

### `.gitignore` — specs must be tracked

The repo's `.gitignore` ignores `.chorus/` wholesale (Chorus plugin runtime state: `artifacts/`, `state.json`). Because spec-lite's whole premise is a **git-tracked** local record, the ignore is narrowed so plugin state stays ignored but specs are tracked:

```gitignore
# Chorus plugin state (ignore runtime state, but keep git-tracked spec-lite specs)
.chorus/*
!.chorus/specs/
```

`.chorus/*` still ignores `artifacts/`, `state.json`, and `state.json.lock`; `!.chorus/specs/` re-includes the specs directory (git can re-include a child only when the parent dir itself isn't excluded — hence `.chorus/*`, not `.chorus/`). Verified with `git check-ignore`.

## Non-goals (v1)

- Making spec-lite the default (stays opt-in).
- Bidirectional sync (Chorus → local pull).
- Full plugin-surface parity (Codex/Kiro/OpenClaw/Pi/dsh) — v1 authors the Claude Code plugin surface; other surfaces are a follow-up.
- Any validation grammar (SHALL/scenario). The format is intentionally unvalidated markdown.

## Risks

- **Two coexisting modes add a choice point.** Mitigated by the deterministic resolution order above and by keeping OpenSpec the default when active.
- **`.chorus/` already holds plugin runtime state** (`artifacts/`, `state.json`) and is fully gitignored. spec-lite namespaces under `.chorus/specs/` (never sharing files with plugin state) and the `.gitignore` is narrowed (`.chorus/*` + `!.chorus/specs/`) so specs are tracked while runtime state stays ignored.
- **Skill-surface drift** (only the CC plugin gets it in v1). Accepted and recorded as an explicit follow-up rather than fanning out prematurely.
