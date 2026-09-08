---
name: spec-lite
description: Lightweight local spec management for Chorus PM workflows — a single git-tracked `.chorus/specs/<slug>.md` per change (intent + requirements + tasks + changelog), local-first, mirrored one-way into Chorus. An opt-in, low-token alternative to the heavier openspec-aware path. Read from proposal / develop / yolo when the spec mode resolves to `lite`.
license: AGPL-3.0
metadata:
  author: chorus
  category: project-management
  mcp_server: chorus
---

# spec-lite — Lightweight Local Spec Authoring

A **shared sub-procedure** invoked by the Chorus stage skills (proposal, develop, yolo) — the lightweight sibling of `openspec-aware`. Where OpenSpec scaffolds four files per change and validates strict `SHALL`/scenario grammar through a CLI subprocess, spec-lite keeps **one plain-markdown file per change**, git-tracked, mirrored one-way into Chorus.

It is deliberately **infrastructure-free**: no new `chorus spec` CLI, no new MCP tool, no backend service, no database schema. Sync reuses the existing document tools. Savings come from (a) one terse file instead of four, and (b) dropping the OpenSpec CLI subprocess + strict validation.

---

## §1. Mode selection (how you got here)

Resolve the active spec mode deterministically. OpenSpec stays the default when active — spec-lite never overrides it silently:

1. `CHORUS_SPEC_MODE=lite` → **spec-lite** (this skill). `=openspec` → openspec-aware. `=off` → free-form (no spec artifact).
2. Else if OpenSpec is active (`CHORUS_OPENSPEC_ACTIVE=1`, per `openspec-aware` §1) → **openspec-aware** (unchanged default).
3. Else if a `.chorus/specs/` directory exists at the repo root → **spec-lite**.
4. Else → free-form, exactly as before either skill existed.

If the resolution is not `lite`, this skill is a no-op — return to the caller.

---

## §2. The file format: `.chorus/specs/<slug>.md`

One file per change. `<slug>` is kebab-case, derived from the idea/change title, unique within `.chorus/specs/`. Copy `.chorus/specs/TEMPLATE.md` to start.

```markdown
---
slug: add-export-csv
title: Add CSV export to the reports page
status: draft            # draft | active | done
created: 2026-09-08
ideaUuid:                # optional Chorus idea uuid
proposalUuid:            # optional, filled after the first Chorus sync
---

## Intent
<1-2 sentences: the user/business intent this change serves.>

## Requirements
### R1: <requirement name>
<plain prose — no SHALL/MUST grammar required.>
- [ ] AC: <testable acceptance criterion>
- [ ] AC: <testable acceptance criterion>

## Tasks
- [ ] T1: <unit of work>
- [ ] T2: <unit of work> (depends: T1)

## Changelog
- 2026-09-08T03:00:00Z — created (spec-lite)
```

Rules:

- **Four sections, in order:** `## Intent`, `## Requirements`, `## Tasks`, `## Changelog`. Frontmatter carries the machine-readable metadata so a reader can skip the body when it only needs status.
- **Requirements** are plain prose; acceptance criteria are `- [ ]` checkbox items under each requirement. No scenario grammar, no validator.
- **Tasks** are `- [ ]` checkboxes; note dependencies inline (`(depends: T1)`).
- A `## Design` section MAY be added inline when a change warrants it — do not split it into a separate file.

---

## §3. Authoring steps

1. Pick `$SLUG` (kebab-case, from the idea title). Ensure `.chorus/specs/` exists (create it if missing — it is git-tracked; see the repo `.gitignore` `!.chorus/specs/` re-include).
2. Copy `.chorus/specs/TEMPLATE.md` → `.chorus/specs/$SLUG.md` and fill Intent, Requirements (+AC), Tasks. Set frontmatter `slug`, `title`, `status: draft`, `created`, and `ideaUuid` if known.
3. Keep it terse. The whole value is fewer tokens than OpenSpec — do not pad.

---

## §4. Sync — one-way push, local → Chorus

The local file is the **source of truth**; Chorus is a downstream mirror. Sync is **push-only** (no reverse pull in v1) and uses the **existing** document tools with the byte-exact `--arg-file` transport — the same mechanism `openspec-aware` §3.6 uses. `type: "spec"` is a pre-existing `Document.type`; **no schema change**.

**Submit-time mirror (the auto-sync trigger).** When the proposal for this change is submitted, mirror the file into a Chorus `spec` document draft — one call, content filled from the file's bytes (never re-typed):

```bash
chorus mcp call chorus_pm_add_document_draft \
  "{\"proposalUuid\":\"$PROPOSAL_UUID\",\"type\":\"spec\",\"title\":\"Spec: $TITLE\"}" \
  --arg-file content=".chorus/specs/$SLUG.md"
```

Record `proposalUuid` back into the file's frontmatter after the first mirror. Guard every mirror call with the `chorus_check_response` halt-on-error helper from `openspec-aware` §6 (three signals: exit code, `"error":` in body, empty body) — no silent errors.

**Later edits.** Before approval, propagate local edits with `chorus_pm_update_document_draft` (same `--arg-file`); after approval, with `chorus_pm_update_document` against the materialized Document UUID. Re-derive the Document by matching `title` + `type: "spec"` via `chorus_get_documents`.

> If `chorus` is not on `PATH`, fall back to the `chorus-api.sh` wrapper with `json_encode_file`, exactly as `openspec-aware` §3.6 documents. Never hand-type the document `content`.

---

## §5. Develop-time: Changelog / 留痕

The `## Changelog` section is the local audit trail (留痕). As work proceeds:

- Append a timestamped line on each meaningful state change (created, tasks started, status → active/done):
  `- 2026-09-08T04:10:00Z — T1 done; status → active`
- Tick the `- [ ]` task/AC checkboxes as they complete.
- After editing, re-mirror the file to Chorus (§4) so the platform view stays current.

The full machine history is `git log --follow .chorus/specs/$SLUG.md` — no separate audit file. Because the file is plain git-tracked markdown, it and its history remain readable offline, with or without a Chorus connection.

When the change is delivered, set frontmatter `status: done` and append a final Changelog line.

---

## §6. What spec-lite does NOT add

- **No** new CLI command (no `chorus spec ...`).
- **No** new MCP tool — sync uses only `chorus_pm_add_document_draft` / `chorus_pm_update_document(_draft)`.
- **No** backend service, no sync daemon, no `prisma/schema.prisma` change.
- **No** change to the OpenSpec path — spec-lite is additive and opt-in; when OpenSpec is active and `CHORUS_SPEC_MODE` is unset, openspec-aware runs unchanged.

---

## §7. Quick checklist

1. Resolve mode (§1). If not `lite`, no-op.
2. Pick `$SLUG`; copy TEMPLATE → `.chorus/specs/$SLUG.md`; fill Intent / Requirements+AC / Tasks (§2–§3).
3. On proposal submit → mirror to a `spec` document draft via `--arg-file` (§4).
4. During develop → append timestamped `## Changelog` entries, tick checkboxes, re-mirror (§5).
5. On delivery → `status: done` + final Changelog line.
