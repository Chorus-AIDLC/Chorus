# Design: Reference Artifacts (V1)

## Context

GH #399 point 2. Elaboration round 1 (idea `0a99c88e`) resolved eight decision points; this design turns them into concrete contracts. The whole feature is deliberately thin — it is the first slice of first-class external evidence, not the full grounding/verification system.

Resolved decisions carried into this design:

| # | Decision | Choice |
|---|----------|--------|
| q1 | V1 scope | Full slice: model + linking + read-only reviewer view (each layer minimal) |
| q2 | Data model | New first-class `ReferenceArtifact` Prisma model |
| q3 | Linking granularity | Proposal **+** Task (NOT acceptance criteria) |
| q4 | Reference types | Web links only — `docs`, `repo`, `issue_pr`, `paper_blog` (no local file) |
| q5 | Capture | URL + notes only; no fetch, no snapshot |
| q6 | Retrieval | Inline in proposal/task views + existing MCP `get_*` payloads (no dedicated tool, no memory-plugin hook) |
| q7 | Reviewer workflow | Read-only side-by-side view; no per-claim marks, no agent auto-flag |
| q8 | Creators | Agents (MCP) + humans (UI) |

## Data model

New model, appended to `prisma/schema.prisma`, mirroring the `Comment` polymorphic idiom:

```prisma
model ReferenceArtifact {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  companyUuid String
  company     Company  @relation(fields: [companyUuid], references: [uuid])
  targetType  String   // "proposal" | "task"
  targetUuid  String   // UUID of the linked proposal or task
  type        String   // "docs" | "repo" | "issue_pr" | "paper_blog"
  url         String
  title       String
  notes       String?  // human/agent-authored summary; no fetched content
  createdByType String // "user" | "agent"
  createdByUuid String  // User or Agent UUID
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([companyUuid])
  @@index([targetType, targetUuid])
}
```

And on `Company`: `referenceArtifacts ReferenceArtifact[]`.

**Rationale.** No modeled relation to Proposal/Task — `relationMode = "prisma"` means cross-entity references are plain UUID columns resolved in the service layer (same as `Comment.targetUuid`, `Document.proposalUuid`). The `(targetType, targetUuid)` composite index is the lookup key for "all references on this proposal/task".

`type` and `targetType` are stored as `String` (not a Prisma enum) to match the existing convention (`Document.type`, `Comment.targetType` are all bare strings); validation of the allowed set happens at the service/tool boundary via a Zod enum.

## Type & target validation

- Allowed `type`: `docs | repo | issue_pr | paper_blog`. Rejected otherwise (`Error("Invalid reference type: …")`).
- Allowed `targetType`: `proposal | task`. On create, the service resolves and validates the target exists **and** belongs to `companyUuid` (reusing the `resolveProjectUuid` / `validateTargetExists` switch pattern from `comment.service.ts`), throwing `"… not found"` if not — routes translate that to 404.
- `url` must be a non-blank string beginning with `http://` or `https://` (web-links-only invariant; no `file://`, no local paths).

## Service layer

`src/services/reference-artifact.service.ts`, free-function exports mirroring `document.service.ts`:

- `listReferences({ companyUuid, targetType, targetUuid })` → `ReferenceArtifactResponse[]` ordered `createdAt asc`.
- `createReference({ companyUuid, targetType, targetUuid, type, url, title, notes, createdByType, createdByUuid })` → validates type/url + target existence, inserts, best-effort `activityService.createActivity` + `eventBus.emitChange`, returns DTO.
- `getReference(companyUuid, uuid)` → DTO or null (tenant-scoped `findFirst`).
- `updateReference(companyUuid, uuid, { type?, url?, title?, notes? })` → partial update; re-validate type/url when present; `"… not found"` if absent.
- `deleteReference(companyUuid, uuid)` → tenant-scoped delete; `"… not found"` if absent.

