# spec-lite Specification

## Purpose
Define spec-lite: an opt-in, coexisting lightweight local-spec mode for Chorus — one git-tracked `.chorus/specs/<slug>.md` per change (Intent / Requirements+AC / Tasks / Changelog-留痕), local-first, mirrored one-way into Chorus via existing document tools, with no new CLI/MCP/backend/schema and no change to the OpenSpec path.
## Requirements
### Requirement: Single-file lightweight spec format
The spec-lite mode SHALL represent each change as exactly one markdown file at `.chorus/specs/<slug>.md`, where `<slug>` is kebab-case and unique within `.chorus/specs/`. The file MUST contain YAML frontmatter (`slug`, `title`, `status`) and the sections `## Intent`, `## Requirements`, `## Tasks`, and `## Changelog`. Requirements MUST NOT require `SHALL`/`MUST` grammar or scenario blocks, and acceptance criteria MUST be expressed as `- [ ]` checkbox items.

#### Scenario: Authoring a new lightweight spec
- **WHEN** an agent creates a spec-lite change named `add-export-csv`
- **THEN** a single file `.chorus/specs/add-export-csv.md` is written containing frontmatter plus the Intent, Requirements, Tasks, and Changelog sections, and no other spec files are created for that change

#### Scenario: Requirements need no scenario grammar
- **WHEN** a requirement is written in a spec-lite file as plain prose with `- [ ]` acceptance-criterion items
- **THEN** it is accepted as-is with no `SHALL`/`MUST` or `#### Scenario:` validation applied

### Requirement: Deterministic spec-mode selection
The system SHALL select the active spec mode deterministically so that spec-lite and OpenSpec coexist without ambiguity. `CHORUS_SPEC_MODE` MUST take precedence when set (`lite`, `openspec`, or `off`); otherwise an active OpenSpec environment MUST keep OpenSpec as the default; otherwise the presence of a `.chorus/specs/` directory MUST select spec-lite; otherwise the workflow MUST fall back to free-form with no spec artifact. The calling stage skill MUST branch on the resolved mode value, not on the raw `CHORUS_OPENSPEC_ACTIVE` flag. When `CHORUS_SPEC_MODE=openspec` is set but OpenSpec is not usable, the `proposal`/`yolo` resolver MUST fail fast after resolving and before branching — it MUST NOT silently fall back or enter a branch with no OpenSpec to author. The halt message MUST name the cause: a **config conflict** when OpenSpec is explicitly disabled (`CHORUS_OPENSPEC_MODE=off` or the Enable-OpenSpec toggle), or an **install hint** when OpenSpec is simply not installed (no `openspec/` dir or CLI).

#### Scenario: OpenSpec project is unaffected
- **WHEN** a project has OpenSpec active and `CHORUS_SPEC_MODE` is unset
- **THEN** the workflow uses the existing OpenSpec path unchanged and does not create `.chorus/specs/`

#### Scenario: Explicit opt-in to spec-lite
- **WHEN** `CHORUS_SPEC_MODE=lite` is set
- **THEN** the workflow authors a `.chorus/specs/<slug>.md` file and does not scaffold `openspec/changes/`

#### Scenario: Explicit OpenSpec request that cannot be honored fails fast
- **WHEN** `CHORUS_SPEC_MODE=openspec` is set but no `openspec/` directory or `openspec` CLI is available
- **THEN** the workflow halts and surfaces the install hint rather than silently falling back to lite or free-form

### Requirement: One-way push sync to Chorus via existing transport
The spec-lite mode SHALL mirror the local spec file into a Chorus `spec` document using the existing `chorus_pm_add_document_draft` / `chorus_pm_update_document(_draft)` tools with the byte-exact `--arg-file content=<file>` transport. Sync MUST be one-way (local → Chorus); the local file MUST remain the source of truth; and the mechanism MUST NOT introduce any new MCP tool, CLI command, backend service, or database schema.

#### Scenario: Mirror on proposal submit
- **WHEN** a proposal for a spec-lite change is submitted
- **THEN** the local `.chorus/specs/<slug>.md` is mirrored into a Chorus document of type `spec` byte-for-byte via `--arg-file`, with no document content re-typed by the agent

#### Scenario: No new infrastructure introduced
- **WHEN** the spec-lite feature is delivered
- **THEN** no new MCP tool, no new CLI subcommand, and no `prisma/schema.prisma` change are added, and sync uses only pre-existing document tools and document types

### Requirement: spec-lite is woven into the stage skills
The spec-lite mode SHALL be reachable as a shared sub-procedure from the proposal, develop, and yolo skills via the deterministic mode-selection order. Each of those skills MUST carry a spec-mode branch that, when the mode resolves to `lite`, routes authoring to `.chorus/specs/<slug>.md` and fires the submit-time mirror — without altering the existing OpenSpec authoring steps or its default precedence.

