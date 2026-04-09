"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, ChevronDown, ListChecks } from "lucide-react";
import { getTaskStatusDotColor, type FlatTask } from "../utils";

interface TaskListViewProps {
  tasks: FlatTask[];
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

export function TaskListView({ tasks, onSelectTask }: TaskListViewProps) {
  const t = useTranslations("ideaTracker");

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

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <ListChecks className="h-8 w-8 text-[#D9D9D9]" />
        <p className="text-sm text-[#9A9A9A]">{t("panel.taskList.noTasks")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {grouped.map((group) => {
        const isCollapsed = collapsedGroups.has(group.status);

        return (
          <div key={group.status}>
            {/* Group header */}
            <button
              onClick={() => toggleGroup(group.status)}
              className="flex items-center gap-2 w-full text-left py-1.5 group"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 text-[#9A9A9A]" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-[#9A9A9A]" />
              )}
              <span className={`h-2 w-2 rounded-full shrink-0 ${getTaskStatusDotColor(group.status)}`} />
              <span className="text-[13px] font-medium text-[#2C2C2C]">
                {getStatusLabel(group.status, t)}
              </span>
              <span className="text-[11px] text-[#9A9A9A] ml-auto">
                {group.tasks.length}
              </span>
            </button>

            {/* Task items */}
            {!isCollapsed && (
              <div className="ml-3 space-y-0.5">
                {group.tasks.map((task) => (
                  <button
                    key={task.uuid}
                    onClick={() => onSelectTask(task.uuid)}
                    className="flex items-center gap-2.5 w-full text-left rounded-md px-2.5 py-2 hover:bg-[#F5F2EC] transition-colors group"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${getTaskStatusDotColor(task.status)}`} />
                    <span className="flex-1 text-[13px] text-[#2C2C2C] truncate group-hover:text-[#C67A52]">
                      {task.title}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-[#D9D9D9] shrink-0 group-hover:text-[#C67A52]" />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
