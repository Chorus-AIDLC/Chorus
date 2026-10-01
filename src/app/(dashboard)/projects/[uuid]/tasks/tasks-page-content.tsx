// src/app/(dashboard)/projects/[uuid]/tasks/tasks-page-content.tsx
// Server Component — shared by both /tasks and /tasks/[taskUuid] pages

import { getTranslations } from "next-intl/server";
import { Clock } from "lucide-react";
import { listTasks } from "@/services/task.service";
import { requireProjectPageAccess, requireEntityInProject } from "../access-guard";
import { TaskViewToggle } from "./task-view-toggle";

interface TasksPageContentProps {
  projectUuid: string;
  initialSelectedTaskUuid?: string;
}

export async function TasksPageContent({
  projectUuid,
  initialSelectedTaskUuid,
}: TasksPageContentProps) {
  const t = await getTranslations();

  // Access gate: unauthenticated → /login, no project access → 404
  const { auth } = await requireProjectPageAccess(projectUuid);
  // A deep-linked task must belong to this project and be visible to the caller
  if (initialSelectedTaskUuid) {
    await requireEntityInProject(auth, "task", initialSelectedTaskUuid, projectUuid);
  }

  // Get all Tasks
  const { tasks } = await listTasks({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 1000,
  });

  const totalHours = tasks.reduce((sum, task) => sum + (task.storyPoints || 0), 0);

  return (
    <div className="flex h-full flex-col p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("tasks.title")}</h1>
          <div className="mt-1 flex items-center gap-4">
            <p className="text-sm text-muted-foreground">
              {t("tasks.subtitle")}
            </p>
            {totalHours > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1">
                <Clock className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium text-muted-foreground">
                  <span className="text-foreground">{totalHours.toFixed(1)}</span> {t("tasks.agentHours")}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Task Views: Kanban / DAG */}
      <TaskViewToggle projectUuid={projectUuid} initialTasks={tasks} currentUserUuid={auth.actorUuid} initialSelectedTaskUuid={initialSelectedTaskUuid} />
    </div>
  );
}
