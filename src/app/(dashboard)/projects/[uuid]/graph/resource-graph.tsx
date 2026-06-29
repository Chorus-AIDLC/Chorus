"use client";

// Project Resource Graph canvas — Wave 3 (rich custom node + per-Idea
// expand/collapse).
//
// Builds on Wave 2's rendering backbone: fetch + 4-type filter + layout +
// ReactFlow setup stay the same. Wave 3 adds:
//   - Rich custom node renderer (./resource-graph-node) replacing the
//     placeholder inline component.
//   - Client state Set<expandedIdeaUuid> — default empty → all Ideas
//     collapsed → only Idea hubs visible.
//   - Visible-set computation via computeVisibleSet (pure, unit-tested in
//     src/lib/__tests__/resource-graph-visible-set.test.ts).
//   - Idea-click toggles expand/collapse; the visible set recomputes and
//     layoutResourceGraph re-runs SEEDED with the prior positions so the
//     graph settles incrementally instead of re-randomizing.
//
// Edge direction mirrors the aggregation contract — `from` → source,
// `to` → target — so the arrowhead lands on the downstream entity in every
// kind:
//   lineage : parentIdea -> childIdea     (violet  #7C4DFF)
//   derive  : source     -> derivative    (neutral #CFC6B6)
//   depends : dependsOn  -> dependent     (amber   #E8833A)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslations } from "next-intl";
import { Lightbulb, ClipboardList, CheckSquare, FileText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AnimatedEmptyState } from "@/components/animated-empty-state";
import { layoutResourceGraph, type Position } from "@/lib/resource-graph-layout";
import { computeVisibleSet } from "@/lib/resource-graph-visible-set";
import type {
  ResourceGraphResult,
  ResourceGraphNodeType as NodeType,
  ResourceGraphEdgeKind as EdgeKind,
} from "@/services/resource-graph.service";
import {
  resourceGraphNodeTypes,
  type ResourceGraphNodeData,
} from "./resource-graph-node";

// --- Visual tokens ----------------------------------------------------------
// Colors come straight from docs/design.pen "NOTE Graph View — main":
//   derive  neutral #CFC6B6
//   lineage violet  #7C4DFF
//   depends amber   #E8833A
// and the per-type chip palette from the Tech Design "Node rendering" section.

const EDGE_STYLES: Record<
  EdgeKind,
  { stroke: string; strokeWidth: number; strokeDasharray?: string }
> = {
  derive: { stroke: "#CFC6B6", strokeWidth: 1.5 },
  lineage: { stroke: "#7C4DFF", strokeWidth: 2 },
  depends: { stroke: "#E8833A", strokeWidth: 2 },
};

// Per-type filter swatch (just a small color dot). The rich type colors
// live inside the node renderer; this is purely for the filter UI.
const FILTER_SWATCH: Record<NodeType, { color: string; Icon: typeof Lightbulb }> = {
  idea: { color: "#7C4DFF", Icon: Lightbulb },
  proposal: { color: "#2563EB", Icon: ClipboardList },
  task: { color: "#E8833A", Icon: CheckSquare },
  document: { color: "#00897B", Icon: FileText },
};

// --- Component -------------------------------------------------------------

interface ResourceGraphProps {
  projectUuid: string;
}

type VisibleTypes = Record<NodeType, boolean>;

const ALL_VISIBLE: VisibleTypes = {
  idea: true,
  proposal: true,
  task: true,
  document: true,
};

