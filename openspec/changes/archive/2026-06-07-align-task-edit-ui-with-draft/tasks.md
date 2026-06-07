# Tasks — Align Task Edit UI with Task Draft

## 1. Shared acceptance-criteria editor component
- [ ] 1.1 Create `src/components/acceptance-criteria-editor.tsx` (controlled: items + onChange + disabled), rendering the draft panel's row UI (Input + required Switch + Trash delete + Add Criterion). Reuse `acceptanceCriteria.*` i18n keys.
- [ ] 1.2 Refactor `task-draft-detail-panel.tsx` to consume the shared editor (replace inline JSX), preserving behavior.
- [ ] 1.3 Unit test the change-detection helper (normalized compare of description + required + order).

## 2. Task panel edit form
- [ ] 2.1 In `task-detail-panel.tsx`, replace the legacy `acceptanceCriteria` `<Textarea>` and `editAcceptanceCriteria` state with `editCriteriaItems` seeded from `task.acceptanceCriteriaItems`; render `<AcceptanceCriteriaEditor>`.
- [ ] 2.2 In save handler, compute whether AC changed vs original; include `acceptanceCriteriaItems` in the action call only when changed; block save with the required-AC message if the changed set is empty.

## 3. Persistence
- [ ] 3.1 Extend `updateTaskFieldsAction` (`tasks/[taskUuid]/actions.ts`) with optional `acceptanceCriteriaItems`; when present, call `replaceAcceptanceCriteria` after `updateTask`.

## 4. i18n + verification
- [ ] 4.1 Ensure all strings use existing/added keys in both `en.json` and `zh.json`.
- [ ] 4.2 `pnpm lint`, `npx tsc --noEmit`, and relevant `pnpm test` pass; manually verify: edit title preserves marks, edit AC resets marks.
- [ ] 4.3 Update `docs/design.pen` for the changed Task edit panel.
