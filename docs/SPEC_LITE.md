# spec-lite — Lightweight Local Spec Management

spec-lite is a low-ceremony, git-tracked, **Chorus-native** way to keep specs. A `<slug>/` under
`.chorus/specs/` is a **capability/feature** (not a single change). It holds one **durable local spec**
`<slug>/spec.md` — the cumulative, human-readable "current truth", **edited in place** and **never
synced** to Chorus — plus one **dated folder per change effort** `<slug>/<YYYY-MM-DD>-<change-slug>/`
of Chorus-typed docs (`prd.md`, …) that **are** mirrored 1:1 into **persistent** Chorus Documents. This
mirrors **superpowers** (a lasting spec plus dated per-effort artifacts) and gives a durable,
human-readable record of *intent + requirements* without OpenSpec's four-file, strictly-validated
ceremony. It is the **lightweight fallback** that takes over whenever OpenSpec isn't in use; the
heavier `openspec-aware` path stays the default whenever it is usable.

## Mode selection (OpenSpec-first when usable, lite fallback)

`CHORUS_SPEC_MODE` resolves to exactly one mode; the SessionStart `## Spec Mode` section states it:

1. Explicit `CHORUS_SPEC_MODE` wins: `=lite` → spec-lite; `=openspec` → OpenSpec; `=off` → free-form (no spec artifact).
2. **Unset → OpenSpec when it is usable** (`openspec/` dir + CLI on PATH, not disabled); otherwise → **lite**. OpenSpec stays the default when present; lite is the fallback.
3. Legacy `CHORUS_OPENSPEC_MODE=off` (or the Enable-OpenSpec toggle off) forces *not*-openspec — so an unset `CHORUS_SPEC_MODE` then resolves to lite.

| `CHORUS_SPEC_MODE` | OpenSpec usable? | Resolved mode |
|---|---|---|
| `lite` | any | **lite** |
| `openspec` | yes | **openspec** |
| `openspec` | no | **halt** (fail fast — see below) |
| `off` | any | **free-form** |
| unset | yes | **openspec** (default) |
| unset | no | **lite** (fallback) |

**Fail fast on an unsatisfiable explicit request.** `CHORUS_SPEC_MODE=openspec` when OpenSpec isn't
usable must **halt**, never silently fall back: if OpenSpec is **not installed** (no `openspec/` dir or
no CLI) surface the install hint (`npm i -g @fission-ai/openspec` / `openspec init`); if it is
**explicitly disabled** (`CHORUS_OPENSPEC_MODE=off` or the Enable-OpenSpec toggle) report a config
conflict (`CHORUS_SPEC_MODE=openspec` vs OpenSpec disabled). The stage skill (proposal/yolo) enforces
this after resolving, before branching. This logic lives in `bin/resolve-spec-mode.sh` (pure, Bash 3.2).

## The durable local spec — `<slug>/spec.md`

`.chorus/specs/<slug>/spec.md` — `<slug>` (kebab-case) names a **capability/feature, not one change**.
It is the single, cumulative, human-readable "current truth" of the capability, **edited in place** by
every change. It carries **minimal frontmatter only** (`slug`, `title`, `status`, `created`) — **no
Chorus ids** — followed by plain prose: `## Intent`, `## Requirements` (plain prose with `- [ ]`
acceptance points — no `SHALL`/scenario grammar), and `## Non-goals`. Copy
`.chorus/specs/TEMPLATE/spec.md` to start.

