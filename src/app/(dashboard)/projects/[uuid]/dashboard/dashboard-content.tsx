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
    <div className="flex h-full flex-col gap-5 bg-[#F7F6F3] p-5 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium text-[#2C2C2A]">{t("ideaTracker.overview")}</h1>
          <p className="mt-1 text-[13px] text-[#5F5E5A]">{t("ideaTracker.overviewSubtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
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
