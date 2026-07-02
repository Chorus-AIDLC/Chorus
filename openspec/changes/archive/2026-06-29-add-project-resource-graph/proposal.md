# Project resource graph: a per-project knowledge-graph view of Ideas, Proposals, Tasks and Documents

## Why

A Chorus project accumulates a web of AI-DLC entities: multiple Ideas, each deriving
Proposals, each materializing Documents and Tasks, with Task→Task dependency DAGs and
Idea→Idea lineage on top. Today those entities live in separate list pages (tasks /
ideas / proposals / documents tabs). A person has to reconstruct "how is this project
wired together" in their head:

- you cannot see which Proposals an Idea spawned, or which Tasks/Documents it materialized;
- you cannot trace where a given Document or Task came from;
- the Task dependency DAG is only visible per-task in the task detail, never project-wide.

The rendering stack to fix this already exists. The task dependency DAG
(`src/components/task-dag.tsx`) renders nodes + edges with `@xyflow/react` 12 and lays
them out with `dagre` (`getLayoutedElements`), fed by a project-level aggregation service
`getProjectTaskDependencies()` (`src/services/task.service.ts:1349`). Every relationship
this view needs is already a queryable field: `Idea.parentUuid` (lineage),
`Proposal.inputType`/`inputUuids` (idea→proposal), `Task.proposalUuid` and
`Document.proposalUuid` (materialization back-links), and the `TaskDependency` model
(task↔task DAG). Agent presence is already plumbed end-to-end: `PresenceEvent` on the
event bus (`src/lib/event-bus.ts:20`), an SSE stream (`src/app/api/events/route.ts`), the
`usePresence()` hook (`src/hooks/use-presence.ts:144`), and a `PresenceIndicator`
component (`src/components/ui/presence-indicator.tsx`) that already renders the
view-vs-mutate distinction (dashed vs solid outline) plus per-agent avatar badges.

So this change is mostly **composition**: aggregate the four entity types + their
relationships into one graph payload, render it as a knowledge graph, and wire in the two
interactions that already have homes elsewhere (presence highlight, side-panel preview).

## What Changes

- **New per-project "Graph / 图谱" left-nav tab** at `/projects/[uuid]/graph`, added to
  `getProjectNavItems` (`src/app/(dashboard)/layout.tsx:248`) with a `Network` lucide icon
  and a new `nav.graph` i18n key in both locales.
- **A new aggregation service** that, given `companyUuid` + `projectUuid`, returns the
  four entity types as typed graph nodes and their relationships as typed edges. Modeled
  on `getProjectTaskDependencies()` but spanning Idea/Proposal/Task/Document.
- **A knowledge-graph canvas** (a new client component) that renders the payload with the
  existing `@xyflow/react` stack but laid out **force-directed** (organic node-link web,
  Ideas as hubs) rather than as a rigid tree. `@xyflow/react` has no built-in force layout,
  so this adds one pure-JS dependency (`d3-force`) — see Impact.
- **Three relationship edge kinds**, distinguished by color + arrow direction: *derive*
  (Idea→Proposal→Task/Document), *lineage* (Idea→Idea), *depends-on* (Task↔Task). To keep
  the graph legible, a Proposal links by *derive* only to its **root tasks** (tasks with no
  in-proposal dependency); dependent tasks are reached through the *depends* chain, not a
  second edge back to the Proposal. (Proposal→Document derive edges cover every document.)
- **Live structural updates.** Beyond presence highlighting, the graph re-renders in real
  time as entities are created / deleted / updated and as dependencies or lineage change,
  reusing the same project realtime stream — surviving nodes keep their positions and the
  user's expand/collapse state is preserved.
- **Expand-to-derive subgraphs.** By default each Idea renders as a collapsed hub showing
  a count pill (`N ›`) of its hidden derivatives. Clicking expands it: its Proposals, and
  their Tasks/Documents, bloom as a local sub-cluster. This is the V1 answer to "grouped
  by Idea, collapsed by default."
- **Type-only node styling** (chip color + icon + mono eyebrow IDEA/PROPOSAL/TASK/DOCUMENT);
  no status badge on the node — status is seen in the side panel.
- **Agent-presence highlighting.** When any agent operates on an entity, its node
  highlights in real time, reusing `PresenceIndicator`: dashed outline = a viewing agent,
  solid outline = a mutating agent, plus the agent avatar badge.
- **Node click opens a side preview panel**, reusing existing panels rather than building
  new ones: Idea and Task open their existing detail panels; Proposal opens the
  idea-tracker Proposal tab; Document opens the standalone document panel.
- **Filter by entity type** — toggles to show/hide each of the four node types.

## Capabilities

- **project-resource-graph** — adds normative requirements for a per-project graph route
  and nav entry; a project-scoped aggregation of the four entity types and their three
  relationship kinds; a force-directed knowledge-graph rendering with per-Idea
  expand/collapse; type-based node styling and an entity-type filter; agent-presence node
  highlighting reusing the existing presence signal and indicator; and node-click side
  panels that reuse the existing Idea/Task/Proposal/Document panels.

## Impact

- **Affected / new code:**
  - `src/app/(dashboard)/layout.tsx` — add the `nav.graph` item to `getProjectNavItems`.
  - `src/app/(dashboard)/projects/[uuid]/graph/page.tsx` (new) — server route page,
    mirrors the existing tasks/documents page convention (`params: Promise<{uuid}>`).
  - A new graph canvas client component (e.g. `resource-graph.tsx`) + a custom xyflow node
    type, reusing the `@xyflow/react` + `ReactFlow`/`Background`/`Controls` setup and the
    `Graph Node` visual from `task-dag.tsx`.
  - A new aggregation service (e.g. `getProjectResourceGraph()` in
    `src/services/` ) + its REST route, returning `{ nodes, edges }`.
  - Reuse `PresenceIndicator` (`src/components/ui/presence-indicator.tsx`) and
    `usePresence()` (`src/hooks/use-presence.ts`) for node highlighting.
  - Reuse the existing side panels via `usePanelUrl` (`src/hooks/use-panel-url.ts`):
    `IdeaDetailPanel`, `TaskDetailPanel`, the idea-tracker Proposal tab, and `DocumentPanel`.
  - `messages/en.json` + `messages/zh.json` — `nav.graph` and all new graph UI strings
    (legend labels, filter labels, empty state) in both locales.
- **New dependency:** `d3-force` (force-directed layout). It is pure JavaScript with no
  native bindings, so it satisfies the cross-platform constraint (CLAUDE.md pitfall #9);
  the implementing task MUST re-verify this against the published package before adding it.
  `@xyflow/react` (`^12.10.0`) and `dagre` (`^0.8.5`) are already dependencies.
- **No database schema change.** All relationships are existing fields
  (`Idea.parentUuid`, `Proposal.inputUuids`, `Task.proposalUuid`, `Document.proposalUuid`,
  `TaskDependency`). All queries are scoped by `companyUuid` (multi-tenancy).
- **Out of scope (V1):** AcceptanceCriterion and Comment nodes (four types only);
  force-directed ⇄ layered layout toggle (force-directed only); relationship-type filter,
  full-text search-to-highlight, and status filter (entity-type filter only); persisting a
  laid-out position per node; daemon-execution presence as a distinct highlight (the
  view/mutate presence signal covers V1). Live structural updates reuse the existing project
  realtime stream — no new transport or event type is introduced.
