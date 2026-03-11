"use client";

import { useState, useTransition, useCallback, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { FileText, ListTodo, Zap, Plus, ChevronDown, ChevronRight, ClipboardCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  addDocumentDraftAction,
  updateDocumentDraftAction,
  removeDocumentDraftAction,
  updateTaskDraftAction,
} from "./actions";
import { TaskDraftDetailPanel } from "./task-draft-detail-panel";

interface DocumentDraft {
  uuid: string;
  type: string;
  title: string;
  content: string;
}

interface AcceptanceCriteriaItem {
  description: string;
  required?: boolean;
}

interface TaskDraft {
  uuid: string;
  title: string;
  description?: string;
  storyPoints?: number;
  priority?: string;
  acceptanceCriteria?: string;
  acceptanceCriteriaItems?: AcceptanceCriteriaItem[];
  dependsOnDraftUuids?: string[];
}

// Priority color mapping (Industrial Humanist palette)
const priorityColors: Record<string, { bg: string; text: string }> = {
  high: { bg: "bg-[#FFEBEE]", text: "text-[#C4574C]" },
  medium: { bg: "bg-[#FFF3E0]", text: "text-[#E65100]" },
  low: { bg: "bg-[#F5F2EC]", text: "text-[#6B6B6B]" },
};

// Document type display labels
const docTypeKeys: Record<string, string> = {
  prd: "Prd",
  tech_design: "TechDesign",
  adr: "Adr",
  spec: "Spec",
  guide: "Guide",
};

// ===== DAG View Components =====

const NODE_WIDTH = 240;
const NODE_HEIGHT = 80;

interface TaskDraftNodeData {
  title: string;
  priority: string;
  [key: string]: unknown;
}

function TaskDraftNode({ data }: NodeProps<Node<TaskDraftNodeData>>) {
  const t = useTranslations();
  const prio = priorityColors[data.priority || "medium"] || priorityColors.medium;

  return (
    <div className="rounded-lg border-2 border-[#E5E2DC] bg-white px-4 py-3 shadow-sm min-w-[200px] max-w-[260px] cursor-pointer hover:border-[#C67A52] transition-colors">
      <Handle type="target" position={Position.Top} className="!bg-[#C67A52] !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1.5">
        {data.priority && (
          <Badge className={`text-[10px] border-0 ${prio.bg} ${prio.text}`}>
            {t(`priority.${data.priority}`)}
          </Badge>
        )}
      </div>
      <p className="text-xs font-medium text-[#2C2C2C] leading-snug line-clamp-2">
        {data.title}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-[#C67A52] !w-2 !h-2" />
    </div>
  );
}

const dagNodeTypes = { taskDraftNode: TaskDraftNode };

const defaultEdgeStyle = {
  animated: true,
  style: { stroke: "#C67A52", strokeWidth: 2 },
  markerEnd: { type: "arrowclosed" as const, color: "#C67A52" },
};

function getLayoutedElements(
  nodes: Node<TaskDraftNodeData>[],
  edges: Edge[]
): { nodes: Node<TaskDraftNodeData>[]; edges: Edge[] } {
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

// ===== Main Component =====

interface ProposalEditorProps {
  proposalUuid: string;
  projectUuid: string;
  status: string;
  documentDrafts: DocumentDraft[] | null;
  taskDrafts: TaskDraft[] | null;
}

export function ProposalEditor({
  proposalUuid,
  status,
  documentDrafts,
  taskDrafts,
}: ProposalEditorProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // View toggle state
  const [taskView, setTaskView] = useState<"cards" | "dag">("cards");

  // Document content expand state
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());

  // Document draft dialog state
  const [showDocDialog, setShowDocDialog] = useState(false);
  const [editingDoc, setEditingDoc] = useState<DocumentDraft | null>(null);
  const [docType, setDocType] = useState("prd");
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");

  // Task draft sidebar panel state
  const [selectedTaskDraftUuid, setSelectedTaskDraftUuid] = useState<string | null>(null);
  const [showCreateTaskPanel, setShowCreateTaskPanel] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [dagError, setDagError] = useState<string | null>(null);

  // Only allow editing for draft proposals
  const canEdit = status === "draft";

  // Derive selected task draft from taskDrafts
  const selectedTaskDraft = useMemo(() => {
    if (!selectedTaskDraftUuid || !taskDrafts) return null;
    return taskDrafts.find((t) => t.uuid === selectedTaskDraftUuid) || null;
  }, [selectedTaskDraftUuid, taskDrafts]);

  // ===== DAG State (reactive) =====
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskDraftNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!taskDrafts || taskDrafts.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const rawNodes: Node<TaskDraftNodeData>[] = taskDrafts.map((task) => ({
      id: task.uuid,
      type: "taskDraftNode",
      position: { x: 0, y: 0 },
      data: { title: task.title, priority: task.priority || "medium" },
    }));

    const rawEdges: Edge[] = [];
    taskDrafts.forEach((task) => {
      if (task.dependsOnDraftUuids) {
        task.dependsOnDraftUuids.forEach((depUuid, i) => {
          rawEdges.push({
            id: `e-${task.uuid}-${i}`,
            source: depUuid,      // upstream (dependency)
            target: task.uuid,    // downstream (depends on it)
            ...defaultEdgeStyle,
          });
        });
      }
    });

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(rawNodes, rawEdges);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [taskDrafts, setNodes, setEdges]);

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target || !canEdit) return;
      if (connection.source === connection.target) return;
      setDagError(null);

      // source = upstream (dependsOnUuid), target = downstream (taskUuid)
      const taskUuid = connection.target;
      const dependsOnUuid = connection.source;

      // Find the target task draft
      const targetTask = taskDrafts?.find((t) => t.uuid === taskUuid);
      if (!targetTask) return;

      const existingDeps = targetTask.dependsOnDraftUuids || [];

      // Check for duplicate
      if (existingDeps.includes(dependsOnUuid)) {
        setDagError(t("proposals.dependencyExists"));
        return;
      }

      // Simple cycle detection: check if adding this edge would create a cycle
      const wouldCycle = (start: string, target: string): boolean => {
        const visited = new Set<string>();
        const queue = [start];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current === target) return true;
          if (visited.has(current)) continue;
          visited.add(current);
          const task = taskDrafts?.find((t) => t.uuid === current);
          if (task?.dependsOnDraftUuids) {
            queue.push(...task.dependsOnDraftUuids);
          }
        }
        return false;
      };

      if (wouldCycle(dependsOnUuid, taskUuid)) {
        setDagError(t("proposals.cyclicDependency"));
        return;
      }

      const newDeps = [...existingDeps, dependsOnUuid];

      startTransition(async () => {
        const result = await updateTaskDraftAction(proposalUuid, taskUuid, {
          dependsOnDraftUuids: newDeps,
        });
        if (result.success) {
          router.refresh();
        } else {
          setDagError(result.error || t("proposals.failedToAddDependency"));
        }
      });
    },
    [canEdit, taskDrafts, proposalUuid, router, startTransition, t]
  );

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setShowCreateTaskPanel(false);
    setSelectedTaskDraftUuid(node.id);
  }, []);

  // Toggle document expand
  const toggleDocExpand = (uuid: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  // Document draft handlers
  const openAddDocDialog = () => {
    setEditingDoc(null);
    setDocType("prd");
    setDocTitle("");
    setDocContent("");
    setShowDocDialog(true);
  };

  const openEditDocDialog = (doc: DocumentDraft) => {
    setEditingDoc(doc);
    setDocType(doc.type);
    setDocTitle(doc.title);
    setDocContent(doc.content);
    setShowDocDialog(true);
  };

  const handleSaveDoc = () => {
    if (!docTitle.trim()) {
      setError(t("proposals.titleRequired"));
      return;
    }

    setError(null);
    startTransition(async () => {
      let result;
      if (editingDoc) {
        result = await updateDocumentDraftAction(proposalUuid, editingDoc.uuid, {
          type: docType,
          title: docTitle.trim(),
          content: docContent,
        });
      } else {
        result = await addDocumentDraftAction(proposalUuid, {
          type: docType,
          title: docTitle.trim(),
          content: docContent,
        });
      }

      if (result.success) {
        setShowDocDialog(false);
        router.refresh();
      } else {
        setError(result.error || t("proposals.failedToSaveDocDraft"));
      }
    });
  };

  const handleDeleteDoc = (doc: DocumentDraft) => {
    if (!confirm(t("common.confirmDelete"))) return;

    startTransition(async () => {
      const result = await removeDocumentDraftAction(proposalUuid, doc.uuid);
      if (result.success) {
        router.refresh();
      }
    });
  };

  const hasDocuments = documentDrafts && documentDrafts.length > 0;
  const hasTasks = taskDrafts && taskDrafts.length > 0;

  // Show panel: either selected task or create mode
  const showPanel = selectedTaskDraftUuid !== null || showCreateTaskPanel;

  return (
    <>
      {/* Document Drafts Section */}
      <Card className="border-[#E5E2DC] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b border-[#F5F2EC] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FileText className="h-[18px] w-[18px] text-[#C67A52]" />
            <CardTitle className="text-sm font-semibold text-foreground">
              {t("proposals.documentDrafts")}
            </CardTitle>
            <Badge variant="secondary" className="border-0 bg-[#F5F2EC] text-[11px] font-medium text-muted-foreground">
              {documentDrafts?.length || 0}
            </Badge>
          </div>
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={openAddDocDialog}
              className="h-7 gap-1 text-xs font-medium text-[#C67A52] hover:bg-[#FFFBF8] hover:text-[#C67A52]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("proposals.addDocumentDraft")}
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {hasDocuments ? (
            <div className="space-y-0 divide-y divide-[#F5F2EC]">
              {documentDrafts.map((doc) => {
                const isExpanded = expandedDocs.has(doc.uuid);
                return (
                  <div key={doc.uuid} className="px-5 py-4">
                    {/* Document header row */}
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => toggleDocExpand(doc.uuid)}
                        className="flex items-center gap-2.5 text-left cursor-pointer hover:opacity-80 transition-opacity"
                      >
                        <span className="text-muted-foreground">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </span>
                        <Badge variant="outline" className="text-[10px] font-medium text-[#6B6B6B] border-[#E5E2DC] bg-[#FAF8F4]">
                          {t(`proposals.docType${docTypeKeys[doc.type] || "Guide"}`)}
                        </Badge>
                        <span className="text-[13px] font-medium text-foreground">{doc.title}</span>
                      </button>
                      {canEdit && (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditDocDialog(doc)}
                            className="h-6 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {t("proposals.editDraft")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteDoc(doc)}
                            disabled={isPending}
                            className="h-6 text-[11px] text-[#C4574C] hover:bg-[#FFEBEE] hover:text-[#C4574C]"
                          >
                            {t("proposals.deleteDraft")}
                          </Button>
                        </div>
                      )}
                    </div>
                    {/* Document content (collapsible) */}
                    {isExpanded && doc.content && (
                      <div className="mt-3 border-t border-[#F5F2EC] pt-4">
                        <div className="prose prose-sm max-w-none text-foreground">
                          <Streamdown plugins={{ code }}>{doc.content}</Streamdown>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-8">
              <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#F5F2EC]">
                <FileText className="h-[18px] w-[18px] text-[#D0CCC4]" />
              </div>
              <p className="text-[13px] text-muted-foreground">{t("proposals.emptyContainer")}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task Drafts Section */}
      <Card className="border-[#E5E2DC] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
        <CardHeader className="flex-row items-center justify-between border-b border-[#F5F2EC] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ListTodo className="h-[18px] w-[18px] text-[#C67A52]" />
            <CardTitle className="text-sm font-semibold text-foreground">
              {t("proposals.taskDrafts")}
            </CardTitle>
            <Badge className="border-0 bg-[#C67A5220] text-[11px] font-semibold text-[#C67A52]">
              {taskDrafts?.length || 0}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            {/* View Toggle */}
            {hasTasks && (
              <div className="flex rounded-lg bg-[#F5F2EC] p-0.5">
                <button
                  onClick={() => setTaskView("cards")}
                  className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors ${
                    taskView === "cards"
                      ? "bg-white text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t("proposals.cardsView")}
                </button>
                <button
                  onClick={() => setTaskView("dag")}
                  className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors ${
                    taskView === "dag"
                      ? "bg-white text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  DAG
                </button>
              </div>
            )}
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedTaskDraftUuid(null);
                  setShowCreateTaskPanel(true);
                }}
                className="h-7 gap-1 text-xs font-medium text-[#C67A52] hover:bg-[#FFFBF8] hover:text-[#C67A52]"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("proposals.addTaskDraft")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {hasTasks ? (
            taskView === "cards" ? (
              /* Cards View */
              <div className="space-y-2.5 p-5">
                {taskDrafts.map((task) => {
                  const prio = priorityColors[task.priority || "medium"] || priorityColors.medium;
                  const depCount = task.dependsOnDraftUuids?.length || 0;
                  const isSelected = selectedTaskDraftUuid === task.uuid;
                  return (
                    <div
                      key={task.uuid}
                      onClick={() => {
                        setShowCreateTaskPanel(false);
                        setSelectedTaskDraftUuid(task.uuid);
                      }}
                      className={`cursor-pointer rounded-[10px] border bg-white p-3.5 transition-colors ${
                        isSelected
                          ? "border-[#C67A52] shadow-sm"
                          : "border-[#E5E2DC] hover:border-[#C67A52]/50"
                      }`}
                    >
                      {/* Task title */}
                      <div className="mb-1.5">
                        <span className="text-[13px] font-medium leading-snug text-foreground">{task.title}</span>
                      </div>

                      {/* Task description */}
                      {task.description && (
                        <p className="mb-3 text-[11px] leading-relaxed text-[#6B6B6B]">{task.description}</p>
                      )}

                      {/* Acceptance criteria (legacy markdown) */}
                      {task.acceptanceCriteria && (
                        <div className="mb-3 rounded-lg bg-[#F5F2EC] p-3">
                          <div className="mb-1 text-[10px] font-medium text-muted-foreground">
                            {t("tasks.acceptanceCriteria")}
                          </div>
                          <div className="prose prose-sm max-w-none text-[11px] text-[#6B6B6B]">
                            <Streamdown plugins={{ code }}>{task.acceptanceCriteria}</Streamdown>
                          </div>
                        </div>
                      )}

                      {/* Acceptance criteria items (structured) */}
                      {task.acceptanceCriteriaItems && task.acceptanceCriteriaItems.length > 0 && (
                        <div className="mb-3 rounded-lg bg-[#F5F2EC] p-3">
                          <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                            <ClipboardCheck className="h-2.5 w-2.5" />
                            {t("acceptanceCriteria.title")}
                          </div>
                          <div className="space-y-1">
                            {task.acceptanceCriteriaItems.map((item, idx) => (
                              <div key={idx} className="flex items-center gap-2 text-[11px]">
                                <span className="flex-1 text-[#6B6B6B]">{item.description}</span>
                                <Badge
                                  className={`text-[9px] font-medium border-0 shrink-0 ${
                                    (item.required ?? true)
                                      ? "bg-[#FFF3E0] text-[#E65100]"
                                      : "bg-white text-[#9A9A9A]"
                                  }`}
                                >
                                  {(item.required ?? true) ? t("acceptanceCriteria.required") : t("acceptanceCriteria.optional")}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Footer: badges + story points */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {task.priority && (
                            <Badge className={`text-[10px] font-medium border-0 ${prio.bg} ${prio.text}`}>
                              {t(`priority.${task.priority}`)}
                            </Badge>
                          )}
                          {depCount > 0 && (
                            <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground border-[#E5E2DC]">
                              {depCount} {depCount === 1 ? "dep" : "deps"}
                            </Badge>
                          )}
                        </div>
                        {task.storyPoints != null && task.storyPoints > 0 && (
                          <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                            <Zap className="h-2.5 w-2.5 text-[#C67A52]" />
                            {task.storyPoints} SP
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* DAG View */
              <div className="h-[400px] relative">
                {dagError && (
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-xs text-red-700 shadow-sm">
                    {dagError}
                    <button className="ml-2 font-medium hover:text-red-900" onClick={() => setDagError(null)}>x</button>
                  </div>
                )}
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={onNodeClick}
                  nodeTypes={dagNodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.3 }}
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
            )
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-8">
              <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#F5F2EC]">
                <ListTodo className="h-[18px] w-[18px] text-[#D0CCC4]" />
              </div>
              <p className="text-[13px] text-muted-foreground">{t("proposals.emptyContainer")}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Document Draft Dialog */}
      <Dialog open={showDocDialog} onOpenChange={setShowDocDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingDoc ? t("proposals.editDraft") : t("proposals.addDocumentDraft")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="mb-2 block text-muted-foreground">
                {t("proposals.documentType")}
              </Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger className="border-[#E5E2DC]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prd">{t("proposals.docTypePrd")}</SelectItem>
                  <SelectItem value="tech_design">{t("proposals.docTypeTechDesign")}</SelectItem>
                  <SelectItem value="adr">{t("proposals.docTypeAdr")}</SelectItem>
                  <SelectItem value="spec">{t("proposals.docTypeSpec")}</SelectItem>
                  <SelectItem value="guide">{t("proposals.docTypeGuide")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-2 block text-muted-foreground">
                {t("proposals.documentTitle")} *
              </Label>
              <Input
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                placeholder={t("proposals.titlePlaceholder")}
                className="border-[#E5E2DC]"
              />
            </div>
            <div>
              <Label className="mb-2 block text-muted-foreground">
                {t("proposals.documentContent")}
              </Label>
              <Textarea
                value={docContent}
                onChange={(e) => setDocContent(e.target.value)}
                className="h-64 resize-none border-[#E5E2DC] font-mono"
                placeholder="# Document Title&#10;&#10;Write your content in Markdown..."
              />
            </div>
            {error && (
              <div className="rounded-lg bg-[#FFEBEE] p-3 text-sm text-[#C4574C]">{error}</div>
            )}
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowDocDialog(false)}
                disabled={isPending}
                className="border-[#E5E2DC]"
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleSaveDoc}
                disabled={isPending}
                className="bg-[#C67A52] text-white hover:bg-[#B56A42]"
              >
                {isPending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Task Draft Detail Panel (sidebar) */}
      {showPanel && (
        <TaskDraftDetailPanel
          taskDraft={showCreateTaskPanel ? null : selectedTaskDraft}
          allTaskDrafts={taskDrafts || []}
          proposalUuid={proposalUuid}
          canEdit={canEdit}
          onClose={() => {
            setSelectedTaskDraftUuid(null);
            setShowCreateTaskPanel(false);
          }}
          onSaved={() => {
            // After create, close the create panel
            if (showCreateTaskPanel) {
              setShowCreateTaskPanel(false);
            }
          }}
          onDeleted={() => {
            setSelectedTaskDraftUuid(null);
            setShowCreateTaskPanel(false);
          }}
        />
      )}
    </>
  );
}
