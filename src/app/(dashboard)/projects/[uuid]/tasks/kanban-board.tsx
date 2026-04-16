"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  DragDropContext,
  Droppable,
  Draggable,
  DropResult,
} from "@hello-pangea/dnd";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { Lock, TriangleAlert, Monitor } from "lucide-react";
import { motion, LayoutGroup } from "framer-motion";
import { ANIM } from "@/lib/animation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { moveTaskToColumnAction, forceMoveTaskToColumnAction, fetchTasksAction } from "./actions";
import { clientLogger } from "@/lib/logger-client";
import { TaskDetailPanel } from "./task-detail-panel";
import { getBatchWorkerCountsAction } from "./session-actions";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";

interface Task {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  proposalUuid: string | null;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  dependsOn?: { uuid: string; title: string; status: string }[];
  acceptanceStatus?: string;
  acceptanceSummary?: { total: number; required: number; passed: number; failed: number; pending: number; requiredPassed: number; requiredFailed: number; requiredPending: number };
}

interface BlockerInfo {
  uuid: string;
  title: string;
  status: string;
  assignee: { type: string; uuid: string; name: string } | null;
  sessionCheckin: { sessionUuid: string; sessionName: string } | null;
}

interface KanbanBoardProps {
  projectUuid: string;
  initialTasks: Task[];
  currentUserUuid: string;
  selectedTaskUuid?: string | null;
  onTaskSelect: (taskUuid: string) => void;
  onPanelClose: () => void;
  proposalUuidFilter?: Set<string> | null;
}

// Status color configuration
const statusColors: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  assigned: "bg-[#E3F2FD] text-[#1976D2]",
  in_progress: "bg-[#E8F5E9] text-[#5A9E6F]",
  to_verify: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

// Status to i18n key mapping
const statusI18nKeys: Record<string, string> = {
  open: "open",
  assigned: "assigned",
  in_progress: "inProgress",
  to_verify: "toVerify",
  done: "done",
  closed: "closed",
};

// Blocker status badge colors
const blockerStatusColors: Record<string, string> = {
  in_progress: "bg-[#FFF3E0] text-[#E65100]",
  assigned: "bg-[#E8F5E9] text-[#2E7D32]",
  open: "bg-[#F5F5F5] text-[#6B6B6B]",
  to_verify: "bg-[#E3F2FD] text-[#1565C0]",
};

// Kanban column configuration
const columnConfigs = [
  { id: "todo", labelKey: "todo", statuses: ["open", "assigned"] },
  { id: "in_progress", labelKey: "inProgress", statuses: ["in_progress"] },
  { id: "to_verify", labelKey: "toVerify", statuses: ["to_verify"] },
  { id: "done", labelKey: "done", statuses: ["done", "closed"] },
];

function isTaskBlocked(task: Task): boolean {
  if (!task.dependsOn || task.dependsOn.length === 0) return false;
  return task.dependsOn.some(
    (dep) => dep.status !== "done" && dep.status !== "closed"
  );
}

function getUnresolvedDeps(task: Task): { uuid: string; title: string; status: string }[] {
  if (!task.dependsOn) return [];
  return task.dependsOn.filter(
    (dep) => dep.status !== "done" && dep.status !== "closed"
  );
}

