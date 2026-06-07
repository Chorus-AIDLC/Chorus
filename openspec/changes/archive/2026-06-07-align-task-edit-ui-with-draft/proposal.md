# Align Task Edit UI with Task Draft

## Why

When a Proposal is approved, its Task Drafts materialize into real Tasks. The two
editing surfaces have drifted apart:

- **Task Draft panel** (`task-draft-detail-panel.tsx`) edits acceptance criteria as
  **structured rows** — one `description` input + a `required` toggle per criterion,
  with add / delete controls.
- **Real Task panel** (`task-detail-panel.tsx`) edits acceptance criteria as a single
  **legacy Markdown `<Textarea>`**. The structured `acceptanceCriteriaItems` (which the
  task already carries and which gate verification) are read-only in this form.

So a field that is first-class during proposal authoring becomes uneditable once the
task is real — a PM can no longer add, reword, or re-flag a criterion as required/optional
from the UI, even though the backend already supports it (`replaceAcceptanceCriteria`,
used by the `chorus_update_task` MCP tool). The legacy textarea also does not map to the
structured criteria at all, so editing it is misleading.

Every other field on the task edit form — title, description, priority, storyPoints — is
already aligned with the draft. Dependencies are already add/remove-able in the view with
cycle detection. The **only** real gap is the acceptance-criteria editor.

## What Changes

- Replace the legacy Markdown acceptance-criteria `<Textarea>` in the Task edit form with
  the **same structured-rows editor** used by the Task Draft panel (description input +
  `required` switch + add / delete rows).
- Extract that editor into a **shared component** so the draft panel and the task panel
  render byte-identical UI and cannot drift again.
- Persist edited structured criteria by extending the existing `updateTaskFieldsAction`
  to accept an optional `acceptanceCriteriaItems[]` and route it through the existing
  `replaceAcceptanceCriteria` service.
- Apply **change detection**: only call `replaceAcceptanceCriteria` when the criteria set
  actually changed (description + required + order), so editing an unrelated field (e.g.
  title) never wipes existing dev/admin verification marks.

### Out of scope (confirmed in elaboration)

- No new state-based edit locks for `in_progress` / `to_verify` — existing edit behavior
  is preserved.
- No new role gate for AC editing — it rides the form's existing `canEdit` gate, same as
  the draft panel.
- No rework of the dependency editor — it already works in the task view.
- No new backend service, REST endpoint, or schema migration — the persistence path
  already exists.

## Capabilities

- `task-edit-ui` — the real-Task editing surface in the dashboard task panel.

## Impact

- **Affected code:**
  - `src/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel.tsx` (swap textarea for shared editor; save logic)
  - `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/task-draft-detail-panel.tsx` (consume shared editor)
  - new shared component under `src/components/` (the structured AC editor)
  - `src/app/(dashboard)/projects/[uuid]/tasks/[taskUuid]/actions.ts` (`updateTaskFieldsAction` accepts `acceptanceCriteriaItems`)
  - `messages/en.json`, `messages/zh.json` (reuse existing `acceptanceCriteria.*` keys; add any missing)
- **No DB changes.** `AcceptanceCriterion` model and `replaceAcceptanceCriteria` already exist.
- **Data safety:** verification marks preserved unless criteria genuinely change.
