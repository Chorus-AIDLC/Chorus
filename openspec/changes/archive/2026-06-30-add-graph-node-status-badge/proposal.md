# add-graph-node-status-badge

## Why

The resource-graph mind-map currently encodes only **type** on each node card
(color + icon + type label). An entity's *status* — where an Idea sits in its
lifecycle, whether a Proposal is approved, whether a Task is done — is hidden:
a user must hover a node (desktop only) to read a status badge in the tooltip,
or click into a side panel. The hover tooltip shipped in
`add-graph-node-hover-tooltip` was the workaround, and it is unsatisfying:
status is the single most scannable fact about a node, yet the tree gives no
at-a-glance read of *how far along* each branch is.

Moving status onto the card itself lets a user scan an entire project tree and
immediately see progress — which ideas are still being elaborated, which
proposals await approval, which tasks are in flight versus done — without
hovering or clicking. With status on the card, the hover tooltip's only
remaining job is to reveal the **full (untruncated) title**, so it simplifies to
title-only.

## What Changes

- **Node cards display status.** Each node card shows a status indicator in
  addition to its type:
  - **Idea** → its derived `badgeHint` (the 8-state pipeline hint: Open /
    Researching / Answer Questions / Planning / Review Proposal / Building /
    Verify Work / Done), reusing the idea tracker's existing label + color
    mapping. This conveys the idea's *real* progress (derived from its
    proposals and tasks), not just the stored 3-state value.
  - **Proposal** → its lifecycle status (draft / pending / approved / rejected /
    revised).
  - **Task** → its lifecycle status (open / assigned / in_progress / to_verify /
    done / closed).
  - **Document** → its **type** badge (PRD / Tech Design / …), since a Document
    has no lifecycle status. (Type was already encoded by node color/eyebrow;
    the document badge restates it as the card's status-slot content so every
    node has a consistent badge position.)
- **Status comes from the aggregation payload, not fetch-on-hover.** The
  project resource-graph aggregation is extended so every node carries the
  status value it should display. Because the graph already re-fetches the whole
  payload on any project SSE entity change (debounced), card status updates live
  with no new realtime plumbing.
- **The hover tooltip simplifies to title-only.** It no longer shows a status
  badge (status is now on the card). The desktop tooltip keeps its sole
  remaining purpose: revealing the node's full, untruncated title. The
  now-redundant per-entity fetch-on-hover path is removed.
- **Both renderings show status.** The desktop horizontal canvas paints the
  status indicator on each card; the mobile vertical outline shows the status as
  a badge on each row.
- **All new user-facing text is localized** in both `en` and `zh`.

## Capabilities

- `project-resource-graph` (modified) — node payload carries status; node
  styling shows a status indicator; the hover tooltip drops the status badge and
  becomes title-only.

## Impact

- **Affected specs:** `project-resource-graph` (MODIFIED requirements:
  "Project resource aggregation across four entity types", "Type-based node
  styling and entity-type filtering", "Desktop hover tooltip previewing a node's
  title and status").
- **Affected code:**
  - `src/services/resource-graph.service.ts` — compute + attach per-node status
    (idea derived `badgeHint`, proposal/task raw status, document type).
  - `src/app/(dashboard)/projects/[uuid]/graph/resource-graph.tsx` — consume the
    new status field; remove the fetch-on-hover wiring.
  - `src/app/(dashboard)/projects/[uuid]/graph/mindmap-canvas.tsx` — paint the
    status indicator on each card; simplify tooltip anchoring to title-only.
  - `src/app/(dashboard)/projects/[uuid]/graph/mindmap-outline.tsx` — show a
    status Badge on each row.
  - `src/app/(dashboard)/projects/[uuid]/graph/node-tooltip.tsx` — reduce to
    title-only.
  - `src/app/(dashboard)/projects/[uuid]/graph/use-node-detail.ts` — removed (no
    longer needed once status is on the card).
  - `messages/en.json`, `messages/zh.json` — any new status/label keys.
- **No DB schema change** — all status values come from existing columns.
- **No new API endpoint** — the existing `/api/projects/[uuid]/resource-graph`
  GET passes the extended payload through unchanged.
