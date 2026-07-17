# Design — Slim MCP tool descriptions + enum params

## Context

MCP tools are registered in `src/mcp/tools/*.ts` via `server.registerTool(name, { description, inputSchema }, handler)` and `registerPermissionedTool(...)`. The `description` string and the zod `inputSchema` (including every param's `.describe()`) are serialized into `tools/list` and re-sent every turn. This change touches only `public.ts` and `pm.ts`, and only the `description` strings + the zod definitions of 6 filter/type params — no handler or service code changes.

## Decision 1 — Enum value domains (strict)

Per elaboration answer `strict`: enums list only the **real current stored values**, verified from Prisma schema + service writes, not the (partly stale) describe-strings.

| Tool.param | File:line | New `z.enum([...])` domain | Rationale / ground truth |
|---|---|---|---|
| `get_ideas.status` | public.ts:97 | `open, elaborating, elaborated` | `Idea.status` is a 3-state model (`prisma/schema.prisma:187`); `proposal_created/completed/closed` are legacy values normalized **on read only** (`normalizeIdeaStatus`) and never a valid filter target. |
| `list_tasks.status` | public.ts:247 | `open, assigned, in_progress, to_verify, done, closed` | Matches `Task.status` comment (schema:244) and all service writes. |
| `list_tasks.priority` | public.ts:248 | `low, medium, high` | Matches `Task.priority` (schema:245); already an enum on the write paths. |
| `get_documents.type` | public.ts:131 | `prd, tech_design, adr, spec, guide, report` | Filter domain; `report` **is** a valid document type (written 29× in src). |
| `get_proposals.status` | public.ts:185 | `draft, pending, approved, closed` | Proposal statuses actually written: `draft/pending/approved/closed`. **`rejected` and `revised` are never written** — `rejectProposal` sets status back to `draft`. Drop them. |
| `add_document_draft.type` | pm.ts:508 | `prd, tech_design, adr, spec, guide, report` | Draft type currently a free string listing 6 values; keep all 6 (drafts can be `report`). NOTE: distinct from `pm_create_document`'s 5-value enum (no `report`) — do not "align" them; the domains legitimately differ. |
| `update_document_draft.type` | pm.ts:587 | `prd, tech_design, adr, spec, guide, report` (optional) | Currently `z.string().optional()` with no advertised list; give it the same 6-value domain as add, kept `.optional()`. |

**Filter params stay `.optional()`** — adding `z.enum` narrows the *value* domain but must not make a previously-optional filter required. `update_document_draft.type` also stays `.optional()`.

### Backward-compat check

Filter params flow straight into a Prisma `where` clause (`ideaService.listIdeas`, `taskService.listTasks`, etc.) as `...(status && { status })`. Tightening to an enum means an out-of-domain value is rejected at the zod layer (a clear validation error) instead of silently returning zero rows. Verified no first-party skill/daemon passes the dropped values (`proposal_created`, `completed`, `rejected`, `revised`) as filter arguments.

## Decision 2 — Description compression + behavior-rule placement

Per elaboration answer (custom "2+3"): **global red-line one-liner in the description; parameter-bound red-lines into that param's `.describe()`; the rest into skill docs.**

Rewrite principle for each of the 7: the description answers only "**what is this / when do I pick it**" in ≤ 2 sentences. Everything else relocates:
- A behavior red-line that applies to the **whole call** → keep as **one** short clause in the description (survives for headless/no-skill agents).
- A red-line **bound to a specific parameter** → into that parameter's `.describe()`.
- Multi-step usage procedure, state-machine preconditions, section-by-section field contracts → skill docs (`public/skill/`, `public/chorus-plugin/skills/chorus/`) + `docs/MCP_TOOLS.md`.

Per-tool relocation plan:

| Tool | Global red-line kept in desc | Moved to param `.describe()` | Moved to skill docs |
|---|---|---|---|
| `chorus_pm_start_elaboration` | "Record decisions even when discussed outside the tool." | "Do NOT add an 'Other' option — the UI adds it" → `questions[].options`; "present via an interactive prompt, not plain text" → `questions` | full elaboration-loop procedure (already in idea skill) |
| `chorus_create_report` | "Write once every task in the proposal is complete." | 3-section `## Summary / ## Decisions / ## Follow-ups` contract → `content.describe()`; `force` overwrite semantics → `force.describe()` | report authoring guidance |
| `chorus_create_tasks` | "Acceptance criteria are required on every task." | two-mode (Quick vs Proposal) note → `proposalUuid.describe()`; AC requirement → `acceptanceCriteriaItems.describe()` | full flow steps |
| `chorus_update_task` | (multi-purpose: one-sentence "edit fields / deps / status") | status transition rule → `status.describe()`; incremental dep note → `addDependsOn/removeDependsOn.describe()` | quick-task flow |
| `chorus_get_proposal` | (already mostly what/when — trim to 1–2 sentences) | per-`section` view meanings → `section.describe()` | — |
| `chorus_pm_assign_task` | precondition "task must be open/assigned" | instance-pin `instanceUuid` semantics → `instanceUuid.describe()` | — |
| `chorus_add_reference` | (one sentence: attach external evidence to idea/proposal/task) | `type` domain meanings → `type.describe()`; "attach at creation via references[] instead" → tool desc one-liner | reference guidance (already in idea skill §4.4) |

`chorus_get_proposal.section` is already a `z.enum` (basic/documents/tasks/full) with a spec requirement — leave the enum, only trim the top-level description prose.

## Decision 3 — Test strategy

Vitest suite under `src/mcp/__tests__/`. Add/extend tests that:
1. For each converted param, assert the built `inputSchema` **rejects** an out-of-domain value (e.g. `get_proposals.status = "revised"`) and **accepts** each valid value. Prefer asserting on the zod schema shape directly (parse a sample), independent of a live DB.
2. Assert each of the 7 descriptions is ≤ a sentence bound (e.g. ≤ 2 sentences / ≤ ~240 chars) — a guard so the slimming does not silently regress.
3. Existing server registration/permission tests still pass unchanged (no tool added/removed, no permission change).

## Decision 4 — Token delta (record only)

After the edits, capture the `tools/list` serialized size (or the sum of description + schema char length for the 7 tools) before/after and record the delta in the completion report. No threshold gates acceptance (elaboration `struct_plus_record`).

## Risks

- **Over-trimming loses a load-bearing rule** for headless agents. Mitigation: the "global red-line in desc" rule preserves exactly the rules that must survive without skill context; a description-length test guards the floor but review confirms nothing essential was dropped.
- **Enum too strict rejects a legitimate historical query.** Mitigation: domains verified against schema + service writes; dropped values are provably non-writable or read-only-normalized.
- **`create_report` overlap with P0.** Mitigation: P1 only compresses the description in place; if P0 later folds/deletes the tool, that is a clean superset change (accepted per elaboration).
