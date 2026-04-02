"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

// Status colors matching existing patterns
const statusColors: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  assigned: "bg-[#E3F2FD] text-[#1976D2]",
  in_progress: "bg-[#E8F5E9] text-[#5A9E6F]",
  to_verify: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

const statusBorderColors: Record<string, string> = {
  open: "#E65100",
  assigned: "#1976D2",
  in_progress: "#5A9E6F",
  to_verify: "#7B1FA2",
  done: "#00796B",
  closed: "#9A9A9A",
};

const priorityI18nKeys: Record<string, string> = {
  low: "priority.low",
  medium: "priority.medium",
  high: "priority.high",
  critical: "priority.critical",
};

const statusI18nKeys: Record<string, string> = {
  open: "status.open",
  assigned: "status.assigned",
  in_progress: "status.inProgress",
  to_verify: "status.toVerify",
  done: "status.done",
  closed: "status.closed",
};

const priorityDotColors: Record<string, string> = {
  low: "bg-[#9A9A9A]",
  medium: "bg-[#E65100]",
  high: "bg-[#D32F2F]",
  critical: "bg-[#B71C1C]",
};

export interface TaskNodeData {
  title: string;
  status: string;
  priority: string;
  proposalUuid: string | null;
  [key: string]: unknown;
}

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = useTranslations();

  return (
    <div className="rounded-lg border-2 border-[#E5E2DC] bg-white px-4 py-3 shadow-sm min-w-[200px] max-w-[260px] cursor-pointer hover:border-[#C67A52] transition-colors">
      <Handle type="target" position={Position.Top} className="!bg-[#C67A52] !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1.5">
        <Badge className={`text-[10px] ${statusColors[data.status] || ""}`}>
          {t(statusI18nKeys[data.status] || data.status)}
        </Badge>
        <div className="flex items-center gap-1">
          <div className={`h-1.5 w-1.5 rounded-full ${priorityDotColors[data.priority] || ""}`} />
          <span className="text-[10px] text-[#9A9A9A]">{t(priorityI18nKeys[data.priority] || data.priority)}</span>
        </div>
      </div>
      <p className="text-xs font-medium text-[#2C2C2C] leading-snug line-clamp-2">
        {data.title}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-[#C67A52] !w-2 !h-2" />
    </div>
  );
}

function CompactTaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const borderColor = statusBorderColors[data.status] || "#E5E0D8";

  return (
    <div
      className="rounded-md border-[1.5px] bg-white px-2.5 py-1.5 shadow-sm"
      style={{ borderColor, width: COMPACT_NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#C67A52] !w-1.5 !h-1.5" />
      <p className="text-[10px] font-medium text-[#2C2C2C] leading-tight line-clamp-2">
        {data.title}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-[#C67A52] !w-1.5 !h-1.5" />
    </div>
  );
}

const nodeTypes = { taskNode: TaskNode };
const compactNodeTypes = { taskNode: CompactTaskNode };

const NODE_WIDTH = 240;
const NODE_HEIGHT = 80;
const COMPACT_NODE_WIDTH = 150;
const COMPACT_NODE_HEIGHT = 50;

const defaultEdgeStyle = {
  animated: true,
  style: { stroke: "#C67A52", strokeWidth: 2 },
  markerEnd: { type: "arrowclosed" as const, color: "#C67A52" },
};

const compactEdgeStyle = {
  animated: true,
  style: { stroke: "#C67A52", strokeWidth: 1.5 },
  markerEnd: { type: "arrowclosed" as const, color: "#C67A52" },
};

function getLayoutedElements(
  nodes: Node<TaskNodeData>[],
  edges: Edge[],
  options?: { nodeWidth?: number; nodeHeight?: number; nodesep?: number; ranksep?: number }
): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const nw = options?.nodeWidth ?? NODE_WIDTH;
  const nh = options?.nodeHeight ?? NODE_HEIGHT;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: options?.nodesep ?? 50,
    ranksep: options?.ranksep ?? 80,
  });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: nw, height: nh });
  });

  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = g.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nw / 2,
        y: nodeWithPosition.y - nh / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

export interface TaskDagTask {
  uuid: string;
  title: string;
  status: string;
  priority: string;
  proposalUuid?: string | null;
}

export interface TaskDagEdge {
  from: string;
  to: string;
}

export interface TaskDagProps {
  tasks: TaskDagTask[];
  edges: TaskDagEdge[];
  readonly?: boolean;
  compact?: boolean;
  height?: number;
  onNodeClick?: (taskUuid: string) => void;
  className?: string;
}

export function TaskDag({
  tasks,
  edges: edgeData,
  readonly = false,
  compact = false,
  height,
  onNodeClick,
  className,
}: TaskDagProps) {
  const t = useTranslations();

  const { layoutedNodes, layoutedEdges } = useMemo(() => {
    const rawNodes: Node<TaskNodeData>[] = tasks.map((task) => ({
      id: task.uuid,
      type: "taskNode",
      position: { x: 0, y: 0 },
      data: {
        title: task.title,
        status: task.status,
        priority: task.priority,
        proposalUuid: task.proposalUuid ?? null,
      },
    }));

    // edges: from = taskUuid (depends on), to = dependsOnUuid
    // In visualization: dependsOnUuid -> taskUuid (arrow from dependency to dependent)
    const rawEdges: Edge[] = edgeData.map((e, i) => ({
      id: `e-${i}`,
      source: e.to,    // dependsOnUuid (the upstream task)
      target: e.from,   // taskUuid (the task that depends on it)
      ...(compact ? compactEdgeStyle : defaultEdgeStyle),
    }));

    const layoutOptions = compact
      ? { nodeWidth: COMPACT_NODE_WIDTH, nodeHeight: COMPACT_NODE_HEIGHT, nodesep: 20, ranksep: 40 }
      : undefined;
    const result = getLayoutedElements(rawNodes, rawEdges, layoutOptions);
    return { layoutedNodes: result.nodes, layoutedEdges: result.edges };
  }, [tasks, edgeData, compact]);

  if (tasks.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-sm text-[#9A9A9A] ${className || ""}`}
        style={height ? { height } : undefined}
      >
        {t("tasks.noTasksToDisplay")}
      </div>
    );
  }

  return (
    <div
      className={`rounded-[10px] border border-[#E5E0D8] bg-[#F7F6F3] ${className || ""}`}
      style={height ? { height } : undefined}
    >
      <ReactFlow
        nodes={layoutedNodes}
        edges={layoutedEdges}
        nodeTypes={compact ? compactNodeTypes : nodeTypes}
        onNodeClick={
          onNodeClick
            ? (_event, node) => onNodeClick(node.id)
            : undefined
        }
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        elementsSelectable={!readonly}
        panOnDrag={true}
        zoomOnScroll={true}
      >
        <Background color="#E5E0D8" gap={20} />
        {!readonly && (
          <Controls
            className="[&>button]:border-[#E5E0D8] [&>button]:bg-white [&>button]:text-[#2C2C2C] [&>button:hover]:bg-[#FAF8F4]"
          />
        )}
      </ReactFlow>
    </div>
  );
}

// Re-export for use by the original dag-view.tsx
export { getLayoutedElements, nodeTypes, defaultEdgeStyle, NODE_WIDTH, NODE_HEIGHT };
