---
name: spec-lite
description: Lightweight, Chorus-native local specs for Chorus PM workflows — a git-tracked folder `.chorus/specs/<slug>/` of plain-markdown docs named by Chorus Document type (prd.md, tech_design.md, …), each mirrored 1:1 into Chorus. The default spec mode; a low-token alternative to the heavier openspec-aware path. Read from proposal / develop / yolo when the spec mode resolves to `lite`.
license: AGPL-3.0
metadata:
  author: chorus
  category: project-management
  mcp_server: chorus
---

# spec-lite — lightweight local spec authoring

A **shared sub-procedure** for the Chorus stage skills (proposal, develop, yolo) and the **default**
spec mode. Instead of OpenSpec's four-file scaffold + `SHALL`/scenario grammar + CLI, a change is
one git-tracked folder of plain-markdown docs, each mirrored 1:1 into Chorus. No new CLI, MCP tool,
backend, or schema — mirroring reuses the existing document tools.

## Mode (how you got here)

`CHORUS_SPEC_MODE` resolves to one of `{lite, openspec, off}`; the SessionStart `## Spec Mode`
section states the active value. **lite is the default when `CHORUS_SPEC_MODE` is unset** — you are
here because the mode resolved to `lite`. `=openspec` → the `openspec-aware` skill instead; `=off` →
free-form, no spec artifact. If the mode is not `lite`, this skill is a no-op — return to the caller.

## The change folder

`.chorus/specs/<slug>/` (`<slug>` kebab-case, from the idea title, unique). Inside it, plain-markdown
docs named by **Chorus Document type**:

| File | `Document.type` | Required? |
|---|---|---|
| `prd.md` | `prd` | **yes** — the only required file |
| `tech_design.md` | `tech_design` | optional — the "how" |
| `adr.md` / `spec.md` / `guide.md` | `adr` / `spec` / `guide` | optional |

`prd.md` = a Chorus PRD: frontmatter (`slug`, `title`, `status: draft\|active\|done`, `created`,
optional `ideaUuid`/`proposalUuid`/`documentUuid`), then `## Intent` (intent + background),
`## Requirements` (plain prose + `- [ ]` acceptance points — no `SHALL`/scenario grammar), and a
`## Non-goals` bullet list. Copy `.chorus/specs/TEMPLATE/prd.md` to start (or write it from the shape
above if the template isn't in the repo). Keep it terse — the whole point is fewer tokens than OpenSpec.

## Author

1. Pick `$SLUG`; ensure `.chorus/specs/$SLUG/` exists (it is git-tracked; `.gitignore` re-includes
   `!.chorus/specs/`). Write `prd.md` (and `tech_design.md` etc. only if the change warrants them).
2. When you create the proposal container, put one literal line in its `description` so develop can
   find the folder later: `Spec-lite change slug: <slug>` (own line, no trailing punctuation).

## Always mirror to Chorus

Every `<type>.md` mirrors **byte-exact** to a Chorus Document of that `type`. Fill `content` from the
file's bytes with `--arg-file` — never re-type the body (that drifts and burns ~20k tokens):

```bash
chorus mcp call chorus_pm_add_document_draft \
  "{\"proposalUuid\":\"$PROPOSAL_UUID\",\"type\":\"prd\",\"title\":\"PRD: $TITLE\"}" \
  --arg-file content=".chorus/specs/$SLUG/prd.md"
```

One call per file (`type` matches the filename). Post-approval, propagate edits with
`chorus_pm_update_document` against the materialized Document UUID (draft edits before approval:
`chorus_pm_update_document_draft`). Guard every mirror with the `chorus_check_response` halt-on-error
helper — copy it from `openspec-aware` §6 (checks exit code, `"error":` in body, empty body); no silent
errors. Record `proposalUuid`/`documentUuid` in `prd.md` frontmatter once known and re-mirror, so local
stays byte-identical to Chorus. (No `chorus` on `PATH`? Fall back to `chorus-api.sh` + `json_encode_file`, `openspec-aware` §3.6.)

## Develop-time: 留痕 via git history

**Git history is the audit trail** — `git log --follow .chorus/specs/$SLUG/`. There is no changelog
section to maintain. As work proceeds, edit the docs, tick `- [ ]` acceptance points, set frontmatter
`status: active` → `done`, and re-mirror each edited file so Chorus stays current.

**Single-writer:** the folder is shared, so in a multi-task wave only the **orchestrator / main agent**
edits + re-mirrors; parallel workers report via `chorus_report_work` only. A non-orchestrator that must
write re-reads immediately before editing to catch conflicts.

**Task state lives in Chorus**, not the file — once the proposal is approved, tasks are real Chorus
Tasks (claim / verify / done). The `- [ ]` points in `prd.md` are acceptance intent, not a task tracker.

## Checklist

1. Confirm mode = `lite` (else no-op).
2. Create `.chorus/specs/$SLUG/prd.md` (+ optional `tech_design.md`, …) from the template.
3. Create the proposal with a `Spec-lite change slug: <slug>` line; mirror each file to a Document of its `type` via `--arg-file`.
4. Develop → edit docs, re-mirror, tick acceptance points; git history is the record.
5. On delivery → frontmatter `status: done`, final re-mirror.
