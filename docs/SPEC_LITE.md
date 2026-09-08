# spec-lite — Lightweight Local Spec Management

spec-lite is a low-ceremony, git-tracked way to keep a spec for a change: **one markdown file per change** at `.chorus/specs/<slug>.md`, mirrored one-way into Chorus. It is an **opt-in alternative** to the heavier OpenSpec path (`openspec-aware`), meant for the common case where you want a durable, human-readable record of *intent + requirements + tasks* without the four-file, strictly-validated OpenSpec ceremony.

## When to use lite vs OpenSpec

| | spec-lite | OpenSpec (`openspec-aware`) |
|---|---|---|
| Files per change | 1 (`.chorus/specs/<slug>.md`) | 4 (`proposal.md`, `design.md`, `tasks.md`, `specs/<cap>/spec.md`) |
| Validation | none (plain markdown) | strict `SHALL`/`MUST` + `#### Scenario:` grammar |
| Tooling | none — reuses existing Chorus doc tools | external `openspec` CLI subprocess |
| Best for | most changes; fast, low-token specs | large, spec-heavy work needing formal delta specs + archive-to-cumulative-spec |

Both **coexist**. The active mode is resolved deterministically:

1. `CHORUS_SPEC_MODE=lite` → spec-lite; `=openspec` → OpenSpec; `=off` → free-form (no spec artifact).
2. Else, if OpenSpec is active (`openspec/` dir + `openspec` CLI present) → OpenSpec (the unchanged default).
3. Else, if a `.chorus/specs/` directory exists → spec-lite.
4. Else → free-form, exactly as before either mode existed.

Existing OpenSpec projects are unaffected — spec-lite never overrides OpenSpec silently.

## The file format

YAML frontmatter (`slug`, `title`, `status`, `created`, optional `ideaUuid`/`proposalUuid`) followed by four sections: **Intent** (1–2 lines), **Requirements** (plain prose, each with `- [ ]` acceptance-criterion items), **Tasks** (`- [ ]` checkboxes, dependencies inline), and **Changelog** (append-only, ISO-8601 timestamps). A `## Design` section may be added inline when a change warrants it. Copy `.chorus/specs/TEMPLATE.md` to start.

## One-way sync to Chorus

The local file is the **source of truth**; Chorus is a downstream mirror. Sync is **push-only** — there is no reverse pull in v1. At proposal submit (and on later edits), the file is mirrored into a Chorus `spec` document using the existing `chorus_pm_add_document_draft … --arg-file content=<file>` transport — byte-exact, with the document content streamed from the file's bytes (never re-typed by the agent). `spec` is a pre-existing document type; spec-lite adds **no new MCP tool, no CLI command, no backend, and no schema change**.

## Local audit trail (留痕)

Because each spec is plain git-tracked markdown, its full history is `git log --follow .chorus/specs/<slug>.md` — readable and diffable offline, with or without a Chorus connection. The `## Changelog` section is a human-facing, timestamped log appended as the change progresses (created → tasks done → status changes). No separate audit file is needed.

Only `.chorus/specs/` is version-controlled; the rest of `.chorus/` (plugin runtime state) stays gitignored via `.chorus/*` + `!.chorus/specs/`.

## Why it saves tokens and time

The savings are twofold, mirroring lessons from prior lightweight spec systems:

- **Fewer files, terser format.** One file instead of four means far less content to read and write per change. This echoes **AWS AI-DLC** (`awslabs/aidlc-workflows`), whose `aidlc-docs/` is a handful of plain-markdown files; its RFC #105 makes the sharper point that the real token lever is *lean, deferred loading* rather than volume — spec-lite keeps the skill itself small and loads it only when the mode resolves to `lite`.
- **No subprocess, no strict validation.** Dropping the OpenSpec CLI round-trips and the `SHALL`/scenario grammar removes both wall-clock and cognitive overhead. **superpowers** (`obra/superpowers`) similarly keeps its spec + plan as plain git-committed markdown with checkbox tasks and no validator.
- **Byte-exact mirror.** The `--arg-file` transport streams the file into the document's `content` without the agent re-emitting it, saving the ~20k+ tokens a re-typed markdown body would cost per proposal.

## Not in v1 (follow-ups)

Making spec-lite the default; bidirectional (Chorus → local) pull; and propagating the skill beyond the Claude Code plugin to the other plugin surfaces (Codex/Kiro/OpenClaw/Pi/dsh).
