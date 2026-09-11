---
name: spec-lite
description: Lightweight, Chorus-native local specs for Chorus PM workflows — a durable local spec `.chorus/specs/<slug>/spec.md` (one per capability/feature) edited in place and NEVER synced (git history is its record), plus one dated folder per change effort `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` holding Chorus-typed docs (prd.md, tech_design.md, …) that ARE mirrored 1:1 into persistent Chorus Documents via `--arg-file`. The fallback when OpenSpec isn't in use; a low-token alternative to the heavier openspec-aware path. Read from proposal / develop / yolo when the spec mode resolves to `lite`.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.18.0"
  category: project-management
  mcp_server: chorus
---

# spec-lite — durable local spec + per-change synced docs

A **shared sub-procedure** for the Chorus stage skills (proposal, develop, yolo) — the lightweight
spec mode, modelled on **superpowers** (a durable spec that lives on, plus per-effort artifacts):
one **durable local spec** per capability (`<slug>/spec.md`, edited in place, **never synced** — git
history is its 留痕), plus one **dated folder per change effort** (`<slug>/<YYYY-MM-DD>-<change-slug>/`
of Chorus-typed docs — `prd.md`, … — that **are** mirrored 1:1 into persistent Chorus Documents).
No new CLI, MCP tool, backend, or schema — mirroring reuses the existing document tools.

## Mode (how you got here)

