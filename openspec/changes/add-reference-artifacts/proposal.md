## Why

Today external evidence in Chorus lives only as free markdown links buried inside document bodies, with no structured link to the proposals or tasks that rely on it. A reviewer verifying whether an implementation choice is grounded in an official doc, a GitHub reference implementation, or a prior issue/PR thread has no first-class place to look. GitHub issue #399 (reporter @Utopia-V) asked for research/reference material to become a first-class, linkable artifact; the maintainer confirmed this is the real gap for the next release. This change delivers the V1 slice.

## What Changes

- **New first-class entity `ReferenceArtifact`** — a company-scoped, UUID-addressed record holding a reference `type`, `url`, `title`, and human/agent-authored `notes`. No content fetching or snapshotting (link + summary only).
- **Polymorphic linking to Proposals and Tasks** — each artifact attaches to exactly one target (`targetType` ∈ {`proposal`, `task`}) via the established `targetType` + `targetUuid` + composite-index idiom (mirrors `Comment`/`Activity`). Not linkable to acceptance criteria in V1.
- **Four reference types** — `docs` (official documentation), `repo` (GitHub reference implementation), `issue_pr` (issue / PR thread), `paper_blog` (paper or blog post). No local-file references in V1.
- **REST API** — `GET/POST /api/references` (list by target, create) and `GET/PATCH/DELETE /api/references/[uuid]`, gated for agents by the existing `document:read` / `document:write` permissions (no new permission bit).
- **MCP tools** — `chorus_add_reference` / `chorus_update_reference` / `chorus_remove_reference` (gated `document:write`), so authoring agents can attach evidence during proposal/dev runs. No standalone reference-read MCP tool (that was part of the rejected retrieval option); agent reads are inline (below).
- **Inline retrieval** — linked artifacts are surfaced in the `chorus_get_proposal` and `chorus_get_task` MCP payloads and rendered read-only in the proposal detail sidebar and task detail panel, so downstream proposal/dev/review runs and human reviewers see evidence next to the claim it grounds. No dedicated read/search tool and no memory-plugin hook in V1 (elaboration q6=a).
- **Creation by both agents and humans** — agents via MCP during authoring, humans via an "Add reference" dialog in the UI.

## Capabilities

### New Capabilities

- `reference-artifacts`: First-class research/reference artifacts — the data model, company-scoped tenancy, polymorphic linking to proposals and tasks, the four reference types, REST + MCP create/read/update/delete surface, inline retrieval in proposal/task payloads and detail views, and the read-only reviewer grounding view.

### Modified Capabilities

<!-- None — no existing capability's requirements change. -->

## Impact

- **Schema**: one new Prisma model `ReferenceArtifact` + a `referenceArtifacts` back-relation on `Company`; one new migration. `relationMode = "prisma"` (no DB FK), so `@@index` on `companyUuid` and the `(targetType, targetUuid)` composite is mandatory.
- **Service layer**: new `src/services/reference-artifact.service.ts` (registered in `src/services/index.ts`), reusing the target-resolution switch pattern from `comment.service.ts`.
- **REST**: new `src/app/api/references/route.ts` + `src/app/api/references/[uuid]/route.ts`.
- **MCP**: three new write tools in `src/mcp/tools/` + entries in `permission-map.ts`; wired in `server.ts`. Existing `chorus_get_proposal` / `chorus_get_task` payloads gain a `references` array (the read path — no separate read tool).
- **UI**: read-only References section + add/edit/delete affordance on the proposal detail sidebar and task detail panel; a `references.*` i18n block in `messages/en.json` and `messages/zh.json`.
- **Authz**: reuses the `document` resource — no change to `src/lib/authz/types.ts` or role presets.
- No breaking changes; the feature is additive.
