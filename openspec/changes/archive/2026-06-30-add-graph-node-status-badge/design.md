# Design — add-graph-node-status-badge

## Context

The resource-graph feature is built in three layers:

1. **Aggregation** — `getProjectResourceGraph(companyUuid, projectUuid)` in
   `src/services/resource-graph.service.ts` returns `{ nodes, edges }`. Today a
   node carries only `{ uuid, type, title, parentIdeaUuid?, proposalUuid?,
   sourceIdeaUuids? }` — **no status**.
2. **API** — `GET /api/projects/[uuid]/resource-graph` is a pure passthrough of
   the service result (after a `task:read` gate). Adding fields to the service
   result surfaces them to the client with no route change.
3. **Render** — `resource-graph.tsx` (parent, owns fetch + SSE reconcile + shared
   expand state) switches between `mindmap-canvas.tsx` (desktop horizontal
   Canvas-2D) and `mindmap-outline.tsx` (mobile vertical DOM outline) via
   `useIsMobile`. The canvas paints cards with Path2D icons; the outline uses
   shadcn rows. A `node-tooltip.tsx` DOM overlay (desktop) currently shows
   title + status badge, fed by `use-node-detail.ts` (debounced, cached
   fetch-on-hover of the per-entity REST endpoint).

The live-update path already exists and is reused unchanged: `resource-graph.tsx`
subscribes via `useRealtimeEntityTypeEvent("idea"|"proposal"|"task"|"document",
reloadGraph)` (debounced 300ms), so any entity change re-fetches the whole
payload and reconciles (preserving expand state + animating surviving nodes).

## Goals / Non-Goals

**Goals**
- Status visible on every node card, in both renderings, with no hover/click.
- Status updates live through the *existing* refetch path (no new SSE plumbing).
- Reuse the existing label + color vocabulary verbatim (idea tracker badgeHint
  map; the tooltip's already-correct status/doc-type color + i18n maps).
- Simplify the tooltip to title-only and delete the now-dead fetch-on-hover hook.

**Non-Goals**
- No targeted per-node SSE patch (elaboration Q4 = reuse full refetch).
- No DB schema change; no new endpoint.
- No change to edges, layout math, expand model, presence, or selection.

## Decisions

### D1 — Status source: aggregation payload, computed server-side

Status moves **into** the `ResourceGraphNode` payload (a new optional `status`
field). This is the only sane source because the card must show status for
*every* node, always-on and live — fetch-on-hover (the tooltip's old model)
cannot satisfy "always visible".

Per type, the value placed in `status`:

| Node type | `status` value | Source |
|---|---|---|
| `idea` | derived `badgeHint` (e.g. `building`, `review_proposal`) | `computeDerivedStatus(...)` over the idea's proposals + tasks |
| `proposal` | raw `Proposal.status` (`draft`/`pending`/`approved`/`rejected`/`revised`) | column |
| `task` | raw `Task.status` (`open`/`assigned`/`in_progress`/`to_verify`/`done`/`closed`) | column |
| `document` | `Document.type` (`prd`/`tech_design`/…) | column |

> **Idea = `badgeHint`, not the stored 3-state status** (elaboration round Q1).
> The 8-state badgeHint conveys real pipeline progress. To compute it the
> service must, for ideas, replicate the idea-tracker derivation:
> `computeDerivedStatus({ ideaStatus, elaborationStatus, hasPendingProposal,
> hasApprovedProposal, taskStatuses })` (exported from `idea.service.ts`). The
> aggregation already queries all proposals + tasks for the project; it needs to
> additionally select `Idea.status` + `Idea.elaborationStatus` and
> `Proposal.status` + `Task.status` (currently only uuid/title/links are
> selected) and group task statuses under each idea's latest approved proposal —
> the same logic as `getIdeasWithDerivedStatus`. The cleanest implementation is
> to **reuse `computeDerivedStatus` directly** (already exported) and build the
> per-idea inputs inline in the aggregation, rather than duplicating the rule.

To keep the payload self-describing, the node also carries a small discriminator
so the client knows how to interpret `status` without re-deriving the type
mapping — but since the client already has `node.type`, the renderer can pick
the right label/color map from `type` alone. We therefore add **only** the
`status: string` field (the badgeHint string for ideas; the raw status for
proposal/task; the type string for document). No second field is needed.

### D2 — Status presentation: reuse existing maps, per renderer

The **label + color vocabulary already exists** and must be reused verbatim:

- **Idea badgeHint** → `idea-card.tsx`'s `badgeHintI18n` (→ `ideaTracker.*`
  keys) + `badgeHintColor` (text-color classes).
- **Proposal / Task / Document** → `node-tooltip.tsx` already holds the correct
  `PROPOSAL_STATUS_COLOR` / `TASK_STATUS_COLOR` / `DOC_TYPE_COLOR` maps and the
  `STATUS_I18N` / `DOC_TYPE_I18N` key maps, copied verbatim from the kanban /
  doc-type surfaces.

To avoid divergence, these maps are **lifted into one shared module**
(`graph/node-status.ts`) exporting, for a given `(type, statusValue)`, the
resolved `{ label-key, colorClass }`. Both the canvas painter and the outline
row import from it; the simplified tooltip no longer needs them.

- **Outline (DOM):** render a shadcn `<Badge>` per row using the shared map's
  color class + translated label — trivial, reuses `<Badge>`.
- **Canvas (Path2D):** the canvas cannot mount React, so the status is painted
  as a small rounded "pill" — a filled rounded-rect + text — using a hex
  fill/text color. Since the Tailwind classes encode hex pairs
  (`bg-[#E8F5E9] text-[#2E7D32]`), the shared module additionally exposes the
  **raw hex pair** (`{ bg, fg }`) for the canvas path, so canvas and DOM stay
  color-identical. Label text is the translated string (painter already receives
  a `typeLabels` record from `useTranslations`; it will likewise receive a
  `statusLabels` resolver).

> **Layout (Q1 implementation note):** badgeHint labels are longer than a
> 4-state set (some are two words, e.g. "Review Proposal"). Card width is ~200px.
> The status pill is placed on the **eyebrow row** beside the type label
> (right-aligned), and its text is ellipsis-truncated to the available width so a
> long label never overflows the card or collides with the title. The exact
> placement is the canvas painter's call; the requirement only fixes that status
> is shown without breaking the card layout.

### D3 — Tooltip → title-only; delete fetch-on-hover

With status on the card, the tooltip's status badge is redundant (elaboration
Q3). `node-tooltip.tsx` reduces to rendering the full untruncated title only —
no badge, no spinner, no `NodeDetail`. Consequently:

