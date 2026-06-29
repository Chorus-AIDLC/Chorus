# Technical Design: Project Resource Graph

## Overview

A new per-project route `/projects/[uuid]/graph` renders every Idea / Proposal / Task /
Document in the project, plus their relationships, as a **knowledge graph**: an organic
node-link web (Ideas as hubs) laid out force-directed, with per-Idea subgraphs that
expand on click. It composes four already-shipped subsystems:

- **Graph rendering** — `@xyflow/react` 12 (`ReactFlow`, custom node types, `Background`,
  `Controls`) as used by `src/components/task-dag.tsx`.
- **Project aggregation pattern** — `getProjectTaskDependencies()`
  (`src/services/task.service.ts:1349`) returns `{ nodes, edges }` scoped by
  `companyUuid` + `projectUuid`; the new service follows the same shape, widened to four
  entity types and three edge kinds.
- **Presence** — `PresenceEvent` (`src/lib/event-bus.ts:20`), SSE
  (`src/app/api/events/route.ts`), the `usePresence()` hook
  (`src/hooks/use-presence.ts:144`), and `PresenceIndicator`
  (`src/components/ui/presence-indicator.tsx`).
- **Side panels** — `usePanelUrl` (`src/hooks/use-panel-url.ts`) and the existing
  `IdeaDetailPanel`, `TaskDetailPanel`, idea-tracker Proposal tab, and `DocumentPanel`.

The corresponding design screens are `Chorus - Project Graph View` and
`Chorus - Project Graph View (Node Selected)` in `docs/design.pen`.

## Architecture

```
/projects/[uuid]/graph/page.tsx           (Server Component — resolves params.uuid)
  └─ <ResourceGraph projectUuid>           (Client Component, inside RealtimeProvider)
       ├─ fetch GET /api/projects/[uuid]/resource-graph  → { nodes, edges }
       ├─ d3-force simulation → x/y per visible node      (layout)
       ├─ collapse state: Set<ideaUuid expanded?>         (expand-to-derive)
       ├─ <ReactFlow nodes edges nodeTypes={resourceNode}>
       │     <resourceNode>  per node:
       │        ├─ chip color + lucide icon + mono eyebrow (type)
       │        ├─ collapsed Idea → "N ›" count pill; expanded → chevron-down
       │        └─ <PresenceIndicator entityType entityUuid>  (highlight ring + badge)
       │     edges: derive | lineage | depends — color + arrow
       │     <Background/> <Controls/> + entity-type filter toggles
       └─ node click → usePanelUrl().openPanel(uuid, tab?) → existing side panel
```

## Data Model

**No schema changes.** Every relationship is an existing field (verified against
`prisma/schema.prisma`):

| Edge kind | Source field | Direction |
|---|---|---|
| derive (idea→proposal) | `Proposal.inputType === "idea"`, `Proposal.inputUuids: Json` (UUID array) | Idea → Proposal |
| derive (proposal→task) | `Task.proposalUuid: String?` (`schema.prisma:257`) | Proposal → Task |
| derive (proposal→document) | `Document.proposalUuid: String?` (`schema.prisma:221`) | Proposal → Document |
| lineage (idea→idea) | `Idea.parentUuid: String?` (`schema.prisma:195`) | parent Idea → child Idea |
| depends (task↔task) | `TaskDependency { taskUuid, dependsOnUuid }` (`schema.prisma:276`) | dependsOn → task |

Note the existing edge-direction convention in `getProjectTaskDependencies()`: it returns
`{ from: taskUuid, to: dependsOnUuid }`, and `task-dag.tsx` maps `edge.source = e.to`,
`edge.target = e.from` so the arrow points from the upstream dependency to the dependent
task. The new service SHALL document its own direction convention explicitly per edge kind
so the renderer is unambiguous.

## Aggregation service contract

A new service function, e.g. `getProjectResourceGraph(companyUuid, projectUuid)`, returns:

```ts
{
  nodes: Array<{
    uuid: string;
    type: "idea" | "proposal" | "task" | "document";
    title: string;
    // parent linkage used to build edges + collapse grouping:
    parentIdeaUuid?: string | null;   // idea lineage parent (idea nodes only)
    proposalUuid?: string | null;     // task/document → proposal
    sourceIdeaUuids?: string[];       // proposal → its input ideas
  }>;
  edges: Array<{
    from: string;
    to: string;
    kind: "derive" | "lineage" | "depends";
  }>;
}
```

- All queries scoped by `companyUuid` AND `projectUuid` (multi-tenancy — never cross
  company/project). Use parallel queries like `getProjectTaskDependencies()`.
