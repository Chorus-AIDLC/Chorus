// Shared Server Component for /dashboard and /dashboard/[ideaUuid]

import { getTranslations } from "next-intl/server";
import { getDashboardData } from "./dashboard-data";
import { ProjectSettingsModal } from "./project-settings-modal";
import { IdeaTracker } from "./idea-tracker";

interface DashboardContentProps {
  projectUuid: string;
  initialSelectedIdeaUuid?: string;
}

export async function DashboardContent({ projectUuid, initialSelectedIdeaUuid }: DashboardContentProps) {
  const t = await getTranslations();
  const { project, trackerData, stats, activities, currentUserUuid } = await getDashboardData(projectUuid);

  return (
    <div className="flex h-full flex-col gap-5 p-5 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#A8A39B]">{t("ideaTracker.overview")}</p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-[#2C2C2A]">{project.name}</h1>
          <p className="mt-1 text-[13px] text-[#5F5E5A]">
            {project.description?.trim() ? project.description : t("ideaTracker.overviewSubtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ProjectSettingsModal projectUuid={projectUuid} projectName={project.name} projectDescription={project.description ?? null} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <IdeaTracker
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          initialTrackerData={trackerData}
          initialStatsData={{ stats, recentActivities: activities }}
          initialSelectedIdeaUuid={initialSelectedIdeaUuid}
        />
      </div>
    </div>
  );
}
