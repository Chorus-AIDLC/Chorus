# Tasks

## 1. Data model & service layer
- [ ] 1.1 Add `ReferenceArtifact` model + `Company` back-relation to `prisma/schema.prisma`; generate migration `add_reference_artifact`; `prisma generate`.
- [ ] 1.2 Add `src/services/reference-artifact.service.ts` (list/create/get/update/delete + type/url/target validation) and register in `src/services/index.ts`; unit tests.

## 2. REST + MCP surface
- [ ] 2.1 Add `src/app/api/references/route.ts` (GET/POST) + `src/app/api/references/[uuid]/route.ts` (GET/PATCH/DELETE) with `document:read`/`document:write` gating.
- [ ] 2.2 Add MCP write tools `chorus_add_reference` / `chorus_update_reference` / `chorus_remove_reference` (no standalone read tool — q6=a); wire in `server.ts`; add to `permission-map.ts`; include a `references` array in the `chorus_get_proposal` / `chorus_get_task` payloads as the read path.

## 3. UI + i18n
- [ ] 3.1 References section on proposal detail sidebar + task detail panel (read-only list + add/edit/delete dialog), server actions, and `references.*` i18n block in `en.json` + `zh.json`.
