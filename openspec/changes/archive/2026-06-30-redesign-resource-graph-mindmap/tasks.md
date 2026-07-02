# Tasks — Resource Graph Mind-Map Redesign

## 1. Dependencies & layout core
- [ ] 1.1 Add `d3-hierarchy` + `@types/d3-hierarchy`; remove `react-force-graph-2d`, `d3-force`, `@types/d3-force`
- [ ] 1.2 Build the deterministic forest layout module (derive+lineage → trees, multi-root stacking, pre-order DFS ordering) with unit tests

## 2. Desktop canvas
- [ ] 2.1 Replace force canvas with a deterministic horizontal tree canvas (cards at computed coords, elbow connectors, dashed depends/multi-source overlay, pan/zoom)
- [ ] 2.2 Coordinate-tween animation on expand/collapse/live-update; preserve presence rings + selection ring + +/− affordance hit-test

## 3. Mobile outline
- [ ] 3.1 Vertical indented outline renderer (DOM), shared expand state, same onNodeClick contract; responsive breakpoint switch

## 4. Wiring, i18n, tests
- [ ] 4.1 Swap dynamic import in `resource-graph.tsx`; update subtitle/empty-state copy (en+zh) to mind-map wording
- [ ] 4.2 Keep live-update test green; add layout + outline-ordering tests
