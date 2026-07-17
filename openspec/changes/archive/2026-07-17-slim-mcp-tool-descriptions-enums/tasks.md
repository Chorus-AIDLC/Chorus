# Tasks — Slim MCP tool descriptions + enum params

## 1. Convert 6 filter/type params to strict z.enum
- [ ] 1.1 `public.ts`: convert `get_ideas.status`, `list_tasks.status`, `list_tasks.priority`, `get_documents.type`, `get_proposals.status` to `z.enum([...])` with the verified strict domains (keep `.optional()`).
- [ ] 1.2 `pm.ts`: convert `add_document_draft.type` and `update_document_draft.type` to `z.enum([...])` (6-value domain; keep update's `.optional()`).
- [ ] 1.3 Extend `src/mcp/__tests__/` to assert each enum rejects an out-of-domain value, accepts each valid value, and stays optional where it was.
- [ ] 1.4 `pnpm test`, `npx tsc --noEmit`, `pnpm lint` clean.

## 2. Compress 7 tool descriptions + relocate behavior red-lines
- [ ] 2.1 Rewrite the 7 descriptions (`create_report`, `get_proposal`, `pm_start_elaboration`, `create_tasks`, `update_task`, `pm_assign_task`, `add_reference`) to ≤ 2 sentences (what/when).
- [ ] 2.2 Move parameter-bound detail into each param's `.describe()` (report 3-section contract → `content`; "no Other" → elaboration `questions/options`; two-mode note → `create_tasks.proposalUuid`; etc.).
- [ ] 2.3 Keep whole-call red-lines as one short clause in the description (survives headless/no-skill agents).
- [ ] 2.4 Add a description-length guard test (≤ 2 sentences / char bound) for the 7 tools.
- [ ] 2.5 `pnpm test`, `npx tsc --noEmit`, `pnpm lint` clean.

## 3. Sync documentation
- [ ] 3.1 Update `docs/MCP_TOOLS.md` entries for the 7 tools + the enum params to match the trimmed schema.
- [ ] 3.2 Ensure the relocated procedural prose lives in `public/skill/` and `public/chorus-plugin/skills/chorus/` (idea/proposal/develop skills as applicable); keep both roots in sync.
- [ ] 3.3 Record the tool-area token before/after delta (description + schema char length for the 7 tools) for the completion report.