The spec mode is computed by the SessionStart hook (`bin/resolve-spec-mode.sh`), **not by you** — the
`## Spec Mode` section of your context states the resolved `CHORUS_SPEC_MODE`. You are here because it
resolved to `lite`; if it is anything else, this skill is a no-op — return to the caller. (For the
record, the hook's rule: an explicit `CHORUS_SPEC_MODE` wins, else OpenSpec when usable, else lite.)

## The durable local spec — `<slug>/spec.md`

`.chorus/specs/<slug>/spec.md` — `<slug>` (kebab-case) names a **capability/feature, not one change**.
This is the single, cumulative, human-readable "current truth" of the capability: **edited in place**
by every change, **never mirrored to Chorus, carries no Chorus ids**. Minimal frontmatter only
(`slug`, `title`, `status: draft|active|done`, `created`), then plain prose — `## Intent`,
`## Requirements` (prose + `- [ ]` acceptance points, no `SHALL`/scenario grammar), `## Non-goals`.
Start from the inline **durable `spec.md` template** below. Its git history is the whole record — no changelog
section, no Chorus round-trip. **This file NEVER enters the mirror loop.**

`status` describes the **capability**, not a single change: `active` while any change is in flight,
`done` when the current change delivers and none is open. A **new** change against a `done` capability
reopens it to `active`, back to `done` on delivery.

### Template — the durable `spec.md`

```markdown
---
slug: <kebab-case-capability>
title: <Capability title>
status: draft            # draft | active | done
created: <YYYY-MM-DD>
---

## Intent
<what this capability is for, in prose>

## Requirements
<prose, no SHALL/scenario grammar>
- [ ] <acceptance point>

## Non-goals
- <explicitly out of scope>
```

## Per-change dated folders — `<slug>/<YYYY-MM-DD>-<change-slug>/`

Each change effort is **one dated folder directly under `<slug>/`** (no `changes/` wrapper), e.g.
`.chorus/specs/<slug>/2026-09-08-add-export/`. Date + slug so same-day changes don't collide and
folders sort by date. It holds the **Chorus-typed** docs for THAT change — one file per Document type:

| File | `Document.type` | Required? |
|---|---|---|
| `prd.md` | `prd` | **yes** — the primary per-change doc |
| `tech_design.md` | `tech_design` | optional — the "how" |
| `adr.md` / `guide.md` / `spec.md` | `adr` / `guide` / `spec` | optional |

These files **ARE synced** — each maps to **one persistent Chorus Document** of its type. Their
frontmatter carries the sync ids `proposalUuid` and `documentUuid` (the type is implied by the
filename). Start from the inline **dated-folder document template** below. A different change to the same
capability is a different dated folder. The **current change's** folder is edited and re-mirrored
throughout its effort (until delivery); only **previously-delivered** dated folders are left frozen —
you don't reach back and rewrite a past change.

> **Two files named `spec.md`, different roles.** The durable `<slug>/spec.md` (local only, no ids) is
> NOT the same as a per-change `spec`-type doc, which would live at `<slug>/<date>-<slug>/spec.md`
> (synced, carries ids). Prefer `prd.md` as the per-change primary doc to avoid the confusion.

### Template — a dated-folder document

The document **type is implied by the filename** (`prd.md` → `prd`, `tech_design.md` → `tech_design`, …),
**NOT** a frontmatter key.

```markdown
---
title: <Document title as it appears in Chorus>
proposalUuid: <uuid>      # written on first mirror
documentUuid:             # empty until the draft materializes on approval
---

# <Document title>
<body — this file's bytes are the source of truth for the Chorus Document>
```

## Flow (one change)

1. Confirm mode = `lite` (else no-op).
2. Create the dated folder `<slug>/<YYYY-MM-DD>-<change-slug>/` and write its **synced** change docs —
   `prd.md` (required), `tech_design.md` etc. only if warranted (use the **dated-folder document template** above).
3. **Update `<slug>/spec.md` in place** to the new cumulative truth (Requirements, acceptance points,
   `status`) — local only, no sync.
4. Create the proposal container with one literal locator line in `description` (own line, no trailing
   punctuation) so develop finds the change:
   `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/`
5. **Mirror the dated folder's docs** to Chorus (below). Add tasks via `chorus_pm_add_task_draft` —
   **no `tasks.md`**, no CLI / validate / archive, no delta grammar. **Tasks live in Chorus.**
6. Develop → keep editing `spec.md` + the change docs, re-mirroring the change docs as work lands and
   ticking acceptance points. On delivery set the durable `spec.md` `status: done`.

## Mirror — only the dated-folder docs (never `spec.md`)

Every dated-folder `<type>.md` maps to **one persistent Chorus Document** of that `type`, tracked by
`documentUuid` in the file's frontmatter. Fill `content` from the file's bytes with `--arg-file` —
never re-type the body (drifts, burns ~20k tokens). One call per file; resolve identity by
`documentUuid` / `(proposalUuid, type)`, **never by `title` alone** (a lookup finding zero or >1 MUST
**halt**). Guard every call with the `chorus_check_response` halt-on-error helper (`openspec-aware`
§6). No `chorus` on `PATH`? Fall back to `chorus-api.sh` + `json_encode_file` (`openspec-aware` §3.6).
**`<slug>/spec.md` is NEVER in this loop.**

- **First time a doc is authored** (its dated folder is new): write `proposalUuid` into frontmatter,
  mirror into a proposal **draft** —
  `chorus mcp call chorus_pm_add_document_draft "{\"proposalUuid\":\"$P\",\"type\":\"prd\",\"title\":\"PRD: $TITLE\"}" --arg-file content=".chorus/specs/$SLUG/$DATED/prd.md"`.
  Edit the draft via `chorus_pm_update_document_draft` (returned `draftUuid`) before approval. On
  approval it materializes into a persistent Document — resolve by `(proposalUuid, type)` via
  `chorus_get_documents`, record `documentUuid` in frontmatter, re-mirror once so local == Chorus.
- **Later edits** (a doc that already has a `documentUuid`): edit the file, then
  `chorus mcp call chorus_pm_update_document "{\"documentUuid\":\"$D\"}" --arg-file content=".chorus/specs/$SLUG/$DATED/<type>.md"`.
  Each update **auto-increments the Document version** — that version history is the change doc's
  record in Chorus, alongside git.

## 留痕: git history + Document versions

`git log -- .chorus/specs/$SLUG/` is the audit trail — the durable `spec.md`'s in-place diffs plus each
dated folder's change docs; the mirrored Documents' auto-incremented versions are the parallel record
in Chorus. No changelog section to maintain. Only `.chorus/specs/` is version-controlled (`.chorus/*` +
`!.chorus/specs/`).

**Single-writer:** the folder is shared — in a multi-task wave only the **orchestrator / main agent**
edits + re-mirrors; parallel workers report via `chorus_report_work` only, re-reading before any write.
**Task state lives in Chorus**, not the docs — the `- [ ]` points are acceptance intent, not a tracker.
