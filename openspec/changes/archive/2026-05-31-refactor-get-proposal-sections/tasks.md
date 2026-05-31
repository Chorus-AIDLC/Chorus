# Tasks

## 1. Service-layer section slicing
- [ ] 1.1 Add `ProposalSection` type + index/section response types to `proposal.service.ts`
- [ ] 1.2 Implement `getProposalSection()` reusing `getProposal()` (no second DB query)
- [ ] 1.3 Add index mappers `toDocumentDraftIndex` / `toTaskDraftIndex`
- [ ] 1.4 Unit tests: basic / documents / tasks / full + default + not-found

## 2. MCP tool wiring
- [ ] 2.1 Add `section` enum param to `chorus_get_proposal` inputSchema
- [ ] 2.2 Default to `basic`; call `getProposalSection`; keep not-found handling
- [ ] 2.3 Expand tool description (four sections, default, drill-in hint)

## 3. Downstream consumers + docs
- [ ] 3.1 Update proposal-reviewer agent to fetch `documents` / `tasks` sections
- [ ] 3.2 Update proposal + review skills (public/skill, public/chorus-plugin, plugins/chorus)
- [ ] 3.3 Update `docs/MCP_TOOLS.md`
- [ ] 3.4 `pnpm test` + `npx tsc --noEmit` + `pnpm lint` green
