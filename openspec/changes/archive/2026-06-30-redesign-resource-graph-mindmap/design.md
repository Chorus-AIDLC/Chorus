# Design — Resource Graph Mind-Map Redesign

## Context

The rendering layer (`force-graph-canvas.tsx`) is the only thing changing. The
data pipeline below it is correct and stays as-is:

- `getProjectResourceGraph()` (service) — `{ nodes, edges }` with `derive` /
  `lineage` / `depends` kinds, root-tasks-only proposal→task edges.
- `computeVisibleSet(graph, expandedIdeas, expandedProposals)` — the two-level
  expand model (Idea→Proposals, Proposal→Tasks+Docs) and per-hub child counts.
- `shouldShowExpandAffordance(type, childCount)` — hub detection.
- `resource-graph.tsx` — fetch, SSE live-reconcile, type filter, the four side
  panels, and the `ForceNode[] / ForceLink[]` it hands to the canvas.

So this redesign is a **renderer swap behind a stable prop contract**. The
parent keeps producing the same visible node/link set; only the component that
draws them changes.

## Goals / Non-Goals

**Goals**

- Deterministic layout: identical inputs → identical coordinates; no physics,
  no jitter on expand/collapse or drag.
- Direction legible: depth = derivation level, left→right on desktop.
- Responsive: vertical indented outline on narrow viewports, sharing the exact
  expand state.
- Preserve every existing behavior: presence rings, live updates, side panels,
  type filter, two-level expand, root-tasks-only edges, dashed `depends`/
  multi-source overlay.

**Non-Goals**

- Changing the aggregation, the visible-set model, or the side panels.
- Touching the task-dependency DAG view (`@xyflow/react` + `dagre`) — separate
  feature, untouched.
- Radial or top-down layouts (rejected in elaboration: horizontal won).

## Decisions

### D1 — Layout: deterministic tree via `d3-hierarchy`

Build a forest: each root Idea is a tree root; `lineage` makes child Ideas
subtrees of their parent Idea; an expanded Idea's Proposals are its children; an
expanded Proposal's Tasks + Documents are its children. Multiple roots are
stacked with a fixed vertical gap.

Use `d3.hierarchy()` + `d3.tree()` with a node-size function so variable card
heights don't overlap (the flextree behavior). Coordinates are computed in a
`useMemo` keyed by the visible node/link set + expand state. The canvas renders
nodes at those coordinates and tweens between coordinate sets on change.

Because `depends` and multi-source edges are NOT tree edges, the tree is built
**only from `derive` + `lineage`** edges. A node's tree parent is unambiguous:
- child Idea → parent Idea (`lineage`),
- Proposal → its owning Idea (first project-local `sourceIdeaUuids`),
- Task/Document → its Proposal (`proposalUuid`).

A node whose tree-parent is hidden (collapsed) is not in the visible set, so the
forest only ever contains visible nodes. Orphans (no tree parent, e.g. a
manual task or a multi-source proposal's secondary root) become their own
single-node roots in the forest, stacked like root Ideas.

### D2 — Animation: tween coordinates, never simulate

Keep a `Map<id, {x,y}>` of the previously-rendered coordinates. On a new layout,
animate each surviving node from its old coord to its new coord over ~300ms
(ease-out) via `requestAnimationFrame`; new nodes fade/scale in at their target
coord; removed nodes fade out. No alpha/velocity/cooldown — there is no
simulation to reheat. This is the core fix for "乱跳".

### D3 — Rendering surface: Canvas 2D (desktop), DOM (mobile outline)

Desktop keeps a Canvas-2D painter (reusing the existing node card visual
language: rounded card, type chip + glyph, eyebrow, title, +/− button, presence
ring, selection ring) but positions cards at the computed tree coordinates and
draws **orthogonal/bezier elbow connectors** for `derive`/`lineage`. `depends`
and multi-source links are drawn as **dashed** strokes (`setLineDash`) at low
opacity, raised to full opacity only when an endpoint is in the
hovered/selected node's family. Pan/zoom retained.

Mobile (narrow viewport, detected via a `matchMedia`/ResizeObserver breakpoint)
renders a **DOM** vertical indented outline: each visible node is a row, indented
by `depth * step`, with the same type chip/title and a +/− affordance; the same
`onNodeClick(id, type, onAffordance)` contract drives expand + panel-open.
Ordering is a pre-order DFS of the forest. DOM (not canvas) because an outline is
naturally a scrolling list and gets accessibility + text selection for free.

### D4 — Dependencies

- Add `d3-hierarchy` + `@types/d3-hierarchy` (pure JS, no native bindings).
- Remove `react-force-graph-2d`, `d3-force`, `@types/d3-force` — no other
  consumer (verified by grep; only the graph canvas imports them).
- `@xyflow/react` + `dagre` remain (task-DAG view consumer is unrelated).

### D5 — Prop contract stays stable

`ForceGraphCanvas`'s public props (`nodes: ForceNode[]`, `links: ForceLink[]`,
`selectedId`, `onNodeClick`) are unchanged so `resource-graph.tsx` and the
existing live-update test (which mocks the canvas and asserts on the node/link
data it receives) keep working. The component/file may be renamed to
`mindmap-canvas.tsx`; the parent's dynamic import updates accordingly, and the
re-exported `ForceNode`/`ForceLink` types are preserved (or aliased) so no other
import breaks. `ownerId` (used today only by the force cluster tether) becomes
the tree-parent hint — same field, clearer meaning.

## Risks / Trade-offs

- **Variable node height in `d3.tree`** — `d3.tree().nodeSize()` takes a fixed
  size; for variable heights, set per-node size before layout or post-adjust
  sibling separation. Mitigation: cards are fixed-height (46px today), so a
  constant node size is sufficient for v1; flextree-style variable sizing is a
  refinement, not a blocker.
- **Multi-source proposal** appears under one Idea (its first project-local
  source); the secondary source is shown via a dashed overlay edge, matching the
  elaboration decision. No node duplication.
- **Deep/wide trees** can exceed the viewport — pan/zoom (desktop) and vertical
  scroll (mobile) cover this; no virtualization in v1 (project graphs are
  bounded by entity count, same as today's force view).

## Migration

Pure front-end swap; no data migration, no API change, no schema change. The
route, nav entry, and REST endpoint are untouched.
