"use client";

// Project Resource Graph canvas — Wave 4 (node-click side panels).
//
// Builds on Wave 3's rendering backbone (rich custom node + per-Idea
// expand/collapse). Wave 4 adds:
//   - usePanelUrl-driven side panels for Idea and Proposal (mirrors the
//     idea-tracker host's open/close mechanism; `?panel=<uuid>` is the
//     single source of truth post-first-render, preserving the
//     hasRenderedRef seeding gate inside the hook).
//   - State-driven TaskDetailPanel + DocumentPanel hosts (mirrors the
//     IdeaDetailPanel-as-host pattern in dashboard/panels/idea-detail-panel
//     — these two panels take props, not URL).
//   - Click → panel mapping:
//       idea     → IdeaDetailPanel via openPanel(uuid)
//       proposal → idea-tracker Proposal tab via openPanel(sourceIdeaUuid, "proposal")
//                  (uses node.sourceIdeaUuids[0] — the first project-local source
//                  idea, since the aggregation already filtered out cross-project
//                  ones; if a proposal has multiple project-local source ideas,
//                  the first wins.)
//       task     → TaskDetailPanel (state-driven; fetch + render)
//       document → DocumentPanel   (state-driven; fetch + render)
//   - Idea expand/collapse affordance: a click on the chevron / "N ›" pill
//     toggles the subgraph instead of opening the panel. Detection is via
//     the affordance's data-testid set in resource-graph-node.tsx; falling
//     back to a normal click means leaf Ideas (no affordance) always open
//     the panel.
//
// The graph stays mounted while any panel is open and the clicked node
// keeps its xyflow `selected` outline (already rendered inside the node
// component via the `selected` prop), so closing returns to the same view.
//
// Edge direction mirrors the aggregation contract — `from` → source,
// `to` → target — so the arrowhead lands on the downstream entity in every
// kind:
//   lineage : parentIdea -> childIdea     (violet  #7C4DFF)
//   derive  : source     -> derivative    (neutral #CFC6B6)
//   depends : dependsOn  -> dependent     (amber   #E8833A)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import {
  Lightbulb,
  ClipboardList,
  CheckSquare,
  FileText,
  Maximize2,
  Minimize2,
  Search,
  X,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnimatedEmptyState } from "@/components/animated-empty-state";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { useIsMobile } from "@/hooks/use-mobile";
import { isImeComposing } from "@/lib/ime";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { computeVisibleSet } from "@/lib/resource-graph-visible-set";
import {
  computeSearchMatches,
  expandAncestorsForMatches,
  orderMatchIdsByOutline,
} from "@/lib/resource-graph-search";
import { computeTreeLayout } from "@/lib/resource-graph-tree-layout";
import { shouldShowExpandAffordance } from "./expand-affordance";
import { MindMapOutline } from "./mindmap-outline";
import type {
  ResourceGraphResult,
  ResourceGraphNodeType as NodeType,
} from "@/services/resource-graph.service";
import { clientLogger } from "@/lib/logger-client";
import { IdeaDetailPanel } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel";
import { TaskDetailPanel } from "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel";
import { DocumentPanel } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/document-panel";
import { getTaskAction } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/actions";
import type { ForceNode, ForceLink } from "./mindmap-canvas";

// The mind-map canvas paints to a DOM <canvas> and uses ResizeObserver at
// mount, so it must be client-only. Dynamic import with ssr:false keeps it out
// of the server bundle; the rest of this component (data, panels, filter) is
// SSR-safe.
const ForceGraphCanvas = dynamic(
  () => import("./mindmap-canvas").then((m) => m.ForceGraphCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-[#6B6B6B]">
        …
      </div>
    ),
  },
);

// Per-type filter swatch (just a small color dot). The rich type colors
// live inside the node painter; this is purely for the filter UI.
const FILTER_SWATCH: Record<NodeType, { color: string; Icon: typeof Lightbulb }> = {
  idea: { color: "#7C4DFF", Icon: Lightbulb },
  proposal: { color: "#2563EB", Icon: ClipboardList },
  task: { color: "#E8833A", Icon: CheckSquare },
  document: { color: "#00897B", Icon: FileText },
};

// --- Component -------------------------------------------------------------

interface ResourceGraphProps {
  projectUuid: string;
  /** Resolved server-side from auth; needed by IdeaDetailPanel + TaskDetailPanel. */
  currentUserUuid: string;
}

type VisibleTypes = Record<NodeType, boolean>;

const ALL_VISIBLE: VisibleTypes = {
  idea: true,
  proposal: true,
  task: true,
  document: true,
};

// Task shape needed by TaskDetailPanel — same prop contract as the host in
// dashboard/panels/idea-detail-panel.tsx (kept in sync; if that surface
// changes, this needs to track it).
interface TaskForPanel {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria?: string | null;
  acceptanceCriteriaItems?: {
    uuid: string;
    description: string;
    required: boolean;
    devStatus: string;
    devEvidence: string | null;
    status: string;
    evidence: string | null;
    sortOrder: number;
  }[];
  acceptanceStatus?: string;
  acceptanceSummary?: {
    total: number;
    required: number;
    passed: number;
    failed: number;
    pending: number;
    requiredPassed: number;
    requiredFailed: number;
    requiredPending: number;
  };
  proposalUuid: string | null;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  dependsOn?: { uuid: string; title: string; status: string }[];
  dependedBy?: { uuid: string; title: string; status: string }[];
}

