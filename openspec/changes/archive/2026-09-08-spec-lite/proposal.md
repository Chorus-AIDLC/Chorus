# Lightweight Local Spec Management (spec-lite)

## Why

Chorus's current spec-driven path runs through the external **OpenSpec** CLI (the `openspec-aware` skill): every change scaffolds `openspec/changes/<slug>/` with four files (`proposal.md`, `design.md`, `tasks.md`, one `specs/<capability>/spec.md` per capability), each Requirement gated by strict `SHALL`/`MUST` + `#### Scenario:` validation, and authoring shells out to the `openspec` CLI. That ceremony is valuable for large, spec-heavy work but is **heavy** for the common case: many files to read and write, a CLI subprocess dependency, and verbose deltas — all of which cost tokens and wall-clock time.

Many changes just need a durable, human-readable, git-tracked record of *intent + requirements + tasks* that also shows up in Chorus. They do not need a four-file delta-spec with scenario grammar validation.

Precedents that already do exactly this lightweight thing (attached as references on the idea):
- **AWS AI-DLC** (`awslabs/aidlc-workflows`): a small `aidlc-docs/` dir of plain markdown — `aidlc-state.md` (cross-session continuity), `audit.md` (ISO-8601 timestamped log = local 留痕), `execution-plan.md` (approval-gated). Its RFC #105 shows the real token lever is **deferred/lean loading**, not merely fewer files.
- **superpowers** (`obra/superpowers`): git-committed spec + plan markdown with `- [ ]` checkbox tasks, a plan→spec pointer, and a no-placeholders rule — no CLI, no schema validation.

## What Changes

Add a **coexisting, opt-in lightweight mode** — **spec-lite** — alongside (not replacing) the OpenSpec path:

- **One file per change**: `.chorus/specs/<slug>.md`, with YAML frontmatter + four terse sections: **Intent**, **Requirements** (with acceptance criteria), **Tasks** (`- [ ]` checkboxes), **Changelog** (append-only, timestamped — the local 留痕).
- **Local-first**: the markdown file is the durable, git-tracked source of truth; Chorus is the downstream collaboration/observability mirror.
- **One-way push sync**: at lifecycle nodes (proposal submit), mirror the file into a Chorus `spec` document draft using the **existing** `chorus_pm_add_document_draft … --arg-file content=<file>` transport — byte-exact, zero content-tokens, no re-typing.
- **Skill-driven, no new infrastructure**: delivered as a new **`spec-lite` skill** + a convention doc + a template. **No new `chorus spec` CLI, no new MCP tool, no new backend/schema.** Savings come from a single terse file **and** dropping the OpenSpec CLI subprocess + strict `SHALL` validation.
- **Mode selection**: OpenSpec stays the default when active; spec-lite is chosen explicitly (e.g. `CHORUS_SPEC_MODE=lite`) or when a project has no `openspec/` dir but wants a tracked spec. Designed so it can graduate to the default later by flipping one signal.

## Capabilities

- `spec-lite` — the lightweight local-spec format, its mode-selection contract, and its one-way push-to-Chorus sync.

## Impact

- **New files (docs/skill/convention only):** the `spec-lite` skill, a `.chorus/specs/` template + README, and a `docs/` reference page.
- **Two small wiring edits:** `.gitignore` narrowed (`.chorus/*` + `!.chorus/specs/`) so specs are git-tracked while plugin runtime state stays ignored; and a functional "Spec mode" branch added to the proposal/develop/yolo skills (plus a cross-reference in `openspec-aware`) so a `CHORUS_SPEC_MODE=lite` session actually flows through spec-lite end-to-end.
- **No source code, schema, MCP, or CLI changes** — sync reuses the existing `chorus_pm_add_document_draft` tool and the `--arg-file` transport already documented in `openspec-aware` §3.6.
- **No behavior change to the existing OpenSpec path** — spec-lite is additive and opt-in; OpenSpec stays the default when active, and its authoring/detection steps are untouched.
- **Out of scope for v1 (explicit follow-ups):** making spec-lite the default; bidirectional (Chorus→local) pull; propagating the skill to every plugin surface (Codex/Kiro/OpenClaw/Pi/dsh) beyond the primary Claude Code plugin.
