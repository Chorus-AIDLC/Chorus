"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { getProjectDependenciesAction } from "./actions";
import { addTaskDependencyAction } from "./[taskUuid]/dependency-actions";

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

interface TaskNodeData {
  title: string;
  status: string;
  priority: string;
  proposalUuid: string | null;
  [key: string]: unknown;
}

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = useTranslations();
  const borderColor = statusBorderColors[data.status] || "#E5E0D8";

  return (
    <div
      className="rounded-lg border-2 bg-white px-4 py-3 shadow-sm min-w-[200px] max-w-[260px]"
      style={{ borderColor }}
    >
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

const nodeTypes = { taskNode: TaskNode };

const NODE_WIDTH = 240;
const NODE_HEIGHT = 80;

function getLayoutedElements(
  nodes: Node<TaskNodeData>[],
  edges: Edge[]
): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 80 });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
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
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

interface DagViewProps {
  projectUuid: string;
  onTaskSelect: (taskUuid: string) => void;
  refreshKey?: number;
}

const defaultEdgeStyle = {
  animated: true,
  style: { stroke: "#C67A52", strokeWidth: 2 },
  markerEnd: { type: "arrowclosed" as const, color: "#C67A52" },
};

export function DagView({ projectUuid, onTaskSelect, refreshKey }: DagViewProps) {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Parse proposalUuids from URL search params
  const proposalUuids = useMemo(() => {
    const param = searchParams.get("proposalUuids");
    if (!param) return null;
    const uuids = param.split(",").filter(Boolean);
    return uuids.length > 0 ? new Set(uuids) : null;
  }, [searchParams]);

  const loadDag = useCallback(async () => {
    setIsLoading(true);
    const data = await getProjectDependenciesAction(projectUuid);

    let filteredNodes = data.nodes;
    let filteredEdgeData = data.edges;

    // Filter by proposalUuids if set
    if (proposalUuids) {
      filteredNodes = data.nodes.filter(
        (n) => n.proposalUuid !== null && proposalUuids.has(n.proposalUuid)
      );
      const visibleNodeIds = new Set(filteredNodes.map((n) => n.uuid));
      filteredEdgeData = data.edges.filter(
        (e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)
      );
    }

    const rawNodes: Node<TaskNodeData>[] = filteredNodes.map((n) => ({
      id: n.uuid,
      type: "taskNode",
      position: { x: 0, y: 0 },
      data: { title: n.title, status: n.status, priority: n.priority, proposalUuid: n.proposalUuid },
    }));

    // edges: from = taskUuid (depends on), to = dependsOnUuid
    // In visualization: dependsOnUuid -> taskUuid (arrow from dependency to dependent)
    const rawEdges: Edge[] = filteredEdgeData.map((e, i) => ({
      id: `e-${i}`,
      source: e.to,    // dependsOnUuid (the upstream task)
      target: e.from,   // taskUuid (the task that depends on it)
      ...defaultEdgeStyle,
    }));

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(rawNodes, rawEdges);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
    setIsLoading(false);
  }, [projectUuid, proposalUuids, setNodes, setEdges]);

  useEffect(() => {
    loadDag();
  }, [loadDag, refreshKey]);

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      setError(null);

      // source = upstream task (dependsOnUuid), target = downstream task (taskUuid)
      const taskUuid = connection.target;
      const dependsOnUuid = connection.source;

      const result = await addTaskDependencyAction(taskUuid, dependsOnUuid);
      if (!result.success) {
        setError(result.error || t("tasks.failedToAddDep"));
        return;
      }

      // Reload the full DAG to get proper layout
      await loadDag();
    },
    [loadDag]
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<TaskNodeData>) => {
      onTaskSelect(node.id);
    },
    [onTaskSelect]
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[#9A9A9A]" />
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[#9A9A9A]">
        {t("tasks.noTasksToDisplay")}
      </div>
    );
  }

  return (
    <div className="flex-1 rounded-xl border border-[#E5E0D8] bg-[#FAFAF8] relative">
      {error && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-xs text-red-700 shadow-sm">
          {error}
          <button className="ml-2 font-medium hover:text-red-900" onClick={() => setError(null)}>x</button>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#E5E0D8" gap={20} />
        <Controls
          className="[&>button]:border-[#E5E0D8] [&>button]:bg-white [&>button]:text-[#2C2C2C] [&>button:hover]:bg-[#FAF8F4]"
        />
      </ReactFlow>
    </div>
  );
}
