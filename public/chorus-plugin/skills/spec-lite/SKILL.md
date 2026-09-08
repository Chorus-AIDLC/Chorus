---
name: spec-lite
description: Lightweight, Chorus-native local specs for Chorus PM workflows — a git-tracked DURABLE spec folder `.chorus/specs/<slug>/` (one per capability/feature) of plain-markdown docs named by Chorus Document type (prd.md, tech_design.md, …), edited in place and each mirrored 1:1 into a persistent Chorus Document, plus dated change records under `changes/YYYY-MM-DD-<change-slug>.md`. The default when OpenSpec isn't in use; a low-token alternative to the heavier openspec-aware path. Read from proposal / develop / yolo when the spec mode resolves to `lite`.
license: AGPL-3.0
metadata:
  author: chorus
  category: project-management
  mcp_server: chorus
---

# spec-lite — durable local specs + dated change docs

A **shared sub-procedure** for the Chorus stage skills (proposal, develop, yolo) — the lightweight
spec mode. Two artifacts, mirroring **superpowers** (a durable spec, plus dated plans per effort):

- a **durable spec** per capability/feature — plain-markdown docs edited *in place* across changes,
  each mirrored 1:1 into a persistent Chorus Document; and
- **dated change records** — one lean file per modification effort, git-tracked (the git log is 留痕).

No new CLI, MCP tool, backend, or schema — mirroring reuses the existing document tools.

## Mode (how you got here)

The spec mode is computed by the SessionStart hook (`bin/resolve-spec-mode.sh`), **not by you** — the
`## Spec Mode` section of your context states the resolved `CHORUS_SPEC_MODE`. You are here because it
resolved to `lite`; if it is anything else, this skill is a no-op — return to the caller. (For the
record, the hook's rule: an explicit `CHORUS_SPEC_MODE` wins, else OpenSpec when usable, else lite.)

## The durable spec folder

`.chorus/specs/<slug>/` — `<slug>` (kebab-case) names a **capability/feature, not one change**. It is
long-lived: successive changes edit its docs in place. Files are named by **Chorus Document type**:

| File | `Document.type` | Required? |
|---|---|---|
| `prd.md` | `prd` | **yes** — the only required file |
| `tech_design.md` | `tech_design` | optional — the "how" |
| `adr.md` / `spec.md` / `guide.md` | `adr` / `spec` / `guide` | optional |

`prd.md` = a Chorus PRD: frontmatter (`slug`, `title`, `status: draft\|active\|done`, `created`,
optional `ideaUuid`/`proposalUuid`/`documentUuid`), then `## Intent` (intent + background),
`## Requirements` (plain prose + `- [ ]` acceptance points — no `SHALL`/scenario grammar), and a
`## Non-goals` list. Copy `.chorus/specs/TEMPLATE/prd.md` to start. Each optional `<type>.md` carries
its own short frontmatter (incl. its own `documentUuid`). Terse — fewer tokens than OpenSpec is the point.

## Dated change records

`.chorus/specs/<slug>/changes/YYYY-MM-DD-<change-slug>.md` — **one file per modification effort**; the
date prefix lets many changes to one spec coexist without collision. Copy
`.chorus/specs/TEMPLATE/changes/YYYY-MM-DD-change.md`: frontmatter (`date`, `change` slug, `spec: ..`
= the durable spec folder, `status`, optional `proposalUuid`), then `## What changes` (referencing
`../prd.md`), `## Why`, and `## Acceptance` (`- [ ]` for **THIS change** only). **No task step-list**
(tasks live in Chorus), **no CLI / validate / archive / delta grammar**. Git-tracked and never
rewritten by later changes — a new effort gets a new dated file.

## Flow

1. Confirm mode = `lite` (else no-op).
2. Ensure `.chorus/specs/$SLUG/prd.md` exists — create it from the template the first time this
   capability is specced.
3. Write the dated change doc `changes/YYYY-MM-DD-<change-slug>.md` (What / Why / Acceptance).
4. **Edit the durable spec docs in place** to the new truth (Requirements, acceptance points,
   `status`; add `tech_design.md` etc. if warranted).
5. Create the proposal container with one literal locator line in `description` (own line, no trailing
   punctuation) so develop finds both artifacts:
   `Spec-lite: .chorus/specs/<slug>/ (change: changes/YYYY-MM-DD-<change-slug>.md)`
6. **Mirror** each touched durable doc (below). Add tasks via `chorus_pm_add_task_draft` — no `tasks.md`.
7. Develop → keep editing + re-mirroring; tick acceptance points as work lands. On delivery set the
   durable `status: done` and re-mirror.

## Always mirror the durable docs to Chorus

Every durable `<type>.md` maps to **one persistent Chorus Document** of that `type`, tracked by
`documentUuid` in the file's frontmatter. Fill `content` from the file's bytes with `--arg-file` —
never re-type the body (drifts, burns ~20k tokens). One call per file; resolve identity by
`documentUuid` / `(proposalUuid, type)`, **never by `title` alone** (a lookup finding zero or >1 MUST
**halt**). Guard every call with the `chorus_check_response` halt-on-error helper (`openspec-aware`
§6). No `chorus` on `PATH`? Fall back to `chorus-api.sh` + `json_encode_file` (`openspec-aware` §3.6).

- **First time a doc is specced** (the change that introduces it): write `proposalUuid` into
  frontmatter, mirror into a proposal **draft** —
  `chorus mcp call chorus_pm_add_document_draft "{\"proposalUuid\":\"$P\",\"type\":\"prd\",\"title\":\"PRD: $TITLE\"}" --arg-file content=".chorus/specs/$SLUG/prd.md"`.
  Before approval, edit the draft via `chorus_pm_update_document_draft` (returned `draftUuid`). On
  approval it materializes into a persistent Document — resolve by `(proposalUuid, type)` via
  `chorus_get_documents`, record `documentUuid` in frontmatter, re-mirror once so local == Chorus.
- **Later edits** (a doc that already has a `documentUuid`): edit the file, then
  `chorus mcp call chorus_pm_update_document "{\"documentUuid\":\"$D\"}" --arg-file content=".chorus/specs/$SLUG/<type>.md"`.
  Each update **auto-increments the Document version** — that version history is the modification
  record in Chorus, alongside git.

## 留痕: git history + Document versions

`git log -- .chorus/specs/$SLUG/` is the audit trail for the local docs (dated change files +
durable-doc diffs; `git log --follow -- <file>` for one renamed file); the mirrored Documents'
auto-incremented versions are the parallel record in Chorus. No changelog section to maintain. Only
`.chorus/specs/` is version-controlled (`.chorus/*` + `!.chorus/specs/`).

**Single-writer:** the folder is shared — in a multi-task wave only the **orchestrator / main agent**
edits + re-mirrors; parallel workers report via `chorus_report_work` only, re-reading before any write.
**Task state lives in Chorus**, not the docs — the `- [ ]` points are acceptance intent, not a tracker.