export function KanbanBoard({ projectUuid, initialTasks, currentUserUuid, selectedTaskUuid, onTaskSelect, onPanelClose, proposalUuidFilter }: KanbanBoardProps) {
  const t = useTranslations();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [workerCounts, setWorkerCounts] = useState<Record<string, number>>({});
  const [forceDialogOpen, setForceDialogOpen] = useState(false);
  const [forceDialogTask, setForceDialogTask] = useState<Task | null>(null);
  const [forceDialogBlockers, setForceDialogBlockers] = useState<BlockerInfo[]>([]);
  const [gateDialogOpen, setGateDialogOpen] = useState(false);
  const [gateDialogCriteria, setGateDialogCriteria] = useState<Array<{ uuid: string; description: string; required: boolean; status: string; evidence: string | null }>>([]);
  const [forceMoving, setForceMoving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Refetch tasks locally — no router.refresh() needed
  const refetchTasks = useCallback(async () => {
    const result = await fetchTasksAction(projectUuid);
    if (result.success) {
      const filtered = proposalUuidFilter
        ? result.data.filter(task => task.proposalUuid && proposalUuidFilter.has(task.proposalUuid))
        : result.data;
      setTasks(filtered);
      // Also refresh worker counts with the new task list
      const wcResult = await getBatchWorkerCountsAction(filtered.map((t) => t.uuid));
      if (wcResult.success && wcResult.data) {
        setWorkerCounts(wcResult.data);
      }
    }
  }, [projectUuid, proposalUuidFilter]);

  // SSE: only refetch when task entities change
  useRealtimeEntityTypeEvent("task", refetchTasks);

  // Refetch when proposal filter changes (immediate response, no SSE needed)
  // NOTE: We intentionally do NOT sync from initialTasks prop because pushState
  // sidebar navigation triggers Next.js soft re-render, producing a stale
  // initialTasks snapshot that overwrites fresher SSE-fetched data.
  const filterRef = useRef(proposalUuidFilter);
  useEffect(() => {
    if (filterRef.current !== proposalUuidFilter) {
      filterRef.current = proposalUuidFilter;
      refetchTasks();
    }
  }, [proposalUuidFilter, refetchTasks]);

  // Fetch active worker counts in a single batch query instead of N individual calls
  useEffect(() => {
    if (initialTasks.length === 0) return;

    getBatchWorkerCountsAction(initialTasks.map((t) => t.uuid)).then((result) => {
      if (result.success && result.data) {
        setWorkerCounts(result.data);
      }
    });
  }, [initialTasks]);

  // Derive selectedTask from current tasks — always in sync
  const selectedTask = useMemo(
    () => (selectedTaskUuid ? tasks.find((t) => t.uuid === selectedTaskUuid) ?? null : null),
    [selectedTaskUuid, tasks]
  );

  const getTasksForColumn = (statuses: string[]) => {
    return tasks.filter((task) => statuses.includes(task.status));
  };

  const getColumnHours = (statuses: string[]) => {
    return getTasksForColumn(statuses).reduce(
      (sum, task) => sum + (task.storyPoints || 0),
      0
    );
  };

  const handleDragStart = () => {
    setIsDragging(true);
  };

  const handleDragEnd = async (result: DropResult) => {
    setIsDragging(false);
    const { destination, source, draggableId } = result;

    // Dropped outside a column
    if (!destination) return;

    // Dropped in the same place
    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    const taskUuid = draggableId;
    const newColumnId = destination.droppableId;
    const sourceColumnId = source.droppableId;

    // Find the task
    const task = tasks.find((t) => t.uuid === taskUuid);
    if (!task) return;

    // Determine the new status based on destination column
    let newStatus: string;
    const column = columnConfigs.find((c) => c.id === newColumnId);
    if (newColumnId === "todo") {
      // Keep the original status if moving within todo, or set to open
      newStatus = task.status === "assigned" ? "assigned" : "open";
    } else if (newColumnId === "in_progress") {
      newStatus = "in_progress";
    } else if (newColumnId === "to_verify") {
      newStatus = "to_verify";
    } else if (newColumnId === "done") {
      // If coming from to_verify, set to done, otherwise set to to_verify
      newStatus = task.status === "to_verify" ? "done" : "to_verify";
    } else {
      return;
    }

    // Optimistically update the UI
    setTasks((prev) =>
      prev.map((t) => (t.uuid === taskUuid ? { ...t, status: newStatus } : t))
    );

    // Call the server action
    const result2 = await moveTaskToColumnAction(taskUuid, newColumnId, projectUuid);

    if (!result2.success) {
      // Check if blocked by dependencies
      if ("blocked" in result2 && result2.blocked && "blockers" in result2) {
        // Revert optimistic update
        setTasks((prev) =>
          prev.map((t) =>
            t.uuid === taskUuid ? { ...t, status: task.status } : t
          )
        );
        // Show force move dialog
        setForceDialogTask(task);
        setForceDialogBlockers(result2.blockers as BlockerInfo[]);
        setForceDialogOpen(true);
        return;
      }

      // Revert on other errors
      setTasks((prev) =>
        prev.map((t) =>
          t.uuid === taskUuid ? { ...t, status: task.status } : t
        )
      );

      // Show gate blocked dialog with criteria details
      if ("gateBlocked" in result2 && result2.gateBlocked) {
        const criteria = "unresolvedCriteria" in result2 && Array.isArray(result2.unresolvedCriteria) ? result2.unresolvedCriteria : [];
        setGateDialogCriteria(criteria as Array<{ uuid: string; description: string; required: boolean; status: string; evidence: string | null }>);
        setGateDialogOpen(true);
      }
    } else {
      // Refetch tasks to get the latest data (local update, no full-page refresh)
      refetchTasks();
    }
  };

  const handleForceMove = async () => {
    if (!forceDialogTask) return;
    setForceMoving(true);
    try {
      const result = await forceMoveTaskToColumnAction(
        forceDialogTask.uuid,
        "in_progress"
      );
      if (result.success) {
        setForceDialogOpen(false);
        setForceDialogTask(null);
        setForceDialogBlockers([]);
        refetchTasks();
      } else {
        clientLogger.error("Failed to force move task:", result.error);
      }
    } finally {
      setForceMoving(false);
    }
  };

  const handleForceMoveCancel = () => {
    setForceDialogOpen(false);
    setForceDialogTask(null);
    setForceDialogBlockers([]);
  };

  return (
    <>
    <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <LayoutGroup>
      <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
        {columnConfigs.map((column) => {
          const columnTasks = getTasksForColumn(column.statuses);
          return (
            <div
              key={column.id}
              className="flex w-[300px] flex-shrink-0 flex-col rounded-xl bg-[#F5F2EC] p-4"
            >
              {/* Column Header */}
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-[#2C2C2C]">{t(`status.${column.labelKey}`)}</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                    {columnTasks.length}
                  </span>
                </div>
                {getColumnHours(column.statuses) > 0 && (
                  <span className="flex items-center gap-1 text-xs text-[#9A9A9A]">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3 w-3"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    {getColumnHours(column.statuses)}h
                  </span>
                )}
              </div>

              {/* Droppable Area */}
              <Droppable droppableId={column.id}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`flex-1 space-y-3 overflow-y-auto min-h-[100px] rounded-lg pt-3 pr-3 transition-colors ${
                      snapshot.isDraggingOver ? "bg-[#E5E0D8]" : ""
                    }`}
                  >
                    {columnTasks.length === 0 && !snapshot.isDraggingOver ? (
                      <div
                        className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-[#E5E0D8] text-sm text-[#9A9A9A]"
                      >
                        {t("tasks.noTasks")}
                      </div>
                    ) : (
                      columnTasks.map((task, index) => {
                        const blocked = isTaskBlocked(task);
                        const unresolvedDeps = blocked ? getUnresolvedDeps(task) : [];
                        const blockerNames = unresolvedDeps.map((d) => d.title).join(", ");

                        return (
                        <Draggable
                          key={task.uuid}
                          draggableId={task.uuid}
                          index={index}
                        >
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              onClick={() => {
                                if (!snapshot.isDragging) {
                                  onTaskSelect(task.uuid);
                                }
                              }}
                              style={provided.draggableProps.style}
                            >
                              <motion.div
                                className="relative"
                                layoutId={isDragging ? undefined : `task-card-${task.uuid}`}
                                transition={ANIM.spring}
                              >
                                {workerCounts[task.uuid] > 0 && (
                                  <div className="absolute -top-3 -right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full border-2 border-green-400 bg-white shadow-sm">
                                    <img src="/typing-animation.gif" alt="" className="h-8 w-8" />
                                  </div>
                                )}
                              <PresenceIndicator entityType="task" entityUuid={task.uuid}>
                              <Card
                                className={`cursor-pointer p-4 transition-all ${
                                  blocked
                                    ? "border-dashed border-[#D1D1D1] opacity-60"
                                    : "border-[#E5E0D8] hover:border-[#C67A52]"
                                } bg-white hover:shadow-sm ${
                                  snapshot.isDragging
                                    ? "shadow-lg rotate-2"
                                    : ""
                                }`}
                              >
                                <div className="mb-2 flex items-start justify-between">
                                  <Badge
                                    className={
                                      statusColors[task.status] || ""
                                    }
                                  >
                                    {t(`status.${statusI18nKeys[task.status] || task.status}`)}
                                  </Badge>
                                  <div className="flex items-center gap-1.5">
                                    {task.storyPoints && (
                                    <span className="flex items-center gap-1 rounded bg-[#FFF3E0] px-2 py-0.5 text-xs font-medium text-[#E65100]">
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="h-3 w-3"
                                      >
                                        <circle cx="12" cy="12" r="10" />
                                        <polyline points="12 6 12 12 16 14" />
                                      </svg>
                                      {task.storyPoints}h
                                    </span>
                                    )}
                                  </div>
                                </div>
                                <h4 className="mb-1 font-medium text-[#2C2C2C]">
                                  {task.title}
                                </h4>
                                {task.description && (
                                  <p className="mb-2 line-clamp-2 text-sm text-[#6B6B6B]">
                                    {task.description}
                                  </p>
                                )}

                                {/* Blocked banner */}
                                {blocked && (
                                  <div className="mb-2 flex items-center gap-1.5 rounded-md bg-[#FFF3E0] px-2 py-1">
                                    <Lock className="h-3 w-3 shrink-0 text-[#E65100]" />
                                    <span className="text-[9px] font-medium leading-tight text-[#E65100] line-clamp-1">
                                      {t("tasks.blockedBy", { tasks: blockerNames })}
                                    </span>
                                  </div>
                                )}

                                <div className="flex items-center justify-between text-xs text-[#9A9A9A]">
                                  {task.assignee ? (
                                    <span className="flex items-center gap-1">
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="h-3 w-3"
                                      >
                                        <path d="M12 8V4H8" />
                                        <rect
                                          width="16"
                                          height="12"
                                          x="4"
                                          y="8"
                                          rx="2"
                                        />
                                      </svg>
                                      {task.assignee.name}
                                    </span>
                                  ) : task.status === "open" ? (
                                    <span className="text-[#C67A52]">
                                      {t("common.assign")}
                                    </span>
                                  ) : (
                                    <span>{t("common.unassigned")}</span>
                                  )}
                                  <span className="flex items-center gap-1">
                                    {workerCounts[task.uuid] > 0 && (
                                      <Badge variant="outline" className="h-4 gap-1 border-green-300 px-1.5 text-[10px] text-green-700">
                                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                                        {t("sessions.workerCount", { count: workerCounts[task.uuid] })}
                                      </Badge>
                                    )}
                                    {task.acceptanceSummary && task.acceptanceSummary.total > 0 && (() => {
                                      const s = task.acceptanceSummary;
                                      const isVerifyCol = task.status === "to_verify";
                                      const allPassed = s.requiredPassed === s.required && s.required > 0;
                                      const hasFailed = s.requiredFailed > 0;
                                      let badgeClass = "bg-[#F5F2EC] text-[#9A9A9A]";
                                      if (isVerifyCol) {
                                        badgeClass = allPassed
                                          ? "bg-green-50 text-green-700"
                                          : hasFailed
                                            ? "bg-red-50 text-[#C4574C]"
                                            : "bg-amber-50 text-[#D97706]";
                                      }
                                      return (
                                        <Badge className={`h-4 gap-1 border-0 px-1.5 text-[9px] ${badgeClass}`}>
                                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                                          {s.passed}/{s.total}
                                        </Badge>
                                      );
                                    })()}
                                  </span>
                                </div>
                              </Card>
                              </PresenceIndicator>
                              </motion.div>
                            </div>
                          )}
                        </Draggable>
                      );
                      })
                    )}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          );
        })}
      </div>
      </LayoutGroup>
    </DragDropContext>

    {/* Task Detail Panel - View/Edit */}
    {selectedTask && (
      <TaskDetailPanel
        task={selectedTask}
        projectUuid={projectUuid}
        currentUserUuid={currentUserUuid}
        onClose={onPanelClose}
      />
    )}

    {/* Force Move Dialog */}
    <Dialog open={forceDialogOpen} onOpenChange={(open) => { if (!open) handleForceMoveCancel(); }}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5 text-[#E65100]" />
            {t("tasks.dependencyBlocked")}
          </DialogTitle>
          <DialogDescription>
            {t("tasks.dependencyBlockedDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-[#FAF8F4] p-3">
          <p className="mb-2 text-xs font-medium text-[#6B6B6B]">
            {t("tasks.blockerList")}
          </p>
          <div className="space-y-2">
            {forceDialogBlockers.map((blocker) => (
              <div
                key={blocker.uuid}
                className="flex items-center justify-between rounded-lg border border-[#E5E0D8] bg-white p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#2C2C2C]">
                    {blocker.title}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    {blocker.assignee && (
                      <span className="text-xs text-[#6B6B6B]">
                        {blocker.assignee.name}
                      </span>
                    )}
                    {blocker.sessionCheckin && (
                      <span className="flex items-center gap-1 text-xs text-[#6B6B6B]">
                        <Monitor className="h-3 w-3" />
                        {blocker.sessionCheckin.sessionName}
                      </span>
                    )}
                  </div>
                </div>
                <Badge
                  className={`shrink-0 ${blockerStatusColors[blocker.status] || "bg-[#F5F5F5] text-[#6B6B6B]"}`}
                >
                  {t(`status.${statusI18nKeys[blocker.status] || blocker.status}`)}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleForceMoveCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            className="bg-[#E65100] hover:bg-[#BF4400] text-white"
            onClick={handleForceMove}
            disabled={forceMoving}
          >
            {forceMoving ? t("common.processing") : t("tasks.forceMove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Acceptance Criteria Gate Dialog */}
    <Dialog open={gateDialogOpen} onOpenChange={setGateDialogOpen}>
      <DialogContent className="max-w-[520px] rounded-2xl p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2.5">
            <TriangleAlert className="h-5 w-5 text-[#C4574C]" />
            {t("acceptanceCriteria.title")}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-[#6B6B6B]">
            {t("acceptanceCriteria.gateBlocked", { count: gateDialogCriteria.filter(c => c.required && c.status !== "passed").length })}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-4 space-y-3">
          <p className="text-[11px] font-semibold text-[#9A9A9A] uppercase tracking-wide">
            {t("acceptanceCriteria.title")}
          </p>
          {gateDialogCriteria.map((criterion) => (
            <div
              key={criterion.uuid}
              className={`rounded-lg border p-3 space-y-2 ${
                criterion.status === "failed"
                  ? "border-red-200 bg-white"
                  : "border-[#E5E0D8] bg-white"
              }`}
            >
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full shrink-0 ${
                  criterion.status === "failed" ? "bg-[#C4574C]" : "bg-[#F59E0B]"
                }`} />
                <span className="text-xs font-semibold text-[#2C2C2C]">{criterion.description}</span>
              </div>
              <div className="flex items-center gap-2 pl-4">
                <Badge className={`text-[10px] border-0 ${
                  criterion.status === "failed"
                    ? "bg-red-50 text-[#C4574C]"
                    : "bg-amber-50 text-[#D97706]"
                }`}>
                  {t(`acceptanceCriteria.status.${criterion.status}`)}
                </Badge>
                <Badge className="text-[10px] border-0 bg-[#FAF8F4] text-[#9A9A9A]">
                  {criterion.required ? t("acceptanceCriteria.required") : t("acceptanceCriteria.optional")}
                </Badge>
                {!criterion.evidence && (
                  <span className="text-[10px] italic text-[#9A9A9A]">
                    {t("acceptanceCriteria.noEvidence")}
                  </span>
                )}
              </div>
              {criterion.evidence && (
                <div className="rounded-md bg-red-50 p-2 ml-4">
                  <span className="text-[10px] font-medium text-[#9A9A9A]">{t("acceptanceCriteria.verifyEvidence")}</span>
                  <p className="text-[11px] text-[#2C2C2C] mt-0.5">{criterion.evidence}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="border-t border-[#E5E2DC] px-6 py-4">
          <Button className="rounded-lg bg-[#C4574C] hover:bg-[#A3433A] text-white" onClick={() => setGateDialogOpen(false)}>
            {t("acceptanceCriteria.dismiss")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    </>
  );
}