- Proposal→entity edges are derived from `Task.proposalUuid` / `Document.proposalUuid`;
  Idea→Proposal edges from `Proposal.inputUuids` filtered to `inputType === "idea"` and to
  ideas present in this project. A Proposal with `inputType === "document"` contributes no
  lineage edge to an Idea (it still appears as a node if it belongs to the project).
- **Proposal→Task `derive` edges are root-task-only.** A Proposal emits a `derive` edge to a
  Task only when that task has no in-proposal dependency (its `dependsOn` set, restricted to
  tasks of the same proposal, is empty — indegree 0 in the dependency DAG). Tasks with
  dependencies are reached transitively via `depends` edges and get no direct Proposal edge.
  Compute each task's in-proposal indegree from the `TaskDependency` rows already queried,
  and emit the Proposal→Task edge only when indegree is 0. **Proposal→Document `derive` edges
  are emitted for every document** (documents have no dependency chain). Rationale: without
  this, every task links to both the Proposal and its neighbor tasks, producing a hairball;
  root-task-only yields a clean Proposal → root task → (depends) → downstream chain.
- Orphan handling: an entity with no relationship still appears as a standalone node.

## Layout: force-directed (the new dependency)

`@xyflow/react` provides rendering and interaction but **no force layout** (it ships only
the helpers; `task-dag.tsx` uses `dagre` for hierarchical layout). The knowledge-graph look
requires organic positioning, so we add `d3-force`:

- Run a `d3-force` simulation (`forceLink` for edges, `forceManyBody` charge for repulsion,
  `forceCenter`, optional `forceCollide` to avoid node overlap) over the **visible** nodes,
  write the resulting `x/y` onto the xyflow nodes, then render. xyflow's drag/zoom/pan stay
  intact; the simulation only seeds positions.
- On expand/collapse, re-run the simulation seeded from current positions (pass existing
  `x/y` as initial `node.x/node.y`, low `alpha`) so the graph settles incrementally instead
  of jumping — preserving the user's mental map.
- **Dependency verification (REQUIRED by the implementing task):** confirm `d3-force` (or
  the chosen sub-package) is pure JS with no native/optional binary bindings, per CLAUDE.md
  pitfall #9, before adding it to `package.json`. d3 modules are pure JS, but the task MUST
  verify against the actual published artifact rather than assume.

## Expand-to-derive (collapse grouping)

- Client state: a `Set<string>` of expanded Idea UUIDs (default empty = all Ideas
  collapsed). A collapsed Idea contributes only its hub node to the visible set; its
  derivatives (Proposals, and their Tasks/Documents) are hidden.
- A collapsed Idea node shows a count pill `N ›` where N = number of direct derivatives
  hidden. Expanding adds that Idea's Proposal/Task/Document nodes (and the edges among them)
  to the visible set and flips the affordance to a chevron-down.
- Leaf nodes (a Task or Document with no further derivatives in the four-type model) show
  no expand affordance.
- Idea→Idea lineage edges connect Idea hubs regardless of expand state, so lineage is always
  visible; derive/depends edges appear only when their endpoints are visible.

## Node rendering

A custom xyflow node type (modeled on `TaskNode` in `task-dag.tsx:69`) renders, per node:

- a colored chip + lucide icon and an IBM Plex Mono eyebrow label of the type
  (IDEA / PROPOSAL / TASK / DOCUMENT) — type is the only categorical encoding (q5 = type
  only, no status badge);
- the entity title;
- for a collapsed Idea, the `N ›` count pill; for an expanded Idea, a chevron-down; nothing
  for leaves.

Type → color/icon mapping (from the design): Idea `#7C4DFF`/`lightbulb`, Proposal
`#2563EB`/`clipboard-list`, Task `#E8833A`/`check-square`, Document `#00897B`/`file-text`.

## Presence highlighting (reuse, do not rebuild)

The presence signal is already entity-addressed and view/mutate-typed:

- `PresenceEvent` (`src/lib/event-bus.ts:20`) carries `{ entityType: "task"|"idea"|
  "proposal"|"document", entityUuid, agentUuid, agentName, action: "view"|"mutate" }`.
  Emission is auto-wired around MCP tools in `src/mcp/tools/presence.ts`: tool names
  prefixed `chorus_get_`/`chorus_list_`/`chorus_search` classify as `view`, everything
  else as `mutate`; the entity is detected from `taskUuid`/`ideaUuid`/`proposalUuid`/
  `documentUuid` params. Throttle is ~2s (`THROTTLE_WINDOW_MS = 2000`).
