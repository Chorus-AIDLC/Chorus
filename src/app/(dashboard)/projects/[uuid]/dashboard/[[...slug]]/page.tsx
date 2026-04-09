// src/app/(dashboard)/projects/[uuid]/dashboard/[[...slug]]/page.tsx
// Server Component — Project Dashboard with Idea Tracker
// Optional catch-all: /dashboard (no idea) or /dashboard/{ideaUuid} (deep link)

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getServerAuthContext } from "@/lib/auth-server";
import { getProject, getProjectStats } from "@/services/project.service";
import { getTrackerGroups } from "@/services/idea.service";
import { listActivitiesWithActorNames } from "@/services/activity.service";
import { ProjectSettingsModal } from "../project-settings-modal";
import { IdeaTracker } from "../idea-tracker";

interface PageProps {
  params: Promise<{ uuid: string; slug?: string[] }>;
}

export default async function DashboardPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid, slug } = await params;
  const initialSelectedIdeaUuid = slug?.[0] ?? null;
  const t = await getTranslations();

  const project = await getProject(auth.companyUuid, projectUuid);
  if (!project) {
    redirect("/projects");
  }

  // Fetch initial data server-side — no loading spinner on first render
  const [trackerData, stats, { activities }] = await Promise.all([
    getTrackerGroups(auth.companyUuid, projectUuid),
    getProjectStats(auth.companyUuid, projectUuid),
    listActivitiesWithActorNames({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip: 0,
      take: 5,
    }),
  ]);

  return (
    <div className="flex h-full flex-col gap-5 bg-[#F7F6F3] p-5 md:p-6">
      {/* Title Section */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium text-[#2C2C2A]">
            {t("ideaTracker.overview")}
          </h1>
          <p className="mt-1 text-[13px] text-[#5F5E5A]">
            {t("ideaTracker.overviewSubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ProjectSettingsModal
            projectUuid={projectUuid}
            projectName={project.name}
            projectDescription={project.description ?? null}
          />
        </div>
      </div>

      {/* Idea Tracker */}
      <div className="min-h-0 flex-1">
        <IdeaTracker
          projectUuid={projectUuid}
          currentUserUuid={auth.actorUuid}
          initialTrackerData={trackerData}
          initialStatsData={{ stats, recentActivities: activities }}
          initialSelectedIdeaUuid={initialSelectedIdeaUuid}
        />
      </div>
    </div>
  );
}