export function ResourceGraph({ projectUuid }: ResourceGraphProps) {
  const t = useTranslations();

  const [graph, setGraph] = useState<ResourceGraphResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<VisibleTypes>(ALL_VISIBLE);
  // Set<ideaUuid> of currently-expanded Ideas. Empty default = every Idea
  // is collapsed (only Idea hubs render). Storing as Set (not array) so
  // toggle is O(1); React change detection relies on the wrapper Set being
  // a fresh reference on each mutation.
  const [expandedIdeas, setExpandedIdeas] = useState<Set<string>>(
    () => new Set(),
  );

  // prevPositions is a ref (not state) so seeding the next layout doesn't
  // depend on a render cycle and doesn't itself trigger one. The layout
  // memo writes the freshly-computed positions back here each time.
  const prevPositionsRef = useRef<Map<string, Position> | null>(null);

  // Fetch the aggregation payload. Single GET per mount — there's no live
  // update wiring in this task; structural live update lands later.
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    setGraph(null);
    // Re-mounting on a different project resets the expand state — there is
    // no UX value to carrying over expanded UUIDs from a different graph.
    setExpandedIdeas(new Set());
    prevPositionsRef.current = null;

    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectUuid}/resource-graph`, {
          signal: ac.signal,
        });
        const json: {
          success: boolean;
          data?: ResourceGraphResult;
          error?: string;
        } = await res.json();
        if (ac.signal.aborted) return;
        if (!res.ok || !json.success || !json.data) {
          setError(json.error ?? t("graph.loadFailed"));
          return;
        }
        setGraph(json.data);
      } catch (err) {
        if (ac.signal.aborted) return;
        // Surface the failure rather than silently swallowing it
        // (see feedback_no_silent_errors).
        // eslint-disable-next-line no-console
        console.error("[resource-graph] fetch failed", err);
        setError(t("graph.loadFailed"));
      }
    })();

    return () => ac.abort();
  }, [projectUuid, t]);

  const toggleType = useCallback((type: NodeType) => {
    setVisible((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  const toggleIdeaExpand = useCallback((ideaUuid: string) => {
    setExpandedIdeas((prev) => {
      const next = new Set(prev);
      if (next.has(ideaUuid)) {
        next.delete(ideaUuid);
      } else {
        next.add(ideaUuid);
      }
      return next;
    });
  }, []);

  // Filter -> expand/collapse visible set -> layout -> ReactFlow data.
  //
  // Order matters: the type filter is applied AFTER the expand/collapse
  // visible set is computed, so hiding e.g. all Tasks doesn't change the
  // derivative count shown on an Idea's pill (the pill counts *direct*
  // derivatives by structure, not by what's currently rendered — matches
  // the spec scenario "a count of its hidden direct derivatives").
  const { rfNodes, rfEdges, isEmpty } = useMemo(() => {
    if (!graph) {
      return {
        rfNodes: [] as Node<ResourceGraphNodeData>[],
        rfEdges: [] as Edge[],
        isEmpty: true,
      };
    }

    const { visibleNodeUuids, visibleEdgeIndices, derivativeCountByIdea } =
      computeVisibleSet(graph, expandedIdeas);

    // Apply the type filter to the visible set. Ideas count is unaffected
    // (Ideas are always in visibleNodeUuids), but unchecking "Ideas" will
    // hide them, etc.
    const visibleNodes = graph.nodes.filter(
      (n) => visibleNodeUuids.has(n.uuid) && visible[n.type],
    );
    const visibleUuids = new Set(visibleNodes.map((n) => n.uuid));
    const visibleEdges = visibleEdgeIndices
      .map((i) => graph.edges[i])
      .filter((e) => visibleUuids.has(e.from) && visibleUuids.has(e.to));

    // Seed layout with the previous positions so expand/collapse settles
    // incrementally instead of re-randomizing (AC #3). First run has no
    // prior positions and falls back to fresh phyllotaxis.
    const positions = layoutResourceGraph(
      visibleNodes.map((n) => ({ uuid: n.uuid })),
      visibleEdges.map((e) => ({ from: e.from, to: e.to })),
      prevPositionsRef.current,
    );
    prevPositionsRef.current = positions;

    const labelOf: Record<NodeType, string> = {
      idea: t("graph.nodeType.idea"),
      proposal: t("graph.nodeType.proposal"),
      task: t("graph.nodeType.task"),
      document: t("graph.nodeType.document"),
    };

    const nodesOut: Node<ResourceGraphNodeData>[] = visibleNodes.map((n) => {
      const pos = positions.get(n.uuid) ?? { x: 0, y: 0 };
      const data: ResourceGraphNodeData = {
        type: n.type,
        title: n.title,
        typeLabel: labelOf[n.type],
      };
      if (n.type === "idea") {
        data.expanded = expandedIdeas.has(n.uuid);
        data.derivativeCount = derivativeCountByIdea.get(n.uuid) ?? 0;
      }
      return {
        id: n.uuid,
        type: "resource",
        position: pos,
        data,
      };
    });

    const edgesOut: Edge[] = visibleEdges.map((e, i) => {
      const styleSpec = EDGE_STYLES[e.kind];
      return {
        id: `e-${i}`,
        // Aggregation contract: `from` is the upstream/source endpoint,
        // `to` is the downstream/target endpoint. Map straight through —
        // arrowhead lands on `target`, the downstream entity in every
        // kind:
        //   lineage  parentIdea -> childIdea
        //   derive   source     -> derivative
        //   depends  dependsOn  -> dependent
        source: e.from,
        target: e.to,
        type: "default",
        style: {
          stroke: styleSpec.stroke,
          strokeWidth: styleSpec.strokeWidth,
          ...(styleSpec.strokeDasharray
            ? { strokeDasharray: styleSpec.strokeDasharray }
            : {}),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: styleSpec.stroke,
          width: 16,
          height: 16,
        },
        // Identify the relationship kind for debugging + future styling hooks.
        data: { kind: e.kind },
      };
    });

    return {
      rfNodes: nodesOut,
      rfEdges: edgesOut,
      isEmpty: visibleNodes.length === 0,
    };
  }, [graph, expandedIdeas, visible, t]);

  // Node click: only Idea nodes toggle expand/collapse in this task. Click
  // handling for the other types (open side panel) is the downstream task
  // d2681a81 — keep this handler narrow so adding that later doesn't
  // collide.
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<ResourceGraphNodeData>) => {
      if (node.data.type === "idea") {
        // Leaf Ideas (no derivatives) get no affordance and shouldn't
        // toggle — guard so a click is a no-op rather than a phantom state
        // change.
        const count = node.data.derivativeCount ?? 0;
        if (count === 0) return;
        toggleIdeaExpand(node.id);
      }
    },
    [toggleIdeaExpand],
  );

  // --- Render ---

  if (error) {
    return (
      <div className="p-4 md:p-8">
        <Header t={t} />
        <Card className="border-[#E5E0D8] p-6 text-sm text-[#B71C1C]">{error}</Card>
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

        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={resourceGraphNodeTypes}
          onNodeClick={handleNodeClick}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll
        >
          <Background color="#E5E0D8" gap={20} />
          <Controls className="[&>button]:border-[#E5E0D8] [&>button]:bg-white [&>button]:text-[#2C2C2C] [&>button:hover]:bg-[#FAF8F4]" />

          <Panel position="top-right">
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
          </Panel>
        </ReactFlow>
      </div>
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
