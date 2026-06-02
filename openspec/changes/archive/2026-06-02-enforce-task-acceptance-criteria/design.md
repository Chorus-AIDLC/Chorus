# Design: Enforce Non-Empty Acceptance Criteria

## Context

Four MCP tools touch acceptance criteria; they sit at two layers and persist AC
two different ways:

| Tool | File | AC persistence today |
|------|------|----------------------|
| `chorus_pm_add_task_draft` | `src/mcp/tools/pm.ts` → `proposalService.addTaskDraft` | `acceptanceCriteriaItems` in the `Proposal.taskDrafts` JSON column |
| `chorus_pm_update_task_draft` | `src/mcp/tools/pm.ts` → `proposalService.updateTaskDraft` | same JSON column (merge into existing draft) |
| `chorus_create_tasks` | `src/mcp/tools/public.ts` (inline) | `prisma.acceptanceCriterion.createMany` — rows in `AcceptanceCriterion` |
| `chorus_update_task` | `src/mcp/tools/public.ts` (inline) | **no AC handling today** |

Real-task AC rows are created in the **tool handler** (`public.ts`), not inside
`taskService.createTask` (which only carries the legacy `acceptanceCriteria`
string). So the shared validator must be importable by both the proposal service
and the `public.ts` handlers.

## Goals / Non-Goals

**Goals**
- Guarantee the invariant: every task and task draft always has ≥1 AC whose
  trimmed `description` is non-blank.
- Fail fast at create/edit time with a clear, consistent error message.
- Do not break `chorus_update_task`'s primary uses (status transitions,
  dependency edits) — AC stays optional there.
- Single source of truth for the "non-empty AC" rule.

**Non-Goals**
- No Prisma schema / migration change.
- No backfill of existing AC-less tasks (DML in migrations is forbidden; and
  retroactively inventing AC would be wrong). They are simply left alone.
- No change to the `required` per-item boolean semantics (still defaults true).
- No removal of the legacy `acceptanceCriteria` Markdown string field.

## Decisions

### D1 — Invariant model, not strict model

Create tools require non-empty AC. Edit tools require non-empty **only if AC is
provided**; omission preserves existing AC. Rationale: `chorus_update_task` is
called on nearly every status change; a strict "AC required on every call" model
would block `in_progress` / `to_verify` transitions and dependency edits. The
invariant model still guarantees no task can ever reach a zero-AC state through
these tools (it could only get there by being created without AC, which create
now forbids).

### D2 — Service layer is the single source of truth

A shared helper module `src/lib/acceptance-criteria.ts` exports:

```ts
export interface AcceptanceCriteriaItemInput {
  description: string;
  required?: boolean;
}

/** Items whose trimmed description is non-blank, trimmed, in order. */
export function normalizeAcceptanceCriteria(
  items: AcceptanceCriteriaItemInput[] | undefined | null,
): { description: string; required: boolean }[];

/** True iff at least one item has a non-blank trimmed description. */
export function hasNonEmptyAcceptanceCriteria(
  items: AcceptanceCriteriaItemInput[] | undefined | null,
): boolean;

export const ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE =
  "At least one acceptance criterion with a non-empty description is required.";
```

`proposalService.addTaskDraft` / `updateTaskDraft` and the `public.ts` handlers
for `chorus_create_tasks` / `chorus_update_task` call these. Throwing happens in
the service functions for the proposal path (so REST inherits it); for the
`public.ts` inline handlers the check is performed inline and returns an
`isError` MCP response (matching the existing handler style there). Zod schemas
keep `.optional()` on the field — structural only, no `.min(1)`.

### D3 — Enforcement matrix

| Tool | AC missing/omitted | AC present but all-blank | AC present non-empty |
|------|--------------------|--------------------------|----------------------|
| `chorus_pm_add_task_draft` | **error** | **error** | persist normalized |
| `chorus_create_tasks` | **error** (per task) | **error** (per task) | persist normalized rows |
| `chorus_pm_update_task_draft` | preserve existing | **error** | replace with normalized |
| `chorus_update_task` | preserve existing | **error** | replace rows (delete + recreate) |

### D4 — `chorus_update_task` AC replace semantics

New optional `acceptanceCriteriaItems`. When provided and non-empty, replace the
task's AC rows: delete existing `AcceptanceCriterion` rows for the task, then
`createMany` the normalized set with `sortOrder` by index and `required ?? true`.
This mirrors `updateTaskDraft`'s "replaces existing items" semantics. Done
outside the status-transition block so the two concerns stay independent. Note:
replacing AC discards any prior dev/admin verification marks on those rows — this
is acceptable because editing the definition of done invalidates prior checks.

### D5 — `chorus_create_tasks` is all-or-nothing per request

Because tasks are created first (via `Promise.all`) and AC added afterward,
validate **all** tasks' AC up front and return an error before creating any task
if any task fails the check. This avoids leaving half-created tasks when one task
in the batch lacks AC. (Pre-validate loop over `tasks` before the
`taskService.createTask` calls.)

### D6 — Retain `E-AC` proposal validation

`chorus_pm_validate_proposal`'s `E-AC` error stays as a submit-time backstop for
drafts created before this change or hand-edited via other paths. The early
checks and `E-AC` are complementary, not redundant — they cover different entry
points and different times.

**Two "empty" definitions coexist (intentionally).** The existing `E-AC` check
(`proposal.service.ts`) considers a draft empty only when
`acceptanceCriteriaItems` is absent or `length === 0` — it does **not** inspect
whether descriptions are blank. The new create/edit checks use the stricter
`hasNonEmptyAcceptanceCriteria`, which treats an array of all-whitespace
descriptions as empty. Consequence: a hypothetical 1-item all-whitespace draft
would pass the `E-AC` backstop but be rejected by the new create path. This is
harmless because the two operate at different entry points (submit-time vs
create-time) and the strict check is the one that runs first on every create.
We deliberately do **not** tighten `E-AC` to the trim rule in this change to keep
the backstop's behavior stable for already-stored drafts; the discrepancy is
documented here and in `docs/MCP_TOOLS.md` so a future reader is not surprised.

### D7 — Edit-tool handlers must distinguish "omitted" from "empty array"

Partial-update semantics (D1, D3) hinge on the MCP handler forwarding an explicit
`acceptanceCriteriaItems: []` to the service guard rather than silently dropping
it. The existing `pm.ts` `update_task_draft` handler builds its `updates` object
with `if (acceptanceCriteriaItems !== undefined) updates.acceptanceCriteriaItems = …`,
which correctly forwards `[]` (an empty array is `!== undefined`). The same guard
shape is required for `chorus_update_task`. Tests MUST assert the clear-rejection
path is reachable through the handler — i.e. passing `[]` reaches the guard and
errors, it is not collapsed into "omitted / preserve existing".

## Risks

- **Existing callers break.** Any automation creating AC-less tasks now errors.
  Intended; surfaced in proposal Impact and the CHANGELOG.
- **Replace-discards-verification on `update_task`.** Mitigated by D4 rationale —
  changing AC text already invalidates prior verification. Documented in the tool
  description.

## Migration Plan

None. No schema change, no data migration. Behavior change only.
