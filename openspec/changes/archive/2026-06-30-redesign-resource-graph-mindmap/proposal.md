# Redesign Resource Graph as a Collapsible Mind-Map Tree

## Why

The project resource graph (capability `project-resource-graph`, shipped in
`add-project-resource-graph`) renders its Idea / Proposal / Task / Document
entities with a **force-directed** knowledge-graph layout
(`react-force-graph-2d` + `d3-force`). In practice the force layout fights the
data, and that mismatch is the root cause of every usability complaint:

- **Clumping** — nodes pile on top of one another and edges cross, because a
  spring simulation has no inherent direction to spread along.
- **Jumpiness / over-sensitivity** — every expand/collapse and every node drag
  re-heats the simulation, so the whole graph visibly jitters and re-settles.
- **Illegible direction** — a spring layout cannot convey that
  `idea → proposal → task/document` and `idea → child idea` are all *the same
  one-way derivation*.

The data is in fact a **rooted forest, not an arbitrary graph**: `lineage`
(idea→idea), idea→proposal, and proposal→task/document are all `derive`-style
edges fanning out from clear root Ideas. Only two relationships are not pure
tree edges: `depends` chains between tasks inside a proposal, and the rare
multi-source proposal.

## What Changes

Replace the force-directed renderer with a **deterministic collapsible
mind-map tree**, keeping the existing aggregation service, two-level
expand/collapse model, presence highlighting, live structural updates, side
panels, and type filter unchanged. Four design decisions (recorded as an
elaboration round on the driving idea) shape the redesign:

1. **Horizontal mind-map (desktop).** Root Ideas on the left; derivation grows
   rightward; depth encodes derivation level. Multiple root Ideas stack
   vertically.
2. **Responsive reorientation (mobile).** On narrow viewports the same tree —
   same expand state — renders as a **vertical indented outline** (top-to-bottom
   scroll) instead of the wide horizontal canvas.
3. **Tree-primary + dashed overlay for non-tree edges.** Solid `derive`/
   `lineage` edges position the tree; `depends` chains and multi-source proposal
   links are faint dashed overlays that do not affect layout and only highlight
   on hover/selection of a related node.
4. **Deterministic tree-layout library.** Use `d3-hierarchy` (`d3.tree` /
   flextree-style variable node sizing) to compute exact node coordinates with
   **zero physics**. Expand/collapse recomputes coordinates once and tweens to
   them, eliminating the jitter at its source. This fully replaces
   `react-force-graph-2d` + `d3-force`, which are removed from the dependency
   set (both are pure-JS already, but so are the replacements — no native
   bindings, per the cross-platform constraint).

This is a **MODIFIED** change to the `project-resource-graph` capability: the
"Knowledge-graph rendering laid out force-directed" requirement is replaced by a
"Mind-map tree rendering" requirement, the per-Idea expand requirement is
reworded for the tree, the presence and live-update requirements drop their
force-position-preservation language (positions are now deterministic), and a
new requirement covers the mobile vertical outline. The node-click side-panel,
type-styling/filter, and aggregation requirements are unchanged.

## Capabilities

- `project-resource-graph` (MODIFIED) — rendering switches from force-directed
  to a deterministic mind-map tree with a responsive mobile outline; presence
  and live-update requirements updated to match deterministic layout; a new
  requirement adds the mobile vertical-outline rendering.

## Impact

- **Dependencies:** add `d3-hierarchy` (+ `@types/d3-hierarchy`); remove
  `react-force-graph-2d` and `d3-force` (+ `@types/d3-force`) — they have no
  other consumer in the app (the task-dependency DAG uses `@xyflow/react` +
  `dagre`, which stay).
- **Code:** replace `force-graph-canvas.tsx` with a deterministic tree canvas
  (desktop) and add a mobile vertical-outline renderer; `resource-graph.tsx`
  swaps its dynamic import and drops force-position commentary. Service,
  `resource-graph-visible-set.ts`, `expand-affordance.ts`, and the four side
  panels are untouched.
- **Tests:** the live-structural-update test keeps its data-contract assertions
  (it mocks the canvas, so the renderer swap is transparent); add layout-unit
  tests for the deterministic tree builder and the mobile-outline ordering.
- **i18n:** the `graph.subtitle` / empty-state copy that calls the view a
  "knowledge graph" updates to "mind-map" wording in both `en` and `zh`.
- **design.pen:** a Mind-Map mockup is added alongside the retained
  force-directed mockup.