#### Scenario: Lite session flows end-to-end
- **WHEN** a session has `CHORUS_SPEC_MODE=lite` and runs the proposal (or yolo) flow
- **THEN** the flow authors a `.chorus/specs/<slug>.md` file and mirrors it to Chorus at proposal submit, rather than scaffolding `openspec/changes/`

#### Scenario: OpenSpec routing is untouched
- **WHEN** the spec-mode branch is added to the proposal/develop/yolo skills
- **THEN** a session with OpenSpec active and no `CHORUS_SPEC_MODE` still follows the unchanged OpenSpec path

### Requirement: spec-lite files are version-controlled
The repository SHALL keep `.chorus/specs/` under version control even though the surrounding `.chorus/` plugin-state directory is gitignored. The ignore rules MUST re-include `.chorus/specs/` while continuing to ignore plugin runtime state (`artifacts/`, `state.json`).

#### Scenario: A spec file is trackable by git
- **WHEN** a `.chorus/specs/<slug>.md` file is created
- **THEN** `git check-ignore` reports it as NOT ignored, while `.chorus/state.json` and `.chorus/artifacts` remain ignored

### Requirement: Local git-tracked audit trail
The spec-lite mode SHALL keep the local spec as plain git-trackable markdown so its full history is available via version control without any Chorus connection. **Git history is the authoritative record** of changes; each spec file SHALL also carry an append-only `## Changelog` section as a lightweight human-readable summary. Changelog timestamps SHALL be machine-generated (e.g. `date -u`) rather than hand-written, or omitted in favor of date + event.

#### Scenario: Changelog records a change
- **WHEN** an agent advances a spec-lite change's status
- **THEN** a new entry is appended to the file's `## Changelog` section with a machine-generated timestamp, and the change is captured in git history

#### Scenario: Offline auditability
- **WHEN** there is no connection to Chorus
- **THEN** the spec file and its complete history remain readable and diffable from the local git repository

### Requirement: Deterministic proposal-to-spec-file linkage
The spec-lite mode SHALL provide a deterministic link between a Chorus proposal and its local spec file. The proposal `description` MUST carry a literal `Spec-lite change slug: <slug>` line, and the spec file's frontmatter MUST record `proposalUuid`, written before the first mirror so the local file and its Chorus mirror are byte-consistent from the first push. After the proposal is approved and the draft materializes, the frontmatter SHOULD be backfilled with the materialized `documentUuid`; because that backfill changes the file, the workflow MUST immediately re-mirror it (via `chorus_pm_update_document` using that `documentUuid`) so local and mirror stay consistent. Resolution MUST prefer frontmatter `documentUuid`, else `proposalUuid`; it MUST NOT rely on matching document `title`+`type` (not unique across changes); a lookup that finds zero or multiple candidates MUST halt rather than guess.

#### Scenario: Develop locates the correct spec among many
- **WHEN** the repository contains several `.chorus/specs/*.md` files and a task's proposal `description` contains `Spec-lite change slug: add-export-csv`
- **THEN** the workflow edits `.chorus/specs/add-export-csv.md` (confirmed by its frontmatter `proposalUuid`) and does not touch any other spec file

#### Scenario: Ambiguous linkage halts
- **WHEN** resolving a spec-lite proposal to its `spec` Document yields zero or more than one match
- **THEN** the workflow halts and surfaces the ambiguity instead of updating an arbitrary document

### Requirement: Single-writer spec updates under concurrency
The spec-lite mode SHALL avoid concurrent-write races on the single shared spec file. In a multi-task wave, only the orchestrator / main agent SHALL update the spec file (Changelog, checkboxes, re-mirror); parallel task workers SHALL report progress via `chorus_report_work` and MUST NOT edit or re-mirror the spec. A non-orchestrator that must update it MUST re-read the file immediately before writing to detect conflicts.

#### Scenario: Parallel workers do not clobber the spec
- **WHEN** multiple task workers run in parallel for a spec-lite change
- **THEN** only the orchestrator appends Changelog entries / ticks checkboxes / re-mirrors, and workers report via `chorus_report_work` without editing the spec file

### Requirement: Chorus is authoritative for task execution state
The spec file's `## Tasks` checkboxes SHALL be treated as a local authoring view only. Once a proposal is approved and its tasks materialize as Chorus Tasks, Chorus task status (claim / verify / done) SHALL be authoritative for execution state; the one-way push does not sync Chorus task status back into the file, so the file checkboxes MUST NOT be relied upon as the source of truth for task progress.

#### Scenario: File checkboxes are not the execution source of truth
- **WHEN** a materialized Chorus task is verified done while the spec file's corresponding `- [ ]` box is still unchecked
- **THEN** the task is considered done (Chorus is authoritative) and the stale checkbox does not affect execution state

