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

Resolve the active spec mode deterministically to **one** value. OpenSpec stays the default when active — spec-lite never overrides it silently:

1. `CHORUS_SPEC_MODE=lite` → **lite** (this skill). `=openspec` → openspec-aware. `=off` → free-form (no spec artifact).
2. Else if OpenSpec is active (`CHORUS_OPENSPEC_ACTIVE=1`, per `openspec-aware` §1) → **openspec**.
3. Else if a `.chorus/specs/` directory exists at the repo root → **lite**.
4. Else → **free-form**.

Branch on the **resolved value**, not on `CHORUS_OPENSPEC_ACTIVE` — `lite` and `free-form` share `CHORUS_OPENSPEC_ACTIVE=0`, so keying off the raw flag double-matches. `CHORUS_SPEC_MODE=off` resolves to free-form explicitly (it is not the same as unset). If the resolution is not `lite`, this skill is a no-op — return to the caller.

**Fail fast on an unsatisfiable explicit request.** If `CHORUS_SPEC_MODE=openspec` but OpenSpec isn't usable (no `openspec/` dir or no `openspec` CLI on `PATH`), do **not** silently fall back to lite/free-form — that buries an explicit user intent. Halt and surface the install hint (`npm i -g @fission-ai/openspec` / `openspec init`), same as `openspec-aware`. (`CHORUS_SPEC_MODE` is the spec-mode selector for this feature; the legacy `CHORUS_OPENSPEC_MODE=off` still hard-disables OpenSpec as before and, absent `CHORUS_SPEC_MODE`, yields free-form.)

---

## §2. The file format: `.chorus/specs/<slug>.md`

One file per change. `<slug>` is kebab-case, derived from the idea/change title, unique within `.chorus/specs/`. Copy `.chorus/specs/TEMPLATE.md` to start (or, if it isn't present — e.g. a user repo where the plugin didn't ship it — create the file from the inline template below).

```markdown
---
slug: add-export-csv
title: Add CSV export to the reports page
status: draft            # draft | active | done
created: 2026-09-08
ideaUuid:                # optional Chorus idea uuid
proposalUuid:            # REQUIRED before the first mirror — the originating proposal
documentUuid:            # optional — backfilled after approval; makes re-mirror deterministic
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

- **Four sections, in order:** `## Intent`, `## Requirements`, `## Tasks`, `## Changelog`. Frontmatter carries the machine-readable metadata; `proposalUuid` is the durable link back to Chorus (see §4).
- **Requirements** are plain prose; acceptance criteria are `- [ ]` checkbox items under each requirement. No scenario grammar, no validator.
- **Tasks** are `- [ ]` checkboxes; note dependencies inline (`(depends: T1)`).
- A `## Design` section MAY be added inline when a change warrants it — do not split it into a separate file.

---

## §3. Authoring steps

1. Pick `$SLUG` (kebab-case, from the idea title). Ensure `.chorus/specs/` exists (create it if missing — it is git-tracked; see the repo `.gitignore` `!.chorus/specs/` re-include).
2. Create the file: copy `.chorus/specs/TEMPLATE.md` → `.chorus/specs/$SLUG.md` **if the template exists**, otherwise write the file from the §2 inline template. Fill Intent, Requirements (+AC), Tasks. Set frontmatter `slug`, `title`, `status: draft`, `created`, and `ideaUuid` if known. Leave `proposalUuid` blank until §4.
3. Keep it terse. The whole value is fewer tokens than OpenSpec — do not pad.

---

## §4. Sync — one-way push, local → Chorus

The local file is the **source of truth**; Chorus is a downstream mirror. Sync is **push-only** (no reverse pull in v1) and uses the **existing** document tools with the byte-exact `--arg-file` transport — the same mechanism `openspec-aware` §3.6 uses. `type: "spec"` is a pre-existing `Document.type`; **no schema change**.

**Deterministic link (do this so develop can find the file later).** When you create the proposal container:

1. Put a single provenance line in the proposal `description`, on its own line, literal prefix, no trailing punctuation — the spec-lite analogue of OpenSpec's slug line:

   ```
   Spec-lite change slug: <slug>
   ```

2. **Write `proposalUuid` into the file's frontmatter BEFORE the first mirror**, so the mirrored bytes already carry it and local == mirror from the very first push. (Backfilling *after* the mirror leaves the local source-of-truth and the fresh Chorus copy inconsistent — don't.)