- Delivery: SSE `type: "presence"` events (`src/app/api/events/route.ts`), filtered by
  `companyUuid` and `projectUuid`, consumed via `usePresence()`
  (`src/hooks/use-presence.ts:144`), which exposes
  `getPresence(entityType, entityUuid) → PresenceEntry[]` (each `{ agentUuid, agentName,
  action, timestamp }`).
- Each graph node wraps its content in `PresenceIndicator`
  (`src/components/ui/presence-indicator.tsx`), which already implements the exact V1
  visual: `outline: 2px <solid|dashed> <agentColor>` where **mutate → solid, view →
  dashed** (mutate takes precedence), plus up to three agent avatar badges with a `+N`
  overflow. So the q9 "dashed=read / solid=write" and q8 "outline + avatar badge"
  decisions are satisfied by reuse — no new presence visuals.

> **Provider placement (verified):** the project pages render **inside**
> `RealtimeProvider projectUuid={currentProjectUuid}` (`src/app/(dashboard)/layout.tsx`),
> and `usePresence()` subscribes via `RealtimeContext` — so it is available at
> `/projects/[uuid]/graph`. This is the per-entity presence signal, distinct from
> `AgentPresenceProvider` (daemon executions); V1 uses only the former (q7 = a). Confirm
> during implementation that the canvas mounts within `RealtimeProvider`.

## Live structural updates (reuse the same realtime stream)

Presence highlighting is not the only thing the graph derives from the realtime stream: the
graph's **structure** must also stay live. Because the canvas already sits inside
`RealtimeProvider` and subscribes to the project SSE for presence, it also subscribes to that
provider's **entity-change** delivery (`src/contexts/realtime-context.tsx`,
`src/app/api/events/route.ts`) — the same mechanism the project's list pages use to live-update.

- On an entity-change event (idea/proposal/task/document created, deleted, updated; a
  `TaskDependency` added/removed; an idea reparented), the canvas reconciles its node/edge
  sets. The V1-acceptable approach is **re-fetch the aggregation and reconcile** into the
  current sets; a targeted in-place patch is a nice-to-have, not required.
- Reconciliation feeds current node positions as `prevPositions` into the `layout()` module
  so surviving nodes settle incrementally (new nodes get placed, removed nodes drop) — never a
  full re-randomize — and preserves the user's expand/collapse state where the affected Idea
  subgraph is still present.
- This is **distinct from presence highlighting**: presence changes only a node's
  outline/badge; live structural update changes the *set* of nodes and edges. A dependency
  change must also re-evaluate the Proposal→root-task `derive` edges (a task gaining/losing a
  dependency can change its root status).

> **Implementation note:** confirm the actual entity-change event shape + subscription hook on
> `RealtimeContext` against the real files before wiring — do not assume an event name. If the
> stream today only carries presence, wire to whatever entity-change/invalidation signal the
> project list pages already use to live-update.

## Node-click side panels (reuse the existing panels)

Click opens a docked side panel via `usePanelUrl` (`src/hooks/use-panel-url.ts`), reusing
existing components by entity type:

| Node type | Panel | How to open |
|---|---|---|
| Idea | `IdeaDetailPanel` | `openPanel(ideaUuid)` → `?panel=<uuid>` |
| Proposal | idea-tracker **Proposal tab** | `openPanel(ideaUuid, "proposal")` → `?panel=<uuid>&tab=proposal` |
| Task | `TaskDetailPanel` | open by task UUID (panel is state-driven; fetch task, render `mode="sidebyside"` on wide screens) |
| Document | `DocumentPanel` (`.../dashboard/panels/document-panel.tsx`, already standalone — props only, no internal fetch) | open with `{ title, type, content }` |

> **usePanelUrl seeding pitfall (known):** `initialSelectedId` must seed only on first
> render (`hasRenderedRef` gate); after closing a deep-linked `?panel=`, `searchParams` is
> the sole source of truth, else the panel re-sticks open. The implementing task MUST
> preserve that gate when wiring graph-node clicks through `usePanelUrl`.

The graph stays mounted while the panel is docked, and the selected node keeps a highlight
ring, so exploration continues. A Proposal node maps to its **source Idea**'s tracker on the
Proposal tab (proposals have no standalone panel); if a Proposal has multiple source ideas,
open the first project-local one and document this choice.

## Module Contracts

- **Aggregation result**: `{ nodes, edges }` exactly as in "Aggregation service contract"
  above; `kind` on every edge; direction documented per kind.
