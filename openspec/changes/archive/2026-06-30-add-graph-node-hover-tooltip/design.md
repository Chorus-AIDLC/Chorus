# Design — Resource-Graph Node Hover Tooltip

## Context

The desktop canvas (`mindmap-canvas.tsx`) already tracks the hovered node via
`hoverId` (set from a pointer-move hit-test against the live rendered card
rects) and knows each node's graph-space center plus the view transform
(`viewRef = { scale, tx, ty }`). That's everything needed to anchor a DOM
overlay beside the hovered card. The aggregation payload intentionally carries
only `{ id, type, title, childCount, … }`, so the status/type for the tooltip
comes from a per-entity fetch.

## Goals / Non-Goals

**Goals**
- Desktop-only hover tooltip: full title + status (or document type) badge.
- Fetch-on-hover, debounced + cached, with a loading state.
- Anchored beside the card; appears after a short delay; clears on mouse-out.
- Zero change to layout, tween, SSE, the aggregation service, or the mobile
  outline. Additive to the existing hover lineage-highlight.

**Non-Goals**
- Mobile outline tooltip (no hover on touch; tap opens the panel).
- Rich detail (description, assignee, dates, AC progress, presence) — explicitly
  cut in elaboration; status is the only thing the graph can't already show.
- Click-to-pin popover behavior (would collide with the click→side-panel
  contract).

## Decisions

### D1 — DOM overlay, not canvas-drawn

The tooltip is a React DOM element absolutely positioned over the canvas
container, NOT painted into the canvas. Rich text + a styled badge +
accessibility are trivial in DOM and impractical in Canvas 2D. The canvas
container is already `position: absolute inset-0` inside a `relative` parent, so
a sibling absolutely-positioned tooltip layers cleanly on top.

### D2 — Anchor math

When `hoverId` is set, compute the hovered node's **screen** position from its
rendered graph-space center: `screenX = x * scale + tx`, `screenY = y * scale +
ty` (the inverse of the painter's transform). Anchor the tooltip to the right
edge of the card (`screenX + (CARD_W/2)*scale + gap`), vertically centered;
flip to the left / clamp within the container when it would overflow the right
edge. The tooltip reads the live rendered center (the same `renderedRef` source
the hit-test uses) so it stays put while the card is settled.

### D3 — Fetch-on-hover hook

A `useNodeDetail(hoverId, type)` hook:
- Debounces ~200ms after `hoverId` settles before fetching (a fast hover sweep
  cancels the pending fetch — no request burst).
- Caches results in a `Map<uuid, NodeDetail>` for the lifetime of the view, so
  re-hovering a node is instant.
- Exposes `{ detail, loading }`. While loading, the tooltip shows the title we
  already have (from the node payload) + a small loading indicator for the
  badge; when the fetch resolves, the badge fills in.
- Reuses the existing REST endpoints — `GET /api/ideas/[uuid]`,
  `/api/proposals/[uuid]`, `/api/tasks/[uuid]`, `/api/documents/[uuid]` — via
  `fetch`, aborting an in-flight request when `hoverId` changes (same
  AbortController idiom already used in `resource-graph.tsx`'s document fetch).

### D4 — Status/type → badge

A small mapping renders the badge per entity type:
- **Idea** → `idea.status` (open / elaborating / elaborated).
- **Proposal** → `proposal.status` (draft / approved / rejected / revised).
- **Task** → `task.status` (open / assigned / in_progress / to_verify / done /
  closed).
- **Document** → `document.type` (prd / tech_design / adr / spec / guide /
  report) — documents have no lifecycle status.

Badge color/label reuses the existing badge conventions used in the
tasks/proposals/ideas surfaces (shadcn `Badge` + the project's status-color
helpers) so the tooltip reads consistently with the rest of the app. All
user-facing labels go through `t()` (en + zh).

### D5 — Interaction & lifecycle

- The tooltip mounts only when `hoverId` is non-null AND the desktop canvas is
  the active renderer (the parent already chooses canvas vs. outline by
  viewport; the tooltip lives inside the canvas component, so it's desktop-only
  by construction).
- A short appear-delay (handled by the hook's debounce) avoids flicker on a
  hover sweep; mouse-out clears `hoverId` → tooltip unmounts.
- Pointer-events on the tooltip are disabled (`pointer-events-none`) so it never
  intercepts a click meant for the canvas, and never blocks moving onto an
  adjacent node.

## Risks / Trade-offs

- **Stale-while-revalidate:** a cached status could lag a live change. Acceptable
  for a hover preview; the SSE live-update path still reconciles the graph
  structure, and re-opening the side panel shows authoritative state. (Could
  invalidate the cache on the existing entity-change SSE events as a later
  refinement — not required for v1.)
- **Anchor during tween:** while a card is mid-animation its rendered center
  moves; reading the live `renderedRef` keeps the anchor attached, but a tooltip
  is unlikely to be open mid-expand (hover and expand are distinct gestures).
  Acceptable.

## Migration

Pure front-end addition. No data migration, no API change (reuses existing GET
endpoints), no schema change.