DTO is UUID-only (never leaks `id`); `createdBy` resolved via `formatCreatedBy` from `@/lib/uuid-resolver`; dates `.toISOString()`. Registered in `src/services/index.ts` as `referenceArtifactService`.

For inline retrieval, `proposal.service` / `task.service` read helpers gain a `references` field populated by `listReferences({ targetType, targetUuid: <that entity> })`.

## REST API

- `src/app/api/references/route.ts`
  - `GET` — requires `targetType` + `targetUuid` query params (`errors.validationError` if missing); `checkAgentPermission(auth, "document:read")`; returns `success({ references })`.
  - `POST` — body `{ targetType, targetUuid, type, url, title, notes? }`; `checkAgentPermission(auth, "document:write")`; `createdByType` = `isUser(auth) ? "user" : "agent"`, `createdByUuid = auth.actorUuid`; 404 on unknown target.
- `src/app/api/references/[uuid]/route.ts`
  - `GET` (`document:read`), `PATCH` (`document:write`), `DELETE` (`document:write`); Next-15 async `params: Promise<{ uuid }>`; `errors.notFound("Reference")` when the row is absent or cross-tenant.

All wrapped in `withErrorHandler`, using `success`/`errors.*` from `@/lib/api-response`.

## MCP tools

Reuse the `document` permission bits (no new resource — matches how `chorus_create_report` reuses `document:write`).

| Tool | Gate | Purpose |
|------|------|---------|
| `chorus_add_reference` | `document:write` | Attach a reference to a proposal/task |
| `chorus_update_reference` | `document:write` | Edit type/url/title/notes |
| `chorus_remove_reference` | `document:write` | Detach/delete a reference |

Registered following the `registerPermissionedTool` idiom; each gated tool added to `TOOL_PERMISSIONS` in `permission-map.ts` (the test-only drift guard).

**Retrieval is inline only (q6=a).** There is deliberately **no** standalone `chorus_get_references` read tool — that was part of the explicitly-rejected option b. Instead, `chorus_get_proposal` and `chorus_get_task` responses gain a `references: [...]` array populated via `listReferences`, so an authoring/review agent sees the evidence for an entity on the same call it already makes. Humans read references through the proposal/task detail views (fed by the REST `GET /api/references` endpoint used by the server-side render / server action), not through an MCP tool.

## UI

Read-only rendering + an add/edit/delete affordance (creators = agents + humans, so humans need UI write too).

- **Proposal detail** (`.../proposals/[proposalUuid]/page.tsx`): a References `<Card>` in the sidebar after Source Ideas — one row per artifact (type badge, title as link to `url`, notes, delete). An "Add reference" dialog cloned from `create-document-dialog.tsx` calling a `"use server"` action, then `router.refresh()`.
- **Task detail** (`.../tasks/task-detail-panel.tsx`): a "References" labeled section before Comments, same row rendering + add dialog.
- Both use existing `@/components/ui/*` primitives (`Card`, `Dialog`, `Badge`, `Button`, `Input`, `Label`, `Select`, `AlertDialog` for delete confirm). All strings via a new `references.*` i18n block in `en.json` + `zh.json`.

The reviewer "grounding workflow" in V1 is exactly this read-only side-by-side view — no groundedness marks, no auto-flagging (q7=a).

## Out of scope (deferred)

- AC-level linking (q3 chose proposal+task only).
- Local-file references (q4).
- Content fetching / link-rot snapshots (q5).
- Dedicated `chorus_search`-over-references tool and memory/KG-plugin hook (q6).
- Per-claim groundedness marks and review-agent auto-flagging of unsupported claims (q7).

## Risks

- **Orphaned references on target delete.** `relationMode = "prisma"` gives no DB cascade; a deleted proposal/task leaves its references dangling. V1 accepts this (references are cheap, list queries are target-scoped so orphans are simply never fetched); a follow-up can add a service-level cascade in the proposal/task delete paths. Documented, not fixed here.
- **`type` as free string** could drift from the Zod enum. Mitigated by validating at every write boundary (service + tool + route body).
