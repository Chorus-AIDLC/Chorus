# Add Desktop Hover Tooltip to Resource-Graph Nodes

## Why

The resource-graph node cards keep a compact layout: they show only a type
eyebrow and a title, and the title is truncated to fit the card. On the desktop
canvas a user who wants to know an entity's current state — or read a title that
got cut off — has to click the node to open its side panel. A lightweight hover
preview closes that gap without leaving the graph.

The preview should surface what the graph itself does **not** already show. The
graph already conveys structure (which idea derives what, how many children a
hub has via its `+N` count, the dependency chain), so repeating derivative
counts or document counts in a tooltip is redundant. The one thing not visible
on a node card is its **lifecycle status**. So the tooltip is deliberately
minimal: the full (untruncated) title plus a single status badge.

## What Changes

Add a hover tooltip to the desktop resource-graph canvas (`mindmap-canvas.tsx`).
On hover (after a short delay) a tooltip anchored beside the hovered node card
shows:

- the entity's **full title** (untruncated), and
- a **status badge**: for Idea / Proposal / Task the entity's lifecycle status;
  for a Document (which has no status) its document type (e.g. `prd`,
  `tech_design`). Badge styling reuses the existing per-entity badge
  conventions.

Details:

- **Desktop canvas only.** The mobile vertical outline is out of scope — a touch
  device has no hover semantics, and tapping an outline row already opens the
  side panel.
- **Fetch on hover.** The tooltip's data is fetched per entity on hover (reusing
  the existing REST endpoints `GET /api/ideas|proposals|tasks|documents/[uuid]`),
  not baked into the aggregation payload — keeping that payload lean and the
  status always fresh. The fetch is debounced (so a fast hover sweep across
  nodes doesn't fire a burst of requests) and cached per entity UUID for the
  duration of the view.
- **Anchored, not mouse-following.** The tooltip is positioned beside the node
  card (not tracking the cursor), so it stays stable among dense nodes. It
  appears after a short hover delay and disappears on mouse-out, and does not
  occlude the hovered card.
- **Coexists with the existing hover behavior.** Hover already drives the
  lineage focus highlight; the tooltip is additive and does not change that.

This is an **ADDED** capability requirement on `project-resource-graph`; no
existing requirement changes. No aggregation/service change, no schema change.

## Capabilities

- `project-resource-graph` (ADDED) — a desktop hover tooltip that previews a
  node's full title and status/type badge, fetched on demand.

## Impact

- **Code:** a small data hook (fetch-on-hover with debounce + per-uuid cache),
  a tooltip overlay component (DOM, shadcn-style, absolutely positioned over the
  canvas), and wiring in `mindmap-canvas.tsx` to map the existing `hoverId` +
  node screen position to the tooltip anchor. No change to
  `resource-graph.service.ts`, `resource-graph-tree-layout.ts`, or the mobile
  outline.
- **i18n:** any new user-facing strings (e.g. a loading label, status labels if
  not already keyed) added to both `en` and `zh`.
- **Tests:** unit/component coverage for the fetch hook (debounce + cache) and
  the tooltip content mapping (title + correct badge per type).