- `use-node-detail.ts` (debounced/cached per-entity fetch-on-hover) is **deleted**
  — nothing else consumes it.
- `resource-graph.tsx` / `mindmap-canvas.tsx` drop the `useNodeDetail` wiring and
  the `detail`/`loading` props; the tooltip is fed only the hovered node's title
  (already in the payload) + screen anchor.
- The tooltip remains desktop-only, anchored to the card, `pointer-events-none`,
  non-occluding, clearing on mouse-out, not interfering with lineage highlight or
  clicks — all unchanged from the current behavior.

### D4 — Realtime: reuse full refetch (Q4)

No new code. Card status is part of the payload; the existing
`useRealtimeEntityTypeEvent → reloadGraph` (debounced 300ms, with reconcile that
preserves expand state and animates survivors) already re-fetches on any
idea/proposal/task/document change, so a status transition (e.g. a task moving to
`done`, a proposal `approved`) reflects on the card within the debounce window.
The reconcile must carry the new `status` field through to surviving nodes (it
already replaces node objects wholesale on refetch, so this is automatic — a
regression test pins it).

## Risks / Trade-offs

- **Extra per-idea derivation cost in the aggregation.** Computing badgeHint
  needs the idea's proposals' statuses + their tasks' statuses. The aggregation
  already loads all four entity sets; we add `status`/`elaborationStatus`/`type`
  to the existing `select`s and a single in-memory grouping — no new query, no
  N+1. *Mitigation:* mirror `getIdeasWithDerivedStatus`'s batch approach.
- **Canvas/DOM color drift.** Two renderers, one vocabulary. *Mitigation:* the
  shared `node-status.ts` is the single source for both class strings (DOM) and
  hex pairs (canvas); a unit test asserts the hex pair matches the Tailwind
  class hex for each status.
- **Long badgeHint labels on a narrow card.** *Mitigation:* eyebrow-row
  placement + ellipsis truncation (D2 note); the title remains the card's
  primary line.
- **Removing `use-node-detail.ts` touches the #377 tooltip tests.** *Mitigation:*
  delete/rewrite `use-node-detail.test.tsx` and trim `node-tooltip.test.tsx` to
  the title-only contract in the same task.

## Migration

None — additive payload field + UI change. No data migration, no API version
bump, no breaking change to the GET contract (only new fields added).
