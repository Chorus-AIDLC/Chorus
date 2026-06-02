# Tasks

## 1. Shared validation helper
- [ ] 1.1 Add `src/lib/acceptance-criteria.ts` with `normalizeAcceptanceCriteria`, `hasNonEmptyAcceptanceCriteria`, and `ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE`
- [ ] 1.2 Unit tests for the helper (empty / all-blank / mixed / non-empty)

## 2. Proposal task-draft enforcement
- [ ] 2.1 `addTaskDraft` rejects missing/blank AC
- [ ] 2.2 `updateTaskDraft`: reject when AC provided-but-blank; preserve when omitted; replace when non-empty
- [ ] 2.3 Tests for both service functions

## 3. Real task enforcement (public.ts)
- [ ] 3.1 `chorus_create_tasks`: pre-validate all tasks' AC before creating any
- [ ] 3.2 `chorus_update_task`: add optional `acceptanceCriteriaItems` with replace semantics + blank rejection
- [ ] 3.3 Tests for create + update paths

## 4. Documentation
- [ ] 4.1 Update tool/param descriptions in `pm.ts` and `public.ts`
- [ ] 4.2 Update `docs/MCP_TOOLS.md` (required markers + examples)
- [ ] 4.3 Update `public/skill/` and `public/chorus-plugin/skills/chorus/` AC wording

## 5. Verify
- [ ] 5.1 `npx tsc --noEmit`, `pnpm lint`, `pnpm test` all green
