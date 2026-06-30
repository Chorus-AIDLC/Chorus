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
import { Lightbulb, ClipboardList, CheckSquare, FileText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AnimatedEmptyState } from "@/components/animated-empty-state";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { computeVisibleSet } from "@/lib/resource-graph-visible-set";
import { shouldShowExpandAffordance } from "./expand-affordance";
import type {
  ResourceGraphResult,
  ResourceGraphNodeType as NodeType,
} from "@/services/resource-graph.service";
import { clientLogger } from "@/lib/logger-client";
import { IdeaDetailPanel } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel";
import { TaskDetailPanel } from "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel";
import { DocumentPanel } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/document-panel";
import { getTaskAction } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/actions";
import type { ForceNode, ForceLink } from "./force-graph-canvas";

// react-force-graph-2d touches window/document at import time, so the canvas
// must be client-only. Dynamic import with ssr:false keeps it out of the
// server bundle; the rest of this component (data, panels, filter) is SSR-safe.
const ForceGraphCanvas = dynamic(
  () => import("./force-graph-canvas").then((m) => m.ForceGraphCanvas),
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

  // Node positions are owned by the live force-graph canvas, which retains
  // each node's x/y across renders by id (so expand/collapse + live updates
  // settle incrementally rather than re-randomizing). This component no
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

  // Filter -> expand/collapse visible set -> ForceGraph data.
  //
  // Order matters: the type filter is applied AFTER the expand/collapse
  // visible set is computed, so hiding e.g. all Tasks doesn't change the
  // derivative count shown on an Idea's pill (the pill counts *direct*
  // derivatives by structure, not by what's currently rendered — matches
  // the spec scenario "a count of its hidden direct derivatives").
  //
  // No layout call here: the force-graph canvas runs a LIVE d3-force
  // simulation and owns node positions (retaining them across renders by id),
  // so the graph settles + animates rather than being pre-solved statically.
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
        childCount,
        expanded,
        hasAffordance: shouldShowExpandAffordance(n.type, childCount),
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
          // Open the IdeaDetailPanel via ?panel=<uuid>. The hasRenderedRef
          // gate inside usePanelUrl keeps the seed from leaking; we pass
          // null to initialSelectedId for the same reason — no SSR seed
          // to begin with on the graph route.
          openPanel(id);
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
          // ReactFlow canvas + filter panel remain mounted below so toggling
          // a type back on immediately restores the view.
          <AnimatedEmptyState>
            <Card className="m-12 flex flex-col items-center justify-center border-[#E5E0D8] p-8 text-center">
              <h3 className="mb-2 text-base font-medium text-[#2C2C2C]">
                {t("graph.emptyTitle")}
              </h3>
              <p className="max-w-sm text-sm text-[#6B6B6B]">{t("graph.emptyDesc")}</p>
            </Card>
          </AnimatedEmptyState>
        )}

        {/* Live force-directed canvas. Hidden (but mounted) when empty so the
            filter overlay still toggles types back on. */}
        {!isEmpty && (
          <ForceGraphCanvas
            nodes={forceNodes}
            links={forceLinks}
            selectedId={selectedNodeId}
            onNodeClick={handleNodeClick}
          />
        )}

        {/* Type filter — absolutely positioned overlay (top-right). */}
        <div className="absolute right-3 top-3 z-10">
          <Card className="border-[#E5E0D8] bg-white/95 p-3 shadow-sm backdrop-blur">
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
