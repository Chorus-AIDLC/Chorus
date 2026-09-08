# spec-lite — Lightweight Local Spec Management

spec-lite is a low-ceremony, git-tracked, **Chorus-native** way to keep a spec for a change: one
**folder per change** at `.chorus/specs/<slug>/`, holding plain-markdown docs named by Chorus's own
Document types, each mirrored 1:1 into Chorus — a durable, human-readable record of *intent +
requirements* without OpenSpec's four-file, strictly-validated ceremony. It is the **lightweight
fallback** that takes over whenever OpenSpec isn't in use; the heavier `openspec-aware` path stays
the default whenever it is usable.

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
this after resolving, before branching.

## The change folder

`.chorus/specs/<slug>/` — one folder per change, `<slug>` kebab-case and unique. Inside it, plain
markdown named by **Chorus `Document.type`**:

| File | `Document.type` | Required? |
|---|---|---|
| `prd.md` | `prd` | **yes** — the only required file |
| `tech_design.md` | `tech_design` | optional — the "how" |
| `adr.md` / `spec.md` / `guide.md` | `adr` / `spec` / `guide` | optional |

`prd.md` is a Chorus PRD: YAML frontmatter (`slug`, `title`, `status`, `created`, and optional
`ideaUuid` / `proposalUuid` / `documentUuid` for mirroring) followed by `## Intent` (intent +
background), `## Requirements` (plain prose with `- [ ]` acceptance points — no `SHALL`/scenario
grammar), and `## Non-goals`. Copy `.chorus/specs/TEMPLATE/prd.md` to start. There is **no `tasks.md`**
(Chorus Tasks own execution state) and **no changelog section** (git history is the audit trail).

> Note: a lite `spec.md` (type `spec`) is just plain markdown — the *same* `Document.type=spec` carries
> OpenSpec's delta/`SHALL`/scenario grammar under OpenSpec mode but has no such structure under lite.
> The type alone doesn't tell the two apart; the change's mode (its folder vs an `openspec/` change) does.

## Always mirror to Chorus

The local folder is the **source of truth**; Chorus is a one-way downstream mirror (no reverse pull).
Each `<type>.md` mirrors byte-exact to a Chorus Document of that `type`, using the existing
`chorus_pm_add_document_draft … --arg-file content=<file>` transport — content streamed from the file's
bytes, never re-typed by the agent. `prd`, `tech_design`, `adr`, `spec`, `guide` are all pre-existing
`Document.type` values, so spec-lite adds **no new MCP tool, CLI, backend, or schema**. Post-approval
edits use `chorus_pm_update_document`; every mirror is guarded by the `chorus_check_response`
halt-on-error helper (openspec-aware §6).

**Deterministic link.** The proposal `description` carries one literal `Spec-lite change slug: <slug>`
line so develop can find the folder; `prd.md` frontmatter records `proposalUuid` (written **before**
the first mirror) and, after approval, `documentUuid` (re-mirror after backfilling so local stays
byte-identical to Chorus). With several files per folder, each `<type>.md` maps to the **one**
materialized Document of that `type` under the proposal — resolve by `(proposalUuid, type)`; a lookup
that finds zero or more than one MUST **halt**, never match by title alone.

## Local audit trail (留痕)

Because each spec is plain git-tracked markdown, its full history is `git log --
.chorus/specs/<slug>/` (whole change; use `git log --follow -- <file>` to trace a single renamed
file) — readable and diffable offline, with or without a Chorus connection. **Git
history is the authoritative record**; there is no separate changelog file to maintain. Only
`.chorus/specs/` is version-controlled — the rest of `.chorus/` (plugin runtime state) stays gitignored
via `.chorus/*` + `!.chorus/specs/`.

**Single-writer under parallel tasks.** The folder is shared, so in a multi-task wave only the
orchestrator / main agent edits + re-mirrors; parallel workers report via `chorus_report_work` and don't
touch the specs. A non-orchestrator that must write re-reads immediately before editing to detect conflicts.

## Why it saves tokens and time

- **Fewer files, terser format, Chorus-native names.** A `prd.md` (+ optional `tech_design.md`) instead
  of OpenSpec's four files means far less to read and write. This echoes **AWS AI-DLC**
  (`awslabs/aidlc-workflows`), whose `aidlc-docs/` is a handful of plain-markdown files; its RFC #105
  makes the sharper point that the real token lever is *lean, deferred loading* — spec-lite keeps the
  skill small and loads it only when the mode resolves to `lite`.
- **No subprocess, no strict validation.** Dropping the OpenSpec CLI round-trips and the
  `SHALL`/scenario grammar removes both wall-clock and cognitive overhead. **superpowers**
  (`obra/superpowers`) similarly keeps its spec + plan as plain git-committed markdown, no validator.
- **Byte-exact mirror.** `--arg-file` streams the file into the document's `content` without the agent
  re-emitting it, saving the ~20k+ tokens a re-typed markdown body would cost per proposal.

## Not in v1 (follow-ups)

Bidirectional (Chorus → local) pull; and propagating the skill beyond the Claude Code plugin to the
other plugin surfaces (Codex/Kiro/OpenClaw/Pi/dsh).
