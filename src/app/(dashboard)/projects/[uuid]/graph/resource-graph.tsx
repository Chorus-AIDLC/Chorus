"use client";

// Project Resource Graph canvas — Wave 2 (rendering backbone).
//
// Consumes the aggregation contract from src/services/resource-graph.service.ts
// (GET /api/projects/[uuid]/resource-graph) and seeds force-directed positions
// via src/lib/resource-graph-layout.ts, then renders nodes + edges with the
// existing @xyflow/react 12 stack (Background + Controls), following the
// setup pattern in src/components/task-dag.tsx.
//
// Scope of THIS task (per the assignment):
//   - rendering backbone (nodes/edges/zoom/pan)
//   - three visually-distinct, directional edge kinds
//   - 4-type filter that excludes hidden nodes from BOTH layout and render
//   - minimal placeholder node renderer (title + type color)
//
// Out of scope (next task 18d974e1):
//   - rich custom node visual (count pill, chevron)
//   - per-Idea expand/collapse interaction
//   - presence highlight, side-panel wiring
//
// Edge direction mirrors the aggregation contract — `from` → source,
// `to` → target — so the arrowhead lands on the downstream entity in every
// kind:
//   lineage : parentIdea -> childIdea     (violet  #7C4DFF)
//   derive  : source     -> derivative    (neutral #CFC6B6)
//   depends : dependsOn  -> dependent     (amber   #E8833A)

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslations } from "next-intl";
import { Lightbulb, ClipboardList, CheckSquare, FileText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AnimatedEmptyState } from "@/components/animated-empty-state";
import { layoutResourceGraph } from "@/lib/resource-graph-layout";

// --- Aggregation payload types ---------------------------------------------
// Mirrors src/services/resource-graph.service.ts. Re-declared here as a
// minimal client-side shape so the client bundle doesn't import the server
// service. The set of node types + edge kinds is kept in lockstep with the
// service via tsc — a service change that drops a kind would break this file.

type NodeType = "idea" | "proposal" | "task" | "document";
type EdgeKind = "derive" | "lineage" | "depends";

interface ApiNode {
  uuid: string;
  type: NodeType;
  title: string;
  parentIdeaUuid?: string | null;
  proposalUuid?: string | null;
  sourceIdeaUuids?: string[];
}

interface ApiEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

interface ApiGraph {
  nodes: ApiNode[];
  edges: ApiEdge[];
}

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

interface NodeTypeStyle {
  chipFill: string; // background of the type chip
  chipText: string; // hex color of the type eyebrow text + icon
  border: string; // node card border at rest
  Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

const NODE_STYLES: Record<NodeType, NodeTypeStyle> = {
  idea: { chipFill: "#7C4DFF14", chipText: "#7C4DFF", border: "#EAE4DB", Icon: Lightbulb },
  proposal: { chipFill: "#2563EB14", chipText: "#2563EB", border: "#EAE4DB", Icon: ClipboardList },
  task: { chipFill: "#E8833A14", chipText: "#E8833A", border: "#EAE4DB", Icon: CheckSquare },
  document: { chipFill: "#00897B14", chipText: "#00897B", border: "#EAE4DB", Icon: FileText },
};

// Minimal placeholder node renderer for THIS task. The rich custom node + the
// expand/collapse pill lands in 18d974e1 — keep this simple but visually
// type-distinguishable (chip color + eyebrow + title).
const NODE_WIDTH = 208;

interface ResourceGraphNodeData {
  type: NodeType;
  title: string;
  typeLabel: string;
  [key: string]: unknown;
}

function ResourceGraphNode({ data }: NodeProps<Node<ResourceGraphNodeData>>) {
  const style = NODE_STYLES[data.type];
  const Icon = style.Icon;
  return (
    <div
      className="rounded-[12px] bg-white px-3 py-2.5 shadow-sm flex items-center gap-2.5"
      style={{
        borderColor: style.border,
        borderWidth: 1,
        borderStyle: "solid",
        width: NODE_WIDTH,
      }}
    >
      {/* Source + target handles are intentionally invisible — d3-force layout
          places nodes and xyflow draws straight edges between centers; handle
          UI would be misleading on a force graph (no manual connect). */}
      <Handle
        type="target"
        position={Position.Top}
        className="!opacity-0 !pointer-events-none"
      />
      <div
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]"
        style={{ backgroundColor: style.chipFill }}
      >
        <Icon className="h-4 w-4" style={{ color: style.chipText }} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className="font-mono text-[10px] tracking-wider"
          style={{ color: style.chipText }}
        >
          {data.typeLabel}
        </span>
        <span className="truncate text-xs font-medium text-[#2C2C2C]">
          {data.title}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!opacity-0 !pointer-events-none"
      />
    </div>
  );
}

