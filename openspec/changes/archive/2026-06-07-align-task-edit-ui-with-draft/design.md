# Design — Align Task Edit UI with Task Draft

## Context

Two panels edit a task's acceptance criteria, and they disagree:

| Surface | File | AC editor today |
|---|---|---|
| Task Draft (proposal stage) | `proposals/[proposalUuid]/task-draft-detail-panel.tsx` | structured rows: `Input` + `Switch(required)` + add/delete (lines ~420–480) |
| Real Task (post-materialize) | `tasks/task-detail-panel.tsx` | single legacy Markdown `<Textarea>` bound to `task.acceptanceCriteria` (lines 576–587) |

The structured criteria (`acceptanceCriteriaItems`) already exist on a real task — they
are displayed read-only in the panel (lines 983–1129) and gate verification — but the
**edit form** can only touch the legacy string. The backend already supports replacing
the structured set: `replaceAcceptanceCriteria(companyUuid, taskUuid, items)` in
`task.service.ts` (used by `chorus_update_task`). It is atomic (delete + recreate in one
transaction) and intentionally discards verification marks because the definition of done
changed.

## Goals / Non-Goals

**Goals**
- The real-task edit form edits acceptance criteria with the exact same structured UI as
  the draft panel.
- The two panels share one component (no copy-paste divergence).
- Editing AC persists via the existing service; editing other fields never disturbs AC
  verification marks.

**Non-Goals**
- Changing the dependency editor, status locks, or role gating.
- Any backend/service/schema/API change beyond threading one optional field through the
  existing server action.
- Migrating or removing the legacy `acceptanceCriteria` string field from the model.

## Decisions

### D1. Extract a shared `AcceptanceCriteriaEditor` component

Create `src/components/acceptance-criteria-editor.tsx`:

```tsx
export interface AcceptanceCriteriaItemDraft {
  description: string;
  required: boolean;
}

interface Props {
  items: AcceptanceCriteriaItemDraft[];
  onChange: (items: AcceptanceCriteriaItemDraft[]) => void;
  disabled?: boolean;
}
```

It renders exactly what the draft panel renders today: one row per item
(`Input` for description, `Switch` for `required` with required/optional label, `Trash2`
delete button) plus a bottom "Add Criterion" button. It is a controlled component — it
owns no persistence and no validation beyond row add/remove. i18n keys reused:
`acceptanceCriteria.criterionPlaceholder`, `acceptanceCriteria.required`,
`acceptanceCriteria.optional`, `acceptanceCriteria.addCriterion`.

Both panels then render `<AcceptanceCriteriaEditor items={...} onChange={...} />`. The
draft panel's inline JSX is replaced by this component to guarantee alignment (this is the
"aligned by construction" guarantee — they can't drift because they're the same code).

### D2. Seed the editor from `task.acceptanceCriteriaItems`

When entering edit mode on a real task, initialize editor state from the task's existing
structured criteria, not the legacy string:

```ts
const initialAcItems = (task?.acceptanceCriteriaItems ?? [])
  .map((it) => ({ description: it.description, required: it.required ?? true }));
```

State `editCriteriaItems` replaces the old `editAcceptanceCriteria` string in
`task-detail-panel.tsx`. The legacy `<Textarea>` is removed. The legacy
`task.acceptanceCriteria` string is left untouched in the model (not displayed, not
edited) to avoid scope creep / a migration.

### D3. Persist via `updateTaskFieldsAction` + change detection

Extend the server action input:

```ts
interface UpdateTaskFieldsInput {
  taskUuid: string;
  projectUuid: string;
  title: string;
  description?: string | null;
  priority?: string;
  storyPoints?: number | null;
  acceptanceCriteria?: string | null;              // kept; still passed through
  acceptanceCriteriaItems?: AcceptanceCriteriaItemInput[]; // NEW, optional
}
```

In `updateTaskFieldsAction`:
1. Always call the existing `updateTask(...)` for title/description/priority/storyPoints.
2. **Only if** `acceptanceCriteriaItems` is provided, call
   `replaceAcceptanceCriteria(auth.companyUuid, taskUuid, items)`.

The **change detection lives in the client** (the panel): the panel compares the edited
rows against the task's original `acceptanceCriteriaItems` (by `description` + `required`
+ order) and includes `acceptanceCriteriaItems` in the action call **only when they
differ**. When unchanged, the field is omitted → `replaceAcceptanceCriteria` is never
called → verification marks survive. This keeps the destructive replace strictly opt-in
and matches the elaboration decision (Q3a).

Rationale for client-side detection: the panel already holds both the original task and
the edited rows; comparing there avoids an extra DB round-trip and keeps the server action
a thin pass-through. The service-level non-empty validation
(`ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE`) still guards against saving an empty set.

### D4. Empty-set guard in the UI

`replaceAcceptanceCriteria` throws if the resulting set is empty. The panel must therefore
block "Save" (or surface the error) when the user has deleted all criteria while AC
changed. We mirror the draft panel: filter out blank-description rows before comparing /
sending; if the filtered set is empty **and** differs from the original (i.e. user cleared
all AC), show an inline validation error using the existing required-AC message rather than
letting the server 500. Title-required validation is unchanged.

## Data Safety

The only destructive operation is `replaceAcceptanceCriteria`, which wipes dev/admin
verification marks. It runs **only** when the criteria set changed. Concretely:

- Edit title only → `acceptanceCriteriaItems` omitted → marks preserved. ✅
- Add/remove/reword a criterion or flip required → field sent → marks reset (correct: the
  definition of done changed). ✅
- Re-open the form and Save with no AC change → field omitted → marks preserved. ✅

## Risks / Trade-offs

- **Risk:** false-negative change detection sends AC unnecessarily and wipes marks.
  *Mitigation:* compare normalized rows (trimmed description + boolean required + index);
  unit-test the comparison helper.
- **Risk:** false-positive (misses a real change) leaves stale AC.
  *Mitigation:* comparison is exact on the same fields the editor can change; covered by
  tests.
- **Trade-off:** keeping the legacy `acceptanceCriteria` string in the model is mild debt,
  but removing it is out of scope and would require a migration + data backfill review.

## Migration / Rollout

Pure frontend + one server-action signature extension. No DB migration. No data backfill
(consistent with the project's no-DML-in-migrations rule). Ships behind no flag — the new
editor simply replaces the textarea.