**Submit-time mirror (the auto-sync trigger).** Then mirror the file into a Chorus `spec` document draft — one call, content filled from the file's bytes (never re-typed):

```bash
chorus mcp call chorus_pm_add_document_draft \
  "{\"proposalUuid\":\"$PROPOSAL_UUID\",\"type\":\"spec\",\"title\":\"Spec: $TITLE\"}" \
  --arg-file content=".chorus/specs/$SLUG.md"
```

Guard every mirror call with the `chorus_check_response` halt-on-error helper from `openspec-aware` §6 (three signals: exit code, `"error":` in body, empty body) — no silent errors.

**Later edits.** Before approval, propagate local edits with `chorus_pm_update_document_draft` (same `--arg-file`); after approval, with `chorus_pm_update_document` against the materialized Document UUID.

**Locating the right file/document (develop-time).** Do NOT match by `title`+`type` alone — not unique across changes. Resolve deterministically:

- From a proposal → its spec file: grep the proposal `description` for `^Spec-lite change slug: `, then open `.chorus/specs/<slug>.md`.
- From a spec file → its Chorus document: prefer the frontmatter `documentUuid` when present (backfill it into frontmatter the first time you learn it — i.e. after the proposal is approved and the draft materializes). Absent that, use the frontmatter `proposalUuid`: among that proposal's `type: "spec"` documents there is exactly one — if zero or many match, **halt** and surface it rather than guessing.

**Task state authority.** The `## Tasks` checkboxes are a **local authoring view**. Once the proposal is approved, tasks materialize as real Chorus Tasks and **Chorus is authoritative for execution state** (claim / verify / done); the one-way push does not sync Chorus task status back into the file. Tick the file boxes as a convenience if you like, but don't treat them as the source of truth for task progress.

---

## §5. Develop-time: Changelog / 留痕 (single-writer)

The `## Changelog` section is the local audit trail (留痕). As work proceeds:

- Append a timestamped line on each meaningful state change (created, tasks started, status → active/done):
  `- 2026-09-08T04:10:00Z — T1 done; status → active`
- Tick the `- [ ]` task/AC checkboxes as they complete.
- After editing, re-mirror the file to Chorus (§4) so the platform view stays current.

**Single-writer rule (concurrency).** The spec file is one shared file; parallel task workers all editing + re-mirroring it race (git conflicts, last-write-wins). So: **only the orchestrator / main agent updates the spec file and re-mirrors** — parallel workers report progress via `chorus_report_work` and do NOT touch the spec. If a non-orchestrator must update it, **re-read the file immediately before editing and detect conflicts** rather than blind-writing.

**Git is the authoritative history**, not the Changelog. `git log --follow .chorus/specs/$SLUG.md` is the exact, tamper-evident record; the `## Changelog` is a lightweight human-readable summary (an agent-written timestamp may be approximate — that's fine, git holds the real times). Keep Changelog entries minimal. Because the file is plain git-tracked markdown, it and its history remain readable offline, with or without a Chorus connection.

When the change is delivered, set frontmatter `status: done` and append a final Changelog line.

---

## §6. What spec-lite does NOT add

- **No** new CLI command (no `chorus spec ...`).
- **No** new MCP tool — sync uses only `chorus_pm_add_document_draft` / `chorus_pm_update_document(_draft)`.
- **No** backend service, no sync daemon, no `prisma/schema.prisma` change.
- **No** change to the OpenSpec path — spec-lite is additive and opt-in; when OpenSpec is active and `CHORUS_SPEC_MODE` is unset, openspec-aware runs unchanged.

---

## §7. Quick checklist

1. Resolve mode (§1) to one value. If not `lite`, no-op.
2. Pick `$SLUG`; create `.chorus/specs/$SLUG.md` (copy TEMPLATE, else inline template); fill Intent / Requirements+AC / Tasks (§2–§3).
3. Create the proposal with a `Spec-lite change slug: <slug>` line; write `proposalUuid` into frontmatter → then mirror to a `spec` document draft via `--arg-file` (§4).
4. During develop → orchestrator appends timestamped `## Changelog` entries, ticks checkboxes, re-mirrors; locate the file/doc by slug line + frontmatter `proposalUuid` (§4–§5).
5. On delivery → `status: done` + final Changelog line.