// Memoize the lookup so ReactFlow doesn't tear down node instances when its
// parent re-renders (xyflow caches by reference identity).
const nodeTypes = { resource: ResourceGraphNode };

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

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<VisibleTypes>(ALL_VISIBLE);

  // Fetch the aggregation payload. Single GET per mount — there's no live
  // update wiring in this task; structural live update lands later.
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    setGraph(null);

    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectUuid}/resource-graph`, {
          signal: ac.signal,
        });
        const json: { success: boolean; data?: ApiGraph; error?: string } =
          await res.json();
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

  // Filter -> layout -> ReactFlow data. The filter must exclude hidden nodes
  // from BOTH the layout pass and the render set (acceptance criterion 3).
  const { rfNodes, rfEdges, isEmpty } = useMemo(() => {
    if (!graph) {
      return { rfNodes: [] as Node<ResourceGraphNodeData>[], rfEdges: [] as Edge[], isEmpty: true };
    }

    const visibleNodes = graph.nodes.filter((n) => visible[n.type]);
    const visibleUuids = new Set(visibleNodes.map((n) => n.uuid));
    const visibleEdges = graph.edges.filter(
      (e) => visibleUuids.has(e.from) && visibleUuids.has(e.to)
    );

    // Layout is intentionally re-seeded from scratch each render in this task
    // — there is no expand/collapse yet to need incremental settling. The
    // module's deterministic seed gives a stable layout for the same input.
    const positions = layoutResourceGraph(
      visibleNodes.map((n) => ({ uuid: n.uuid })),
      visibleEdges.map((e) => ({ from: e.from, to: e.to }))
    );

    const labelOf: Record<NodeType, string> = {
      idea: t("graph.nodeType.idea"),
      proposal: t("graph.nodeType.proposal"),
      task: t("graph.nodeType.task"),
      document: t("graph.nodeType.document"),
    };

    const nodesOut: Node<ResourceGraphNodeData>[] = visibleNodes.map((n) => {
      const pos = positions.get(n.uuid) ?? { x: 0, y: 0 };
      return {
        id: n.uuid,
        type: "resource",
        position: pos,
        data: { type: n.type, title: n.title, typeLabel: labelOf[n.type] },
      };
    });

    const edgesOut: Edge[] = visibleEdges.map((e, i) => {
      const styleSpec = EDGE_STYLES[e.kind];
      return {
        id: `e-${i}`,
        // Aggregation contract: `from` is the upstream/source endpoint, `to`
        // is the downstream/target endpoint. Map straight through — the
        // arrowhead on xyflow lands on `target`, which is the downstream
        // entity in every kind:
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
  }, [graph, visible, t]);

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

  // The page chrome (header) sits above a fixed-height canvas container so
  // ReactFlow has a real layout box to size to. The dashboard layout already
  // gives this route an h-full content area; we hand the canvas a 75vh
  // minimum so it works in both the standard layout and the side-panel-
  // docked-open layout.
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
          nodeTypes={nodeTypes}
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
                  const style = NODE_STYLES[type];
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
                        style={{ backgroundColor: style.chipText }}
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

