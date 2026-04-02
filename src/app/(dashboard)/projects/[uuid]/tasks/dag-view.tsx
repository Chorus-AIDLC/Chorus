"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type Connection,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  nodeTypes,
  defaultEdgeStyle,
  getLayoutedElements,
  type TaskNodeData,
} from "@/components/task-dag";
import { getProjectDependenciesAction } from "./actions";
import { addTaskDependencyAction } from "./[taskUuid]/dependency-actions";

interface DagViewProps {
  projectUuid: string;
  onTaskSelect: (taskUuid: string) => void;
  refreshKey?: number;
}

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
          <Button variant="ghost" size="icon" className="ml-2 h-5 w-5 font-medium hover:text-red-900" onClick={() => setError(null)}><X className="h-3 w-3" /></Button>
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
