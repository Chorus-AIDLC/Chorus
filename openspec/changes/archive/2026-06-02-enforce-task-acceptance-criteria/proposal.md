# Enforce Non-Empty Acceptance Criteria on Tasks and Task Drafts

## Why

Acceptance criteria (AC) are the contract a task is verified against. Today the
four MCP tools that create or edit tasks and task drafts all treat
`acceptanceCriteriaItems` as **optional**:

- `chorus_pm_add_task_draft` — Zod `.optional()`, no service-layer guard.
- `chorus_pm_update_task_draft` — Zod `.optional()`, no guard.
- `chorus_create_tasks` — Zod `.optional()`; empty/blank items are **silently
  dropped** (`filter(d => d.description.trim().length > 0)`), so a task can be
  created with zero AC and no warning.
- `chorus_update_task` — has **no AC parameter at all**.

The only enforcement is `chorus_pm_validate_proposal`'s `E-AC` check, which fires
late (at submit time) and only for proposal drafts — Quick Tasks created via
`chorus_create_tasks` bypass it entirely. The result: tasks reach developers with
no verifiable definition of done, and the downstream task-reviewer / admin-verify
steps have nothing concrete to check against.

## What Changes

Make a non-empty AC set an **invariant** of every task and task draft, enforced at
creation and preserved on edit:

- **Create tools** (`chorus_pm_add_task_draft`, `chorus_create_tasks`) MUST reject
  a request whose acceptance criteria are missing or contain no item with a
  non-blank `description`. The error is explicit, not a silent drop.
- **Edit tools** (`chorus_pm_update_task_draft`, `chorus_update_task`) follow
  partial-update semantics: if the caller passes `acceptanceCriteriaItems`, it
  MUST be non-empty (the field cannot be used to clear AC); if the caller omits
  it, existing AC are preserved untouched. This keeps developer status transitions
  (`in_progress` / `to_verify`) and dependency edits — the dominant use of
  `chorus_update_task` — working without forcing AC to be re-sent.
- `chorus_update_task` gains a new **optional** `acceptanceCriteriaItems`
  parameter with replace semantics (passing it replaces the task's AC rows with
  the new non-empty set; omitting it leaves them alone).
- "Empty" is judged after trimming: an array whose every `description` is blank is
  treated as empty AC and rejected.
- The existing `E-AC` proposal-validation check is **retained** as a submit-time
  backstop for legacy/hand-edited drafts; the new early checks are complementary.
- Validation lives in the **service layer** (single source of truth) via a shared
  helper, so both MCP and any future REST callers inherit it. Zod keeps only
  structural validation (no `.min(1)`, which would break the edit tools' partial
  semantics).
- Documentation (`docs/MCP_TOOLS.md`, `public/skill/`,
  `public/chorus-plugin/skills/chorus/`, tool/param descriptions) is updated to
  describe AC as required.

## Capabilities

- `mcp-tool-surface` — adds requirements that the task create/edit MCP tools
  enforce a non-empty acceptance-criteria invariant.

## Impact

- **Code**: `src/lib/acceptance-criteria.ts` (new shared helper),
  `src/services/proposal.service.ts` (add/update task draft),
  `src/mcp/tools/public.ts` (`chorus_create_tasks`, `chorus_update_task`),
  `src/mcp/tools/pm.ts` (descriptions).
- **Tests**: new unit tests for the helper and the four enforcement paths;
  existing AC tests updated to the new reject-on-empty behavior.
- **Docs**: `docs/MCP_TOOLS.md`, skill docs in both skill trees.
- **Behavioral / backward-compat**: callers that previously created tasks or
  drafts with no AC now receive an error. This is the intended tightening. No DB
  schema change; no migration. Existing tasks with empty AC are unaffected until
  next edited (and edits that omit AC still preserve their current state).