- **REST route**: `GET /api/projects/[uuid]/resource-graph` → `{ success, data: { nodes,
  edges } }` via the standard `withErrorHandler` + `success()` helpers; auth-scoped to the
  caller's `companyUuid`.
- **Graph node data** (xyflow `data`): `{ uuid, type, title, derivativeCount, expanded,
  isLeaf }` — enough for the node renderer + presence lookup; presence is read via the hook
  inside the node, not threaded through props.
- **Layout module**: a pure function `layout(nodes, edges, prevPositions?) → Map<uuid,
  {x,y}>` wrapping `d3-force`, so it is unit-testable without React.

## i18n

All new user-facing strings via `t()` in both `messages/en.json` and `messages/zh.json`:
`nav.graph` (en "Graph" / zh "图谱"), legend labels (node types, the three relationship
kinds, presence view/edit), entity-type filter labels, the expand/collapse affordance
tooltip, and an empty-state message for a project with no entities. Follows the CRITICAL
i18n rule; server nav label read in the dashboard layout, canvas strings via
`useTranslations()`.

## Implementation Plan

1. **Aggregation service + REST route** — `getProjectResourceGraph()` and
   `GET /api/projects/[uuid]/resource-graph`; the contract + tests are the foundation
   everything else consumes.
2. **Nav entry + route page** — `nav.graph` in `getProjectNavItems` (+ i18n), and the
   `graph/page.tsx` server route delegating to the client canvas.
3. **Force layout module + graph canvas** — add and verify `d3-force`; the
   `layout()` function; the `ResourceGraph` client component rendering nodes/edges with the
   three edge kinds and the entity-type filter.
4. **Custom node + expand-to-derive** — the node renderer (type chip/eyebrow, count pill ↔
   chevron) and the collapse-state model that adds/removes a subgraph on expand.
5. **Presence highlighting** — wrap nodes in `PresenceIndicator` driven by `usePresence()`.
6. **Side-panel wiring** — node click → `usePanelUrl` → the four existing panels.
7. **Integration checkpoint** — end-to-end on a real project: aggregation → render →
   expand → presence highlight → open each of the four panel types.

## Risks & Mitigations

- **New dependency violating the no-native-bindings rule** — `d3-force` is pure JS, but the
  layout task MUST verify the published artifact before adding (CLAUDE.md pitfall #9).
  Fallback: if any issue, the existing `dagre` stack can produce a (less organic) layered
  layout without a new dependency.
- **Large projects / many nodes** — V1 mitigates density by collapsing Ideas by default
  (only hubs visible until expanded). If a single expanded Idea is still heavy, the
  force simulation is bounded by tick count; a hard node-cap warning is out of V1 scope but
  noted.
- **Presence ring inside a zoom/pan canvas** — `PresenceIndicator` uses `outline`, which is
  not affected by xyflow transforms the way layout would be; verify the badge stays legible
  at low zoom (it may be acceptable to let badges scale with the canvas).
- **Edge-direction confusion** — reuse of `getProjectTaskDependencies`'s `{from,to}`
  convention is a known foot-gun; the new service documents direction per `kind` and the
  renderer maps explicitly, with a test asserting arrow direction for each kind.
- **Panel reuse coupling** — Task and Document panels are state-driven (not URL-driven) in
  some hosts; ensure the graph host provides the same open/close state contract the panels
  expect, and preserve the `usePanelUrl` `hasRenderedRef` seeding gate.

## Verification anchors

`src/components/task-dag.tsx` (`getLayoutedElements`, `TaskNode`, `nodeTypes`, edge
styling), `src/services/task.service.ts:1349` (`getProjectTaskDependencies`),
`prisma/schema.prisma` (`Idea.parentUuid:195`, `Document.proposalUuid:221`,
`Task.proposalUuid:257`, `TaskDependency:276`, `Proposal.inputType/inputUuids`),
`src/app/(dashboard)/layout.tsx:248` (`getProjectNavItems`, `RealtimeProvider` placement),
`src/lib/event-bus.ts:20` (`PresenceEvent`), `src/mcp/tools/presence.ts` (view/mutate
classification), `src/app/api/events/route.ts` (SSE), `src/hooks/use-presence.ts:144`
(`usePresence`), `src/components/ui/presence-indicator.tsx` (solid/dashed + badges),
`src/hooks/use-panel-url.ts` (`usePanelUrl`, seeding gate),
`src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx`,
`.../tasks/task-detail-panel.tsx`, `.../dashboard/panels/document-panel.tsx`,
`.../dashboard/panels/idea-detail-panel.tsx` (Proposal tab), `messages/en.json` +
`messages/zh.json` (`nav`).
