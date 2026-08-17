"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, ChevronLeft, ChevronDown, ListChecks, Check, User } from "lucide-react";
import Link from "next/link";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { getBatchWorkerCountsAction } from "@/app/(dashboard)/projects/[uuid]/tasks/session-actions";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { isAgentAssignee } from "@/lib/assignee-identity";
import { getTaskStatusDotColor, type FlatTask } from "../utils";

interface TaskListViewProps {
  tasks: FlatTask[];
  projectUuid: string;
  proposalUuids: string[];
  onSelectTask: (taskUuid: string) => void;
}

const STATUS_ORDER = ["in_progress", "to_verify", "open", "assigned", "done", "closed"] as const;

function getStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case "in_progress":
      return t("panel.taskList.inProgress");
    case "to_verify":
      return t("panel.taskList.toVerify");
    case "open":
      return t("panel.taskList.open");
    case "assigned":
      return t("panel.taskList.assigned");
    case "done":
      return t("panel.taskList.done");
    case "closed":
      return t("panel.taskList.closed");
    default:
      return status;
  }
}

export function TaskListView({ tasks, projectUuid, proposalUuids, onSelectTask }: TaskListViewProps) {
  const t = useTranslations("ideaTracker");
  // Worker counts from sessions
  const [workerCounts, setWorkerCounts] = useState<Record<string, number>>({});

  const taskUuids = useMemo(() => tasks.map((t) => t.uuid), [tasks]);

  const fetchWorkerCounts = useCallback(async () => {
    if (taskUuids.length === 0) return;
    const result = await getBatchWorkerCountsAction(taskUuids);
    if (result.success && result.data) {
      setWorkerCounts(result.data);
    }
  }, [taskUuids]);

  useEffect(() => {
    fetchWorkerCounts();
  }, [fetchWorkerCounts]);

  // Re-fetch worker counts on task SSE events (checkin/checkout emit task events)
  useRealtimeEntityTypeEvent("task", fetchWorkerCounts);

  // Group tasks by status, in a specific order
  const grouped = useMemo(() => {
    const groups: { status: string; tasks: FlatTask[] }[] = [];
    for (const status of STATUS_ORDER) {
      const matching = tasks.filter((task) => task.status === status);
      if (matching.length > 0) {
        groups.push({ status, tasks: matching });
      }
    }
    // Handle any statuses not in STATUS_ORDER
    const knownStatuses = new Set<string>(STATUS_ORDER);
    const otherTasks = tasks.filter((task) => !knownStatuses.has(task.status));
    if (otherTasks.length > 0) {
      groups.push({ status: "other", tasks: otherTasks });
    }
    return groups;
  }, [tasks]);

  // Track collapsed groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (status: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  // Aggregate stats
  const stats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === "done" || t.status === "closed").length;
    let acTotal = 0;
    let acPassed = 0;
    let acRequired = 0;
    let acRequiredPassed = 0;
    for (const task of tasks) {
      if (task.acceptanceSummary) {
        acTotal += task.acceptanceSummary.total;
        acPassed += task.acceptanceSummary.passed;
        acRequired += task.acceptanceSummary.required;
        acRequiredPassed += task.acceptanceSummary.requiredPassed;
      }
    }
    return { total, done, acTotal, acPassed, acRequired, acRequiredPassed };
  }, [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <ListChecks className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("panel.taskList.noTasks")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex items-center gap-3 rounded-lg bg-[#FAFAF7] dark:bg-[#1e1e1c] px-3 py-2">
        <span className="text-[12px] text-muted-foreground">
          {t("panel.taskList.summary", { done: stats.done, total: stats.total })}
        </span>
        {stats.acTotal > 0 && (
          <>
            <span className="text-[12px] text-muted-foreground">&middot;</span>
            <span className="text-[12px] text-muted-foreground">
              {t("panel.taskList.acSummary", { passed: stats.acRequiredPassed, total: stats.acRequired })}
            </span>
          </>
        )}
        {proposalUuids.length > 0 && (
          <Link
            href={`/projects/${projectUuid}/tasks?proposalUuids=${proposalUuids.join(",")}`}
            className="ml-auto flex items-center gap-1 text-[13px] font-medium text-primary shrink-0"
          >
            {t("panel.taskList.viewKanban")}
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      {grouped.map((group) => {
        const isCollapsed = collapsedGroups.has(group.status);

        return (
          <div key={group.status}>
            {/* Group header */}
            <button
              onClick={() => toggleGroup(group.status)}
              className="flex items-center gap-2 w-full text-left py-1.5 group cursor-pointer"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={`h-2 w-2 rounded-full shrink-0 ${getTaskStatusDotColor(group.status)}`} />
              <span className="text-[13px] font-medium text-foreground">
                {getStatusLabel(group.status, t)}
              </span>
              <span className="text-[11px] text-muted-foreground ml-auto">
                {group.tasks.length}
              </span>
            </button>

            {/* Task items */}
            {!isCollapsed && (
              <div className="ml-3 space-y-0.5">
                {group.tasks.map((task) => {
                  const workers = workerCounts[task.uuid] || 0;
                  const ac = task.acceptanceSummary;

                  return (
                    <PresenceIndicator key={task.uuid} entityType="task" entityUuid={task.uuid} badgeInside>
                      <button
                        onClick={() => onSelectTask(task.uuid)}
                        className="flex items-center gap-2 w-full text-left rounded-md px-2.5 py-2 hover:bg-secondary transition-colors group cursor-pointer"
                      >
                        <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0 group-hover:text-primary" />
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${getTaskStatusDotColor(task.status)}`} />
                        <span className="flex-1 text-[13px] text-foreground truncate group-hover:text-primary">
                          {task.title}
                        </span>

                        {/* AC progress pill */}
                        {ac && ac.total > 0 && (
                          <span className="inline-flex items-center gap-0.5 shrink-0 rounded-full bg-[#F0EDE8] dark:bg-[#1f1e1c] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            <Check className="h-2.5 w-2.5" />
                            {ac.requiredPassed}/{ac.required}
                          </span>
                        )}

                        {/* Assignee */}
                        {task.assignee && (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-muted-foreground max-w-[72px] truncate" title={task.assignee.name}>
                            {isAgentAssignee(task.assignee) ? (
                              <AgentAvatar name={task.assignee.name} size={14} className="shrink-0 rounded-full" />
                            ) : (
                              <User className="h-2.5 w-2.5 shrink-0" />
                            )}
                            {task.assignee.name.split(/[@\s]/)[0]}
                          </span>
                        )}

                        {/* Worker count */}
                        {workers > 0 && (
                          <span className="inline-flex items-center justify-center h-4 min-w-[16px] rounded-full bg-[#E8F5E9] dark:bg-[#14281a] text-[#2E7D32] dark:text-[#5FD07E] text-[9px] font-semibold shrink-0" title={t("panel.taskList.workersActive", { count: workers })}>
                            {workers}
                          </span>
                        )}
                      </button>
                    </PresenceIndicator>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
