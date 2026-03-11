"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { LayoutGrid, GitBranch, Plus, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { KanbanBoard } from "./kanban-board";
import { DagView } from "./dag-view";
import { TaskDetailPanel } from "./task-detail-panel";

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

interface TaskViewToggleProps {
  projectUuid: string;
  initialTasks: Task[];
  currentUserUuid: string;
  initialSelectedTaskUuid?: string | null;
}

// Status color configuration (same as kanban-board)
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

// Status filter tabs for list view
const statusFilters = [
  { id: "all", labelKey: "allStatuses", statuses: [] as string[] },
  { id: "todo", labelKey: "todo", statuses: ["open", "assigned"] },
  { id: "in_progress", labelKey: "inProgress", statuses: ["in_progress"] },
  { id: "to_verify", labelKey: "toVerify", statuses: ["to_verify"] },
  { id: "done", labelKey: "done", statuses: ["done", "closed"] },
];

// Priority color configuration
const priorityColors: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-blue-100 text-blue-700",
};

export function TaskViewToggle({ projectUuid, initialTasks, currentUserUuid, initialSelectedTaskUuid }: TaskViewToggleProps) {
  const t = useTranslations();
  const isMobile = useIsMobile();
  const [view, setView] = useState<"kanban" | "dag" | "list">("kanban");

  const basePath = `/projects/${projectUuid}/tasks`;
  const { selectedId: selectedTaskUuid, openPanel, closePanel } = usePanelUrl(basePath, initialSelectedTaskUuid);

  // Switch to list view on mobile after hydration
  useEffect(() => {
    if (isMobile && view === "kanban") {
      setView("list");
    }
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [dagRefreshKey, setDagRefreshKey] = useState(0);
  const [activeFilter, setActiveFilter] = useState("all");

  const selectedTask = useMemo(
    () => (selectedTaskUuid ? initialTasks.find(t => t.uuid === selectedTaskUuid) ?? null : null),
    [selectedTaskUuid, initialTasks]
  );

  const handleDependencyChange = useCallback(() => {
    setDagRefreshKey(prev => prev + 1);
  }, []);

  const filteredTasks = useMemo(() => {
    const filter = statusFilters.find(f => f.id === activeFilter);
    if (!filter || filter.statuses.length === 0) return initialTasks;
    return initialTasks.filter(task => filter.statuses.includes(task.status));
  }, [initialTasks, activeFilter]);

  return (
    <>
      {/* Toolbar: View Toggle + New Task */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg bg-[#F5F2EC] p-1 w-fit">
          {/* List view button - shown on mobile */}
          {isMobile && (
            <Button
              variant="ghost"
              size="sm"
              className={`h-8 gap-1.5 rounded-md px-3 text-xs ${
                view === "list"
                  ? "bg-white text-[#2C2C2C] shadow-sm"
                  : "text-[#6B6B6B] hover:text-[#2C2C2C]"
              }`}
              onClick={() => setView("list")}
            >
              <List className="h-3.5 w-3.5" />
              {t("tasks.listView")}
            </Button>
          )}
          {/* Kanban button - hidden on mobile */}
          {!isMobile && (
            <Button
              variant="ghost"
              size="sm"
              className={`h-8 gap-1.5 rounded-md px-3 text-xs ${
                view === "kanban"
                  ? "bg-white text-[#2C2C2C] shadow-sm"
                  : "text-[#6B6B6B] hover:text-[#2C2C2C]"
              }`}
              onClick={() => setView("kanban")}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              {t("tasks.kanbanView")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={`h-8 gap-1.5 rounded-md px-3 text-xs ${
              view === "dag"
                ? "bg-white text-[#2C2C2C] shadow-sm"
                : "text-[#6B6B6B] hover:text-[#2C2C2C]"
            }`}
            onClick={() => setView("dag")}
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("tasks.dagView")}
          </Button>
        </div>
        <Button
          className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
          onClick={() => {
            closePanel();
            setShowCreatePanel(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t("tasks.newTask")}
        </Button>
      </div>

      {/* View Content */}
      {view === "list" ? (
        <>
          {/* Status filter tabs */}
          <div className="mb-4 flex gap-1 overflow-x-auto border-b border-[#E5E0D8] pb-2">
            {statusFilters.map((filter) => {
              const count = filter.statuses.length === 0
                ? initialTasks.length
                : initialTasks.filter(task => filter.statuses.includes(task.status)).length;
              return (
                <Button
                  key={filter.id}
                  variant="ghost"
                  size="sm"
                  className={`h-8 shrink-0 rounded-md px-3 text-xs ${
                    activeFilter === filter.id
                      ? "bg-[#F5F2EC] text-[#2C2C2C] font-medium"
                      : "text-[#6B6B6B] hover:text-[#2C2C2C]"
                  }`}
                  onClick={() => setActiveFilter(filter.id)}
                >
                  {filter.id === "all" ? t(`tasks.${filter.labelKey}`) : t(`status.${filter.labelKey}`)}
                  <span className="ml-1.5 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#6B6B6B]">
                    {count}
                  </span>
                </Button>
              );
            })}
          </div>

          {/* Task list */}
          <div className="flex-1 space-y-2 overflow-y-auto">
            {filteredTasks.length === 0 ? (
              <div className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-[#E5E0D8] text-sm text-[#9A9A9A]">
                {t("tasks.noTasks")}
              </div>
            ) : (
              filteredTasks.map((task) => (
                <Card
                  key={task.uuid}
                  className="cursor-pointer border-[#E5E0D8] bg-white p-4 transition-all hover:border-[#C67A52] hover:shadow-sm"
                  onClick={() => openPanel(task.uuid)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h4 className="font-medium text-[#2C2C2C] truncate">{task.title}</h4>
                      {task.description && (
                        <p className="mt-1 line-clamp-1 text-sm text-[#6B6B6B]">
                          {task.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {task.storyPoints != null && task.storyPoints > 0 && (
                        <span className="rounded bg-[#FFF3E0] px-2 py-0.5 text-xs font-medium text-[#E65100]">
                          {task.storyPoints}h
                        </span>
                      )}
                      <Badge className={priorityColors[task.priority] || ""}>
                        {t(`priority.${task.priority}`)}
                      </Badge>
                      <Badge className={statusColors[task.status] || ""}>
                        {t(`status.${statusI18nKeys[task.status] || task.status}`)}
                      </Badge>
                    </div>
                  </div>
                  {task.assignee && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-[#9A9A9A]">
                      <span className="truncate">{task.assignee.name}</span>
                    </div>
                  )}
                </Card>
              ))
            )}
          </div>

          {/* Detail panel for list view */}
          {selectedTask && (
            <TaskDetailPanel
              task={selectedTask}
              projectUuid={projectUuid}
              currentUserUuid={currentUserUuid}
              onClose={closePanel}
              onDependencyChange={handleDependencyChange}
            />
          )}
        </>
      ) : view === "kanban" ? (
        <KanbanBoard
          projectUuid={projectUuid}
          initialTasks={initialTasks}
          currentUserUuid={currentUserUuid}
          selectedTaskUuid={selectedTaskUuid}
          onTaskSelect={openPanel}
          onPanelClose={closePanel}
        />
      ) : (
        <div className="flex flex-1 flex-col">
          <DagView
            projectUuid={projectUuid}
            onTaskSelect={(taskUuid) => openPanel(taskUuid)}
            refreshKey={dagRefreshKey}
          />
          {selectedTask && (
            <TaskDetailPanel
              task={selectedTask}
              projectUuid={projectUuid}
              currentUserUuid={currentUserUuid}
              onClose={closePanel}
              onDependencyChange={handleDependencyChange}
            />
          )}
        </div>
      )}

      {/* Create Task Panel */}
      {showCreatePanel && !selectedTask && (
        <TaskDetailPanel
          task={null}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={() => setShowCreatePanel(false)}
          onCreated={() => setShowCreatePanel(false)}
        />
      )}
    </>
  );
}
