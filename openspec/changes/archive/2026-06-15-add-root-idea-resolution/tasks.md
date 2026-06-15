# Tasks

## 1. Server lineage service

- [ ] 1.1 Add `src/services/lineage.service.ts` with `resolveRootIdea(companyUuid, entityType, entityUuid)` using the raw `*ByUuid` getters, returning `{ rootIdeaUuid, lineage, resolvedVia, ambiguous?, candidates? }`.
- [ ] 1.2 Implement entity→idea provenance (task/document/proposal/idea), the `ideaFromProposal` multi-idea handling, and the bounded cycle-safe `walkToRoot`.
- [ ] 1.3 Unit tests covering every entity type, every `resolvedVia` branch, multi-idea ambiguity, cycle guard, cross-company isolation, and a deep parent walk.

## 2. MCP tool registration

- [ ] 2.1 Register `chorus_resolve_root_idea` in `src/mcp/tools/public.ts` (public, no gate) delegating to the service.
- [ ] 2.2 Document the tool in `docs/MCP_TOOLS.md` as a public read tool.

## 3. Daemon integration

- [ ] 3.1 Change `cli/lineage.mjs` `rootIdeaFor` to server-first via `chorus_resolve_root_idea`, with the existing client walk retained as fallback (tool-unavailable detection; well-formed null is authoritative).
- [ ] 3.2 Update `cli/__tests__/lineage.test.mjs`: server-first happy path, fallback on unavailable tool, no-fallback on well-formed null, cache single-flight.
