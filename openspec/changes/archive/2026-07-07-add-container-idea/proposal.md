# Proposal: Container Ideas

## Why

Chorus ideas form a single-parent forest (`parentUuid`, the `idea-lineage` capability). In practice a parent idea is very often just a **container** — it exists to group a set of related child ideas under a shared theme/direction, and does not itself carry a deliverable. But today every idea is a full first-class entity: a container-shaped parent can still be driven all the way to a Proposal and Tasks, which contradicts its "I'm only a grouping" role and lets deliverables pile up on a node that should stay a folder.

We want a way to say "this idea is a container" and have the pipeline respect that, **with the smallest possible code and interaction change**. The design was settled through two elaboration rounds with the idea owner (idea `567127f6`):

- Container identity is an **explicit** flag, decoupled from having children (a non-container idea may also have children; "deriving a child" and "having a child" are UI-level distinctions over the *same* lineage edge).
- A container **can** elaborate (its elaboration is shared context for children) but **cannot** create a Proposal.
- The flag is **freely reversible**.
- It surfaces as a detail-panel toggle + a badge; the proposal-progression CTA is hidden on containers, and "Derive child idea" (already wired) becomes the primary action.
- The container's own status stays as-is (derived from elaboration), plus a **read-only** child-completion rollup ("3/5 done") reusing the existing derived-children summary.

## What Changes

- **New `Idea.isContainer` boolean** (`@default(false)`) — one additive column, one migration (`ALTER TABLE "Idea" ADD COLUMN`). No index (it is a per-row display/guard flag, not a query dimension). Orthogonal to `parentUuid`.
- **Proposal-creation guard** — creating a Proposal whose `inputType = "idea"` and whose input idea is a container is **rejected** at the service layer (`createProposal`), the single choke point all four creation paths funnel through (MCP tool, REST route, server action, full-page form). Friendly errors surface per-surface. Guard blocks **only new** proposal creation — a container that already has proposals (e.g. toggled on after the fact) keeps them; no cascade delete (consistent with "freely reversible + minimal change").
- **`chorus_edit_idea` + `chorus_pm_create_idea` gain `isContainer`** — agents can set/clear the flag; the edit tool's "at least one field" guard accounts for it.
- **REST + server-action passthrough** — `PATCH /api/ideas/[uuid]` and the idea create route accept `isContainer`; `updateIdeaAction` / `UpdateIdeaInput` carry it so the panel toggle works.
- **Idea DTO carries `isContainer`** — added to `IdeaResponse` (+ `formatIdeaResponse` and every feeding `select`), and the tracker literal types (`IdeaWithDerivedStatus`, `TrackerIdeaItem`, `IdeaCardItem`) so the badge renders everywhere.
- **Detail-panel UI** — a "Container" toggle in the idea detail panel action row / edit form; a "Container" badge in the header (and optionally the tracker card); on a container, the proposal-progression CTA (Verify Elaborate / Start Development / Yolo) is hidden and "Derive child idea" is the primary action; the lineage section shows a read-only "N/M children done" rollup computed from `idea.children[].derivedStatus === "done"`.
- **i18n** — new `ideaTracker.lineage.*` keys (container, containerBadge, makeContainer, childrenDone) in **both** `en.json` and `zh.json`.
- **Skill / doc updates** — the idea and proposal skills across all plugin surfaces document the container concept; `docs/MCP_TOOLS.md` records the new `isContainer` param; `docs/design.pen` reflects the toggle/badge/derive-entry.

## Capabilities

### New Capabilities

- `container-idea`: the container-idea concept — what the `isContainer` flag means, that it is explicit and orthogonal to lineage, that a container may elaborate but MUST NOT create a proposal, that it is freely reversible without cascade, and how it surfaces in the idea-tracker UI (toggle, badge, hidden proposal CTA, read-only child rollup).

## Impact

- **Schema**: one additive migration — `ALTER TABLE "Idea" ADD COLUMN "isContainer" BOOLEAN NOT NULL DEFAULT false;`. No index, no data backfill (DDL-only).
- **Backend code**: `prisma/schema.prisma` (Idea model); `src/services/idea.service.ts` (`IdeaResponse`, `formatIdeaResponse`, `IdeaCreateParams`/`createIdea`, `updateIdea` data param, all feeding `select` blocks, tracker types); `src/services/proposal.service.ts` (`createProposal` container guard).
- **MCP**: `src/mcp/tools/pm.ts` — `chorus_edit_idea` (schema + empty-edit guard + passthrough), `chorus_pm_create_idea` (schema + passthrough), and a friendly pre-check in `chorus_pm_create_proposal`.
- **REST / actions**: `src/app/api/ideas/[uuid]/route.ts` (PATCH body), `src/app/api/projects/[uuid]/ideas/route.ts` (POST body), `src/app/(dashboard)/projects/[uuid]/ideas/actions.ts` (`UpdateIdeaInput`/`updateIdeaAction`, `createIdeaAction`), `.../proposals/actions.ts` (friendly guard surfacing).
- **Frontend**: `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` (toggle, badge, hidden CTA, child rollup); `.../dashboard/idea-card.tsx` (optional badge); `create-proposal-form.tsx` (filter container ideas from source list / surface guard error). The `ProposalView` `completedCount` pattern is the model for the "3/5 done" rollup.
- **i18n**: `messages/en.json` + `messages/zh.json` (`ideaTracker.lineage.*`).
- **Plugin / skill code**: idea + proposal skills across the 4 skill surfaces (`public/skill/`, `public/chorus-plugin/skills/chorus/`, `plugins/chorus/skills/`, and OpenClaw if present).
- **Docs**: `docs/MCP_TOOLS.md`, `docs/design.pen`.
- **Runtime**: no new dependencies, no new permissions (reuses `idea:write`), no new MCP transport surface.
- **Backward compat**: fully additive. Existing ideas default to `isContainer = false` and behave exactly as before.