`spec.md` is **never synced to Chorus** and **never enters the mirror loop** — its git history is the
whole record. There is **no `tasks.md`** (Chorus Tasks own execution state) and **no changelog
section** (git history + the change docs' Document versions are the record).

## Per-change dated folders — `<slug>/<YYYY-MM-DD>-<change-slug>/`

Each modification effort is **one dated folder directly under `<slug>/`** — e.g.
`.chorus/specs/<slug>/2026-09-08-add-export/` — with **no `changes/` wrapper**. The date prefix +
change slug lets many efforts (even same-day) coexist and sort by date. The current change's folder is
edited and re-mirrored until it delivers; only previously-delivered folders are left frozen. Inside it,
plain markdown named by **Chorus `Document.type`**:

| File | `Document.type` | Required? |
|---|---|---|
| `prd.md` | `prd` | **yes** — the primary per-change doc |
| `tech_design.md` | `tech_design` | optional — the "how" |
| `adr.md` / `guide.md` / `spec.md` | `adr` / `guide` / `spec` | optional |

Each dated-folder doc carries frontmatter with the **sync ids** — `proposalUuid`, `documentUuid` (the
Document type is implied by the filename) — plus a `spec: ../spec.md` pointer back to the durable spec.
Copy `.chorus/specs/TEMPLATE/YYYY-MM-DD-change/prd.md`.

> **Naming caution — two files named `spec.md`, different roles.** The **durable** `<slug>/spec.md` is
> local only and carries no ids. A per-change `spec`-type doc, if you author one, lives at
> `<slug>/<date>-<slug>/spec.md` — synced, carries ids. The path (and mode) tells them apart; the
> filename alone does not. Prefer `prd.md` as the per-change primary doc to avoid the confusion.

**Flow for a change:** create the dated folder and write its synced change docs (`prd.md`, optionally
`tech_design.md`), update the durable `<slug>/spec.md` in place to the new truth, then mirror the
dated-folder docs you touched. The proposal `description` carries one locator line —
`Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` — so develop finds this effort's change
folder. `spec.md` is never referenced by the mirror.

## Mirror only the dated-folder docs to Chorus

The local folder is the **source of truth**; Chorus is a one-way downstream mirror (no reverse pull),
and **only the dated-folder Chorus-typed docs mirror — `<slug>/spec.md` never does.** Each dated-folder
`<type>.md` maps to **one persistent** Chorus Document of that `type`, using the existing `--arg-file
content=<file>` transport — content streamed from the file's bytes, never re-typed by the agent:

- **First time** a doc is authored (its dated folder is new): `chorus_pm_add_document_draft … --arg-file
  content=<file>` under the introducing proposal (edit the draft with `chorus_pm_update_document_draft`
  before approval). On approval it materializes into a persistent Document; record its `documentUuid` in
  the file's frontmatter and re-mirror once.
- **Later edits:** `chorus_pm_update_document … --arg-file content=<file>` against that `documentUuid`.
  Each update **auto-increments the Document version** — the version history is the change doc's record
  in Chorus, parallel to the local git history.

`prd`, `tech_design`, `adr`, `spec`, `guide` are all pre-existing `Document.type` values, so spec-lite
adds **no new MCP tool, CLI, backend, or schema**. Every mirror is guarded by the `chorus_check_response`
halt-on-error helper (openspec-aware §6); when `chorus` isn't on `PATH`, fall back to `chorus-api.sh` +
`json_encode_file` (openspec-aware §3.6). Each `<type>.md` resolves to the **one** Document of that
`type` by `documentUuid` / `(proposalUuid, type)`; a lookup that finds zero or more than one MUST
**halt**, never match by title alone.

## Local audit trail (留痕)

Because each spec is plain git-tracked markdown, its full history is `git log --
.chorus/specs/<slug>/` (the whole capability — the durable `spec.md`'s in-place diffs + each dated
folder's change docs; use `git log --follow -- <file>` to trace a single renamed file) — readable and
diffable offline, with or without a Chorus connection. The mirrored dated-folder Documents'
auto-incremented versions are the parallel record in Chorus. **There is no separate changelog file to
maintain.** Only `.chorus/specs/` is version-controlled — the rest of `.chorus/` (plugin runtime state)
stays gitignored via `.chorus/*` + `!.chorus/specs/`.

**Single-writer under parallel tasks.** The folder is shared, so in a multi-task wave only the
orchestrator / main agent edits + re-mirrors; parallel workers report via `chorus_report_work` and don't
touch the specs. A non-orchestrator that must write re-reads immediately before editing to detect conflicts.

## Why it saves tokens and time

- **Fewer files, terser format, Chorus-native names.** A durable `spec.md` plus a per-change `prd.md`
  (+ optional `tech_design.md`) instead of OpenSpec's four files means far less to read and write. This
  echoes **AWS AI-DLC** (`awslabs/aidlc-workflows`), whose `aidlc-docs/` is a handful of plain-markdown
  files; its RFC #105 makes the sharper point that the real token lever is *lean, deferred loading* —
  spec-lite keeps the skill small and loads it only when the mode resolves to `lite`.
- **No subprocess, no strict validation.** Dropping the OpenSpec CLI round-trips and the
  `SHALL`/scenario grammar removes both wall-clock and cognitive overhead. **superpowers**
  (`obra/superpowers`) similarly keeps a durable spec plus dated per-effort artifacts as plain
  git-committed markdown, no validator — the shape spec-lite adopts.
- **Byte-exact mirror, and only where it earns its keep.** `--arg-file` streams a change doc into the
  document's `content` without the agent re-emitting it, saving the ~20k+ tokens a re-typed markdown body
  would cost per proposal — and the durable `spec.md` skips the round-trip entirely.

## Not in v1 (follow-ups)

Bidirectional (Chorus → local) pull; and propagating the skill beyond the Claude Code plugin to the
other plugin surfaces (Codex/Kiro/OpenClaw/Pi/dsh).