interface DocumentForPanel {
  title: string;
  type: string;
  content: string;
}

export function ResourceGraph({ projectUuid, currentUserUuid }: ResourceGraphProps) {
  const t = useTranslations();

  // Responsive renderer switch (Tech Design D2/D3). Reuses the project's
  // existing breakpoint convention — the `useIsMobile` hook matches
  // `(max-width: 767px)`, the same boundary the dashboard layout uses for its
  // mobile chrome. On a narrow viewport we render the DOM vertical indented
  // outline; on a wide viewport, the Canvas-2D mind-map. Both consume the SAME
  // forceNodes/forceLinks + the SAME shared expand state, so flipping size
  // preserves the user's expansion (it lives here, not in either renderer).
  const isMobile = useIsMobile();

  const [graph, setGraph] = useState<ResourceGraphResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<VisibleTypes>(ALL_VISIBLE);

  // URL-driven panels: Idea (single-uuid) and Proposal (uuid of the source
  // idea + tab=proposal). Mirrors idea-tracker.tsx — the dashboard host that
  // already drives the same two panels off ?panel= and ?tab=.
  //
  // Seed `initialSelectedId` with null on purpose: the graph route has no
  // server-side selected entity to pre-pick, so there's no SSR seed to leak.
  // `hasRenderedRef` inside usePanelUrl is what actually prevents the seed
  // from re-sticking past first paint; passing null keeps the URL the sole
  // source of truth from frame 0 onward, but the test pitfall
  // (`null ?? initialSelectedId` re-opening after close) only matters when
  // there IS an SSR seed. Passing `null` is the right choice here AND
  // preserves the gate inside the hook untouched.
  const basePath = `/projects/${projectUuid}/graph`;
  // `selectedTab` is left to the IdeaDetailPanel to consume — it reads
  // ?tab from URLSearchParams itself (idea-detail-panel.tsx, urlTabRef).
  // Pulling it here too would cost a render with no consumer.
  const {
    selectedId: urlPanelUuid,
    openPanel,
    closePanel,
  } = usePanelUrl(basePath, null);

  // State-driven panels: Task + Document panels are not URL-routed in
  // their existing hosts (see dashboard/panels/idea-detail-panel.tsx —
  // openTask / openDoc use setState there too). We mirror that here so the
  // panels behave identically to elsewhere in the app.
  const [selectedTaskUuid, setSelectedTaskUuid] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskForPanel | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocumentForPanel | null>(null);

  // Set<ideaUuid> of currently-expanded Ideas. Empty default = every Idea
  // is collapsed (only Idea hubs render). Storing as Set (not array) so
  // toggle is O(1); React change detection relies on the wrapper Set being
  // a fresh reference on each mutation.
  const [expandedIdeas, setExpandedIdeas] = useState<Set<string>>(
    () => new Set(),
  );

  // Two-level expand model: an expanded Idea reveals its Proposals (level 1);
  // an expanded Proposal reveals its Tasks + Documents (level 2). Tracked in a
  // separate Set so each proposal expands independently of its idea.
  const [expandedProposals, setExpandedProposals] = useState<Set<string>>(
    () => new Set(),
  );

  // --- Node search state (Tech Design D1/D3/D5/D6) --------------------------
  // The search state lives HERE (not in either renderer) for the same reason
  // expand state does: both the canvas and the mobile outline must read the
  // SAME query, match set, and current-match cursor, so flipping viewport size
  // preserves the active search. `searchQuery` is the raw input; the derived
  // match set + ordered match list + current-match id are computed below
  // (after the visible-set memo, since ordering follows the layout outline).
  const [searchQuery, setSearchQuery] = useState("");
  // Index into the OUTLINE-ORDERED match list (normalized with wrap-around on
  // read, so prev/next can freely increment/decrement past the ends).
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  // Debounced "center the camera on this node" signal handed to the canvas.
  // Set on query-settle (first match) and on each prev/next step; the canvas
  // reacts to a change by centering. (The canvas centering itself is wired in a
  // sibling task; here we only own + pass the signal.)
  const [centerNodeId, setCenterNodeId] = useState<string | null>(null);

  // Live mirrors of the expand sets so the snapshot effect can read the CURRENT
  // values at the blank→non-blank edge without listing them as deps (which would
  // re-run the effect on every auto-expand). Refs, not deps — capture-on-demand.
  const expandedIdeasRef = useRef(expandedIdeas);
  expandedIdeasRef.current = expandedIdeas;
  const expandedProposalsRef = useRef(expandedProposals);
  expandedProposalsRef.current = expandedProposals;
  // Snapshot of the expand sets captured when a search session BEGINS, restored
  // when it ends (Q4=a). null = no active snapshot. `wasSearchingRef` tracks the
  // previous searching state so the snapshot effect fires only on the edges.
  const expandSnapshotRef = useRef<{
    ideas: Set<string>;
    proposals: Set<string>;
  } | null>(null);
  const wasSearchingRef = useRef(false);

  // Layout is owned by the mind-map canvas, which computes deterministic
  // d3-hierarchy tree coordinates from the visible node/link set and tweens
  // nodes to them (surviving nodes glide old→new, so expand/collapse + live
  // updates settle smoothly rather than re-randomizing). This component no
  // longer pre-computes layout — it only decides which nodes/links are
  // visible and hands them down.

  // Track the most recent in-flight fetch so a slower stale response can't
  // overwrite a fresher one. Each call bumps the token; only the call that
  // still owns the latest token applies its result.
  const fetchTokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Reload the aggregation payload. Reused by:
  //   - the initial / project-change fetch (full reset path)
  //   - SSE entity-change events (live reconcile path — preserves expand
  //     state + prevPositions so the layout settles incrementally)
  //
  // We do NOT clear `graph` between reloads on the reconcile path — the
  // canvas stays mounted and just swaps to the new aggregation, which the
  // layout memo then folds into the existing positions. On error we keep
  // showing the last good graph and surface the message via setError.
  const reloadGraph = useCallback(async () => {
    // Cancel the previous in-flight request before issuing a new one — the
    // server holds an open response per fetch, and a rapid burst of SSE
    // events would otherwise pile them up.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const token = ++fetchTokenRef.current;

    try {
      const res = await fetch(`/api/projects/${projectUuid}/resource-graph`, {
        signal: ac.signal,
      });
      const json: {
        success: boolean;
        data?: ResourceGraphResult;
        error?: string;
      } = await res.json();
      if (ac.signal.aborted || token !== fetchTokenRef.current) return;
      if (!res.ok || !json.success || !json.data) {
        setError(json.error ?? t("graph.loadFailed"));
        return;
      }
      const next = json.data;
      // Prune expand state to the surviving uuids so an Idea deleted while
      // expanded doesn't linger in expandedIdeas. (The canvas prunes its own
      // retained positions by id; the visible-set computation also tolerates
      // stale uuids defensively — this is hygiene, not correctness.)
      const aliveUuids = new Set(next.nodes.map((n) => n.uuid));
      const pruneToAlive = (prev: Set<string>) => {
        let mutated = false;
        const out = new Set<string>();
        for (const u of prev) {
          if (aliveUuids.has(u)) out.add(u);
          else mutated = true;
        }
        return mutated ? out : prev;
      };
      setExpandedIdeas(pruneToAlive);
      setExpandedProposals(pruneToAlive);
      setError(null);
      setGraph(next);
    } catch (err) {
      if (ac.signal.aborted || token !== fetchTokenRef.current) return;
      // Surface the failure rather than silently swallowing it
      // (see feedback_no_silent_errors). On a reconcile path we keep the
      // previously-rendered graph so the user doesn't lose context — they
      // see a stale view plus the error banner.
      // eslint-disable-next-line no-console
      console.error("[resource-graph] fetch failed", err);
      setError(t("graph.loadFailed"));
    }
  }, [projectUuid, t]);

  // Initial / project-change fetch. Full reset path: clears the current
  // graph + expand state because the entire graph is foreign on a project
  // switch. The reconcile path (SSE handlers below) does NOT come through
  // here — it calls reloadGraph() directly so expandedIdeas survives across
  // the refetch.
  useEffect(() => {
    setError(null);
    setGraph(null);
    setExpandedIdeas(new Set());
    setExpandedProposals(new Set());
    // Reset the search session too — the whole graph is foreign on a project
    // switch, so any active query/snapshot is meaningless.
    setSearchQuery("");
    setCurrentMatchIndex(0);
    setCenterNodeId(null);
    expandSnapshotRef.current = null;
    wasSearchingRef.current = false;
    void reloadGraph();
    return () => {
      abortRef.current?.abort();
    };
  }, [projectUuid, reloadGraph]);

  // Live structural updates. Subscribe to the existing project SSE stream
  // for each of the four entity types the graph renders (and reuses on the
  // depends/lineage edges). On any change we re-fetch the aggregation and
  // reconcile into the current node/edge sets via the layout's
  // prevPositions seeding — surviving nodes keep their positions, new
  // nodes settle around them, removed nodes drop out, and expand state is
  // preserved (AC #1, #2, #3).
  //
  // Hook contract (verified against src/contexts/realtime-context.tsx):
  // useRealtimeEntityTypeEvent does NOT fire on mount — only on matching
  // SSE events — and is already debounced 300ms per entity type by the
  // provider itself, so a burst of e.g. task creates collapses to one
  // refetch per type. No-ops gracefully outside RealtimeProvider, which
  // matches the test-mock idiom used by IdeaTracker + ProposalKanban etc.
  //
  // We subscribe to all four types separately (rather than one omnibus
  // hook) to match the existing app idiom (see idea-tracker-list.tsx,
  // dashboard/panels/idea-detail-panel.tsx). Each fires reloadGraph;
  // because reloadGraph cancels any in-flight previous request, an idea
  // event chased by a proposal event 50ms later turns into one final
  // request.
  useRealtimeEntityTypeEvent("idea", reloadGraph);
  useRealtimeEntityTypeEvent("proposal", reloadGraph);
  useRealtimeEntityTypeEvent("task", reloadGraph);
  useRealtimeEntityTypeEvent("document", reloadGraph);

  const toggleType = useCallback((type: NodeType) => {
    setVisible((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  // Toggle a hub's expand state. Routes by type: Ideas expand to Proposals
  // (level 1), Proposals expand to Tasks + Documents (level 2). Collapsing an
  // Idea also collapses every Proposal underneath it, so re-expanding the
  // Idea shows its proposals collapsed again (no stale level-2 state lingers).
  const toggleHubExpand = useCallback(
    (id: string, type: NodeType) => {
      if (type === "idea") {
        setExpandedIdeas((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
            // Collapse child proposals of this idea too.
            const childProposalUuids = (graph?.nodes ?? [])
              .filter(
                (n) =>
                  n.type === "proposal" &&
                  (n.sourceIdeaUuids ?? []).includes(id),
              )
              .map((n) => n.uuid);
            if (childProposalUuids.length > 0) {
              setExpandedProposals((p) => {
                let mutated = false;
                const out = new Set(p);
                for (const u of childProposalUuids) {
                  if (out.delete(u)) mutated = true;
                }
                return mutated ? out : p;
              });
            }
          } else {
            next.add(id);
          }
          return next;
        });
      } else if (type === "proposal") {
        setExpandedProposals((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
    },
    [graph],
  );

  // Whether anything is currently expanded — drives the single toolbar button's
  // mode (Expand all when fully collapsed, Collapse all otherwise).
  const anyExpanded = expandedIdeas.size > 0 || expandedProposals.size > 0;

  // Expand / collapse EVERYTHING in one action. "Expand all" reveals every hub
  // at both levels — every Idea (so its Proposals show) and every Proposal (so
  // its Tasks + Documents show). We expand all Ideas/Proposals present in the
  // aggregation regardless of the current type filter (the filter only hides
  // already-revealed nodes; it must not silently strand a hub collapsed). The
  // visible-set computation gates child visibility on the parent being visible,
  // so over-including here is safe. "Collapse all" just clears both sets.
  const expandAll = useCallback(() => {
    if (!graph) return;
    const ideaUuids = new Set<string>();
    const proposalUuids = new Set<string>();
    for (const n of graph.nodes) {
      if (n.type === "idea") ideaUuids.add(n.uuid);
      else if (n.type === "proposal") proposalUuids.add(n.uuid);
    }
    setExpandedIdeas(ideaUuids);
    setExpandedProposals(proposalUuids);
  }, [graph]);

  const collapseAll = useCallback(() => {
    setExpandedIdeas(new Set());
    setExpandedProposals(new Set());
  }, []);

  // Filter -> expand/collapse visible set -> ForceGraph data.
  //
  // Order matters: the type filter is applied AFTER the expand/collapse
  // visible set is computed, so hiding e.g. all Tasks doesn't change the
  // derivative count shown on an Idea's pill (the pill counts *direct*
  // derivatives by structure, not by what's currently rendered — matches
  // the spec scenario "a count of its hidden direct derivatives").
  //
  // No layout call here: the mind-map canvas computes deterministic tree
  // coordinates from this visible node/link set (via computeTreeLayout) and
  // tweens nodes to them — no physics, so identical inputs settle identically.
  const { forceNodes, forceLinks, isEmpty } = useMemo(() => {
    if (!graph) {
      return {
        forceNodes: [] as ForceNode[],
        forceLinks: [] as ForceLink[],
        isEmpty: true,
      };
    }

    const { visibleNodeUuids, visibleEdgeIndices, childCountByHub } =
      computeVisibleSet(graph, expandedIdeas, expandedProposals);

    const visibleNodes = graph.nodes.filter(
      (n) => visibleNodeUuids.has(n.uuid) && visible[n.type],
    );
    const visibleUuids = new Set(visibleNodes.map((n) => n.uuid));
    const visibleEdges = visibleEdgeIndices
      .map((i) => graph.edges[i])
      .filter((e) => visibleUuids.has(e.from) && visibleUuids.has(e.to));

    // Sets used to resolve each node's nesting OWNER for the canvas's cluster
    // force (so each idea's resources group around it). Built from the FULL
    // graph (not just visible) so the owner is stable regardless of expand
    // state. Idea hub = cluster root; proposal nests under its first
    // project-local source idea; task/document nests under its proposal.
    const ideaUuidSet = new Set(
      graph.nodes.filter((n) => n.type === "idea").map((n) => n.uuid),
    );
    const proposalSourceIdea = new Map<string, string | undefined>();
    for (const n of graph.nodes) {
      if (n.type !== "proposal") continue;
      const firstLocal = (n.sourceIdeaUuids ?? []).find((u) =>
        ideaUuidSet.has(u),
      );
      proposalSourceIdea.set(n.uuid, firstLocal);
    }
    const proposalUuidSet = new Set(proposalSourceIdea.keys());

    const ownerOf = (n: (typeof visibleNodes)[number]): string | undefined => {
      if (n.type === "proposal") {
        // Nest the proposal directly under its source idea hub.
        return proposalSourceIdea.get(n.uuid);
      }
      if (n.type === "task" || n.type === "document") {
        // Nest under the proposal (the proposal in turn nests under the idea,
        // giving a two-level cluster). Only if the proposal is a graph node.
        const p = n.proposalUuid ?? undefined;
        return p && proposalUuidSet.has(p) ? p : undefined;
      }
      // idea hubs (and any orphan) have no owner — they are cluster roots.
      return undefined;
    };

    const nodesOut: ForceNode[] = visibleNodes.map((n) => {
      // Both Idea and Proposal are expandable hubs (two-level model). Their
      // child count + expanded state drive the +/- button; Tasks/Documents
      // are leaves.
      const isHub = n.type === "idea" || n.type === "proposal";
      const childCount = isHub ? childCountByHub.get(n.uuid) ?? 0 : undefined;
      const expanded =
        n.type === "idea"
          ? expandedIdeas.has(n.uuid)
          : n.type === "proposal"
            ? expandedProposals.has(n.uuid)
            : undefined;
      return {
        id: n.uuid,
        type: n.type,
        title: n.title,
        // Pass-through of the per-node status string from the aggregation
        // payload (idea badgeHint / proposal status / task status / document
        // type). The renderers resolve label + color via the shared
        // node-status.ts module. The SSE reconcile re-fetch carries the new
        // status onto surviving nodes automatically (Tech Design D4).
        status: n.status,
        childCount,
        expanded,
        hasAffordance: shouldShowExpandAffordance(n.type, childCount),
        ownerId: ownerOf(n),
      };
    });

    // Aggregation contract: `from` is upstream/source, `to` is downstream/
    // target — map straight through so the arrowhead lands on the downstream
    // entity (lineage parent→child, derive source→derivative, depends
    // dependsOn→dependent).
    const linksOut: ForceLink[] = visibleEdges.map((e) => ({
      source: e.from,
      target: e.to,
      kind: e.kind,
    }));

    return {
      forceNodes: nodesOut,
      forceLinks: linksOut,
      isEmpty: visibleNodes.length === 0,
    };
  }, [graph, expandedIdeas, expandedProposals, visible]);

  // --- Search: match set, ordering, current-match cursor (D1/D2/D5) ---------
  //
  // Match set is computed over the TYPE-FILTERED nodes of the WHOLE graph — NOT
  // the expand-filtered `visibleNodes` the renderer receives. This is required
  // by the spec ("auto-expand the ancestor hubs … so that every match becomes
  // visible even when it was hidden under a collapsed hub"): if we matched only
  // expand-visible nodes, a deep match under a collapsed hub could never be
  // found, so its ancestors would never be expanded, so it would never be
  // revealed. Restricting to type-filtered nodes still satisfies Q7=a (a
  // filtered-out type cannot match) and never touches the filter checkboxes.
  const matchIds = useMemo<Set<string> | null>(() => {
    if (!graph) return null;
    const typeFiltered = graph.nodes.filter((n) => visible[n.type]);
    return computeSearchMatches(typeFiltered, searchQuery);
  }, [graph, searchQuery, visible]);

  // `null` = not searching (no dim, no count); a non-null Set (even empty) means
  // a search is active. Used to drive snapshot/restore + the count UI.
  const isSearching = matchIds !== null;

  // Ordered match list for prev/next: pre-order DFS outline order over the
  // CURRENTLY laid-out (post-auto-expand) nodes. Once auto-expand settles every
  // match is laid out, so this equals the full match set in spatial order.
  const orderedMatchIds = useMemo<string[]>(() => {
    if (matchIds === null || matchIds.size === 0) return [];
    const { outline } = computeTreeLayout(forceNodes, forceLinks);
    return orderMatchIdsByOutline(matchIds, outline);
  }, [matchIds, forceNodes, forceLinks]);

  const totalMatches = orderedMatchIds.length;
  // Normalize the index with wrap-around on read so prev/next can freely
  // over/under-shoot and a shrinking match set can't point out of range.
  const normalizedMatchIndex =
    totalMatches > 0
      ? ((currentMatchIndex % totalMatches) + totalMatches) % totalMatches
      : 0;
  const currentMatchId =
    totalMatches > 0 ? orderedMatchIds[normalizedMatchIndex] : null;

  // Refs so the debounced camera effect + prev/next handlers read the LATEST
  // ordered list / index without re-subscribing.
  const orderedMatchIdsRef = useRef(orderedMatchIds);
  orderedMatchIdsRef.current = orderedMatchIds;
  const currentMatchIndexRef = useRef(currentMatchIndex);
  currentMatchIndexRef.current = currentMatchIndex;

  // Auto-expand-to-reveal (D2): union each match's ancestor hubs into the live
  // expand sets. Add-only — never removes a user's manual expansion. Guarded so
  // a blank ("not searching") or zero-hit query expands nothing.
  useEffect(() => {
    if (!graph) return;
    if (matchIds === null || matchIds.size === 0) return;
    const { ideaUuids, proposalUuids } = expandAncestorsForMatches(
      graph,
      matchIds,
    );
    if (ideaUuids.size > 0) {
      setExpandedIdeas((prev) => {
        let mutated = false;
        const out = new Set(prev);
        for (const u of ideaUuids) {
          if (!out.has(u)) {
            out.add(u);
            mutated = true;
          }
        }
        return mutated ? out : prev;
      });
    }
    if (proposalUuids.size > 0) {
      setExpandedProposals((prev) => {
        let mutated = false;
        const out = new Set(prev);
        for (const u of proposalUuids) {
          if (!out.has(u)) {
            out.add(u);
            mutated = true;
          }
        }
        return mutated ? out : prev;
      });
    }
  }, [graph, matchIds]);

  // Snapshot / restore expand state around a search session (Q4=a, D3).
  // On the blank→non-blank render this captures the PRE-search expand sets. The
  // expand refs are assigned in the render body from COMMITTED state, and the
  // auto-expand effect's setState only takes effect on a LATER render — so the
  // refs still hold pre-search values when this effect runs, regardless of which
  // effect is declared first. On non-blank→blank it restores the snapshot,
  // collapsing any search-forced expansion while preserving the user's manual
  // one, and resets the match cursor.
  useEffect(() => {
    const was = wasSearchingRef.current;
    if (isSearching && !was) {
      // Leading edge: capture once. Don't overwrite on later keystrokes.
      expandSnapshotRef.current = {
        ideas: new Set(expandedIdeasRef.current),
        proposals: new Set(expandedProposalsRef.current),
      };
    } else if (!isSearching && was) {
      // Trailing edge: restore + drop the snapshot, reset the cursor.
      const snap = expandSnapshotRef.current;
      if (snap) {
        setExpandedIdeas(new Set(snap.ideas));
        setExpandedProposals(new Set(snap.proposals));
        expandSnapshotRef.current = null;
      }
      setCurrentMatchIndex(0);
      setCenterNodeId(null);
    }
    wasSearchingRef.current = isSearching;
  }, [isSearching]);

  // On every query change, reset the match cursor to the first match
  // immediately (the "current" indicator should never show a stale match # for
  // a brand-new query). The CAMERA recenter is separately debounced below.
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  // Debounced camera recenter (D6): ~200ms after the query settles, center on
  // the CURRENT match. Reads the latest ordered list + cursor via refs so it
  // picks up matches revealed by the just-applied auto-expand. On a brand-new
  // query `currentMatchIndex` was just reset to 0 (effect above), so this still
  // centers the first match; but if the user stepped (next/Enter) inside the
  // debounce window, we center the match the ring + count now point at rather
  // than snapping the camera back to #0 (avoids a camera/ring desync).
  // Highlight/dim + count update immediately (above); only the camera move waits.
  useEffect(() => {
    if (matchIds === null) return; // not searching
    const handle = setTimeout(() => {
      const list = orderedMatchIdsRef.current;
      if (list.length === 0) {
        setCenterNodeId(null);
        return;
      }
      const idx =
        ((currentMatchIndexRef.current % list.length) + list.length) %
        list.length;
      setCenterNodeId(list[idx]);
    }, 200);
    return () => clearTimeout(handle);
  }, [searchQuery, matchIds]);

  // Step the current-match cursor by ±1 with wrap-around, and signal the
  // renderers to bring the new current match into view. Reads latest via refs.
  const stepMatch = useCallback((delta: number) => {
    const list = orderedMatchIdsRef.current;
    const n = list.length;
    if (n === 0) return;
    const next = (((currentMatchIndexRef.current + delta) % n) + n) % n;
    setCurrentMatchIndex(next);
    setCenterNodeId(list[next]);
  }, []);

  // Clear the search (clear button / Esc / empty query all funnel here): just
  // blank the query — the snapshot/restore effect handles collapsing the
  // search-forced expansion.
  const clearSearch = useCallback(() => {
    setSearchQuery("");
  }, []);

  // Search-box key handling, IME-guarded (project rule: route any submit/
  // clear/advance-on-key handler through isImeComposing and early-return while
  // composing, so a CJK candidate-confirming Enter/Esc doesn't hijack it):
  //   - Enter  → jump to the next match (wrap-around), like a find-in-editor
  //     box. A no-op when there are no matches (stepMatch guards on an empty
  //     list). Shift+Enter steps to the previous match for symmetry.
  //   - Escape → clear the query (ends the search session).
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isImeComposing(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearSearch();
      }
    },
    [clearSearch, stepMatch],
  );

  // Open the Task panel by fetching the full task by UUID. Mirrors the
  // openTask flow in dashboard/panels/idea-detail-panel.tsx: clear any
  // sibling panel first so two non-URL panels are never live at once.
  const openTask = useCallback((taskUuid: string) => {
    setSelectedDoc(null);
    setSelectedTaskUuid(taskUuid);
  }, []);

  // Open the Document panel directly with the props the panel expects.
  // Like task above, clear the sibling state-driven panel first.
  const openDoc = useCallback((doc: DocumentForPanel) => {
    setSelectedTaskUuid(null);
    setSelectedTask(null);
    setSelectedDoc(doc);
  }, []);

  // Whenever selectedTaskUuid is set, fetch the task once (or refetch on
  // UUID change). Same pattern as the host's useEffect chain — keeps
  // TaskDetailPanel's `task` prop fresh without making it the fetcher.
  useEffect(() => {
    if (!selectedTaskUuid) {
      setSelectedTask(null);
      return;
    }
    let cancelled = false;
    getTaskAction(selectedTaskUuid)
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setSelectedTask(result.data);
        } else {
          clientLogger.error("Failed to load task for graph panel:", result.error);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        clientLogger.error("Failed to load task for graph panel:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskUuid]);

  // Whenever a Document node is clicked, the panel needs full content but
  // the graph aggregation only carries { uuid, type, title }. Fetch the
  // document detail (REST /api/documents/[uuid]) when selectedDocUuid is
  // set. We store the "open" trigger as a UUID separately so the panel
  // mounts as soon as we have content.
  const [selectedDocUuid, setSelectedDocUuid] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedDocUuid) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/documents/${selectedDocUuid}`, {
          signal: ac.signal,
        });
        const json: {
          success: boolean;
          data?: { title: string; type: string; content: string | null };
          error?: string;
        } = await res.json();
        if (ac.signal.aborted) return;
        if (!res.ok || !json.success || !json.data) {
          clientLogger.error(
            "Failed to load document for graph panel:",
            json.error,
          );
          return;
        }
        openDoc({
          title: json.data.title,
          type: json.data.type,
          content: json.data.content ?? "",
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        clientLogger.error("Failed to load document for graph panel:", err);
      }
    })();
    return () => ac.abort();
  }, [selectedDocUuid, openDoc]);

  // Node click router. Three behaviours, in priority order:
  //
  // 1. Click on the expand/collapse affordance (the "N ›" pill or the
  //    chevron-down on an Idea) → toggle the subgraph. The canvas reports
  //    `onAffordance` by hit-testing the click against the affordance's
  //    hot-zone (right edge of the Idea card) in graph coordinates.
  //
  // 2. Otherwise: open the appropriate side panel for this node's type.
  //    Idea / Proposal go through usePanelUrl (?panel=…[&tab=proposal]);
  //    Task / Document use the state-driven hosts above.
  //
  // 3. A Proposal node with no source idea (shouldn't normally happen for
  //    project-scoped proposals — the aggregation pre-filters) silently
  //    no-ops; logged for visibility.
  const handleNodeClick = useCallback(
    (id: string, type: NodeType, onAffordance: boolean) => {
      if (onAffordance && (type === "idea" || type === "proposal")) {
        // Click landed on the +/- button of an expandable hub — toggle its
        // children (Idea→Proposals, Proposal→Tasks+Docs) instead of opening
        // a panel. The button only renders when the hub has children.
        toggleHubExpand(id, type);
        return;
      }

      switch (type) {
        case "idea": {
          // Open the IdeaDetailPanel via ?panel=<uuid>, focused on the
          // Elaboration tab — that's the AI-DLC stage an Idea node represents
          // (clarifying requirements), so it's the most useful landing tab from
          // the graph. The panel reads ?tab from the URL (idea-detail-panel
          // urlTab), and "elaboration" is always a visible tab. The
          // hasRenderedRef gate inside usePanelUrl keeps the seed from leaking.
          openPanel(id, "elaboration");
          return;
        }
        case "proposal": {
          // A Proposal has no standalone panel — its content lives on the
          // idea-tracker's Proposal tab keyed by its source Idea. The
          // aggregation already filters sourceIdeaUuids to project-local
          // ideas, so the first entry is the right project-local source.
          const ideaUuid = (
            graph?.nodes.find((n) => n.uuid === id)?.sourceIdeaUuids ?? []
          )[0];
          if (!ideaUuid) {
            clientLogger.warn(
              "[resource-graph] proposal node has no project-local source idea; cannot open panel",
              { proposalUuid: id },
            );
            return;
          }
          openPanel(ideaUuid, "proposal");
          return;
        }
        case "task": {
          openTask(id);
          return;
        }
        case "document": {
          // Trigger the document fetch; once content arrives the effect
          // above calls openDoc and the panel mounts.
          setSelectedTaskUuid(null);
          setSelectedTask(null);
          setSelectedDoc(null);
          setSelectedDocUuid(id);
          return;
        }
      }
    },
    [graph, openPanel, openTask, toggleHubExpand],
  );

  // Which node keeps a selection ring while a panel is open.
  const selectedNodeId = urlPanelUuid ?? selectedTaskUuid ?? selectedDocUuid;

  // Reset doc-trigger when the selected doc is closed (keeps re-clicking
  // the same document from being a no-op because setSelectedDocUuid === id).
  const handleCloseDocPanel = useCallback(() => {
    setSelectedDoc(null);
    setSelectedDocUuid(null);
  }, []);

  // --- Render ---

  // Side panels are rendered as fixed-position overlays at the end of the
  // component tree, so the graph canvas itself stays mounted while any panel
  // is open. The clicked node's selection ring is drawn by the canvas from
  // the `selectedId` prop (computed above as selectedNodeId).
  const panels = (
    <>
      {urlPanelUuid && (
        <IdeaDetailPanel
          key={urlPanelUuid}
          ideaUuid={urlPanelUuid}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={closePanel}
          onNavigate={openPanel}
        />
      )}
      {selectedTaskUuid && selectedTask && (
        // Always "overlay" (flush-right + backdrop). The graph view has no
        // primary right-edge panel to dock beside, so "sidebyside" — which
        // offsets the panel LEFT by one panel-width to sit beside an anchoring
        // IdeaDetailPanel (the dashboard host's two-panel stack) — would leave
        // it floating mid-screen with a gap on the right. Standalone = overlay.
        <TaskDetailPanel
          task={selectedTask}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          mode="overlay"
          onClose={() => {
            setSelectedTaskUuid(null);
            setSelectedTask(null);
          }}
        />
      )}
      {selectedDoc && (
        <DocumentPanel
          title={selectedDoc.title}
          type={selectedDoc.type}
          content={selectedDoc.content}
          mode="overlay"
          onClose={handleCloseDocPanel}
        />
      )}
    </>
  );

  if (error) {
    return (
      <div className="p-4 md:p-8">
        <Header t={t} />
        <Card className="border-[#E5E0D8] p-6 text-sm text-[#B71C1C]">{error}</Card>
        {panels}
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="p-4 md:p-8">
        <Header t={t} />
        <Card className="flex items-center justify-center border-[#E5E0D8] p-12 text-sm text-[#6B6B6B]">
          {t("graph.loading")}
        </Card>
        {panels}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4 md:p-8">
      <Header t={t} />

      <div className="relative flex-1 min-h-[600px] overflow-hidden rounded-[10px] border border-[#E5E0D8] bg-[#FAF8F4]">
        {isEmpty && (
          // Either the project has no entities at all, OR all four type-toggles
          // are off. Either way, the user sees the same explanation; the
          // mind-map renderer (canvas or outline) + filter panel remain mounted
          // below so toggling a type back on immediately restores the view.
          <AnimatedEmptyState>
            <Card className="m-12 flex flex-col items-center justify-center border-[#E5E0D8] p-8 text-center">
              <h3 className="mb-2 text-base font-medium text-[#2C2C2C]">
                {t("graph.emptyTitle")}
              </h3>
              <p className="max-w-sm text-sm text-[#6B6B6B]">{t("graph.emptyDesc")}</p>
            </Card>
          </AnimatedEmptyState>
        )}

        {/* Renderer. Hidden (but the container stays) when empty so the filter
            overlay still toggles types back on. On a narrow viewport the DOM
            vertical indented outline renders; on a wide viewport the Canvas-2D
            mind-map. Both take the same nodes/links + onNodeClick contract and
            read the same shared expand state, so resizing preserves expansion. */}
        {!isEmpty &&
          (isMobile ? (
            <MindMapOutline
              nodes={forceNodes}
              links={forceLinks}
              selectedId={selectedNodeId}
              onNodeClick={handleNodeClick}
              matchIds={matchIds}
              currentMatchId={currentMatchId}
            />
          ) : (
            <ForceGraphCanvas
              nodes={forceNodes}
              links={forceLinks}
              selectedId={selectedNodeId}
              onNodeClick={handleNodeClick}
              matchIds={matchIds}
              currentMatchId={currentMatchId}
              centerNodeId={centerNodeId}
            />
          ))}

        {/* Control panel — single top-right overlay combining the type filter
            and the expand-all/collapse-all action. Consolidated into one card
            (rather than a separate left-side button) so nothing overlays the
            graph/outline content on mobile, where the outline rows start at the
            left edge. The expand toggle drives the shared expand state, so it
            affects both the canvas and the mobile outline. */}
        <div className="absolute right-3 top-3 z-10">
          <Card className="w-[224px] border-[#E5E0D8] bg-white/95 p-3 shadow-sm backdrop-blur">
            {/* Node search (Tech Design D8). Hidden when empty — nothing to
                search. Sits above the type filter on the same control card. */}
            {!isEmpty && (
              <div className="mb-3" data-testid="graph-search">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9A9A9A]"
                    aria-hidden="true"
                  />
                  <Input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={t("graph.search.placeholder")}
                    aria-label={t("graph.search.placeholder")}
                    data-testid="graph-search-input"
                    className="h-8 pl-8 pr-8 text-xs"
                  />
                  {searchQuery !== "" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={clearSearch}
                      aria-label={t("graph.search.clear")}
                      data-testid="graph-search-clear"
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-[#6B6B6B]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {/* Count + prev/next + no-matches hint — only while searching. */}
                {isSearching && (
                  <div
                    className="mt-2 flex items-center justify-between gap-2"
                    data-testid="graph-search-nav"
                  >
                    {totalMatches > 0 ? (
                      <span
                        className="text-[11px] tabular-nums text-[#6B6B6B]"
                        data-testid="graph-search-count"
                      >
                        {t("graph.search.count", {
                          current: normalizedMatchIndex + 1,
                          total: totalMatches,
                        })}
                      </span>
                    ) : (
                      <span
                        className="text-[11px] text-[#B07B00]"
                        data-testid="graph-search-no-matches"
                      >
                        {t("graph.search.noMatches")}
                      </span>
                    )}
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => stepMatch(-1)}
                        disabled={totalMatches === 0}
                        aria-label={t("graph.search.prev")}
                        data-testid="graph-search-prev"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => stepMatch(1)}
                        disabled={totalMatches === 0}
                        aria-label={t("graph.search.next")}
                        data-testid="graph-search-next"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[#6B6B6B]">
              {t("graph.filters.heading")}
            </p>
            <div className="flex flex-col gap-2">
              {(["idea", "proposal", "task", "document"] as NodeType[]).map((type) => {
                const swatch = FILTER_SWATCH[type];
                const id = `graph-filter-${type}`;
                return (
                  <div key={type} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={visible[type]}
                      onCheckedChange={() => toggleType(type)}
                    />
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: swatch.color }}
                    />
                    <Label htmlFor={id} className="cursor-pointer text-xs text-[#2C2C2C]">
                      {t(`graph.filters.${type}` as const)}
                    </Label>
                  </div>
                );
              })}
            </div>
            {/* Expand-all / collapse-all — flips mode based on current state.
                Hidden when empty (nothing to expand). */}
            {!isEmpty && (
              <>
                <div className="my-2 h-px bg-[#EFEAE2]" />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center gap-2"
                  onClick={anyExpanded ? collapseAll : expandAll}
                >
                  {anyExpanded ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                  {anyExpanded ? t("graph.collapseAll") : t("graph.expandAll")}
                </Button>
              </>
            )}
          </Card>
        </div>
      </div>
      {panels}
    </div>
  );
}

// --- Helpers ---------------------------------------------------------------

function Header({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("graph.title")}</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">{t("graph.subtitle")}</p>
      </div>
    </div>
  );
}
