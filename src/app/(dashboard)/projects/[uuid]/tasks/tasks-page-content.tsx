// src/app/(dashboard)/projects/[uuid]/tasks/tasks-page-content.tsx
// Server Component — shared by both /tasks and /tasks/[taskUuid] pages

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Clock } from "lucide-react";
import { getServerAuthContext } from "@/lib/auth-server";
import { listTasks } from "@/services/task.service";
import { projectExists } from "@/services/project.service";
import { TaskViewToggle } from "./task-view-toggle";

interface TasksPageContentProps {
  projectUuid: string;
  initialSelectedTaskUuid?: string;
}

export async function TasksPageContent({
  projectUuid,
  initialSelectedTaskUuid,
}: TasksPageContentProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const t = await getTranslations();

  // Validate project exists
  const exists = await projectExists(auth.companyUuid, projectUuid, auth);
  if (!exists) {
    redirect("/projects");
  }

  // Get all Tasks
  const { tasks } = await listTasks({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 1000,
    auth,
  });

  const totalHours = tasks.reduce((sum, task) => sum + (task.storyPoints || 0), 0);

  return (
    <div className="flex h-full flex-col p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("tasks.title")}</h1>
          <div className="mt-1 flex items-center gap-4">
            <p className="text-sm text-[#6B6B6B]">
              {t("tasks.subtitle")}
            </p>
            {totalHours > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-[#F5F2EC] px-3 py-1">
                <Clock className="h-3.5 w-3.5 text-[#C67A52]" />
                <span className="text-xs font-medium text-[#6B6B6B]">
                  <span className="text-[#2C2C2C]">{totalHours.toFixed(1)}</span> {t("tasks.agentHours")}
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
