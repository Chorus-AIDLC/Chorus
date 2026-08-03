// Shared Server Component for /dashboard and /dashboard/[ideaUuid]

import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { getDashboardData } from "./dashboard-data";
import { ProjectSettingsModal } from "./project-settings-modal";
import { IdeaTracker } from "./idea-tracker";
import { CollapsibleMarkdown } from "@/components/collapsible-markdown";
import { ProjectCwdSummary } from "./project-cwd-summary";

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
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t("ideaTracker.overview")}</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
              {project.name}
            </h1>
            <ProjectCwdSummary projectUuid={projectUuid} />
          </div>
          {project.description?.trim() ? (
            <CollapsibleMarkdown
              content={project.description}
              className="mt-1 text-[13px] leading-relaxed text-foreground/80 max-w-none"
            />
          ) : (
            <p className="mt-1 text-[13px] text-foreground/80">{t("ideaTracker.overviewSubtitle")}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ProjectSettingsModal projectUuid={projectUuid} projectName={project.name} projectDescription={project.description ?? null} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {/* IdeaTracker reads useSearchParams() (via usePanelUrl) so the idea
            side-panel selection tracks the URL on soft navigation. Next 15
            requires a Suspense boundary above any useSearchParams() consumer,
            else the whole route opts into client-side rendering (+ build
            warning). The fallback fills the same flex cell so the static header
            above streams with no layout jump. */}
        <Suspense fallback={<div className="h-full" />}>
          <IdeaTracker
            projectUuid={projectUuid}
            projectName={project.name}
            currentUserUuid={currentUserUuid}
            initialTrackerData={trackerData}
            initialStatsData={{ stats, recentActivities: activities }}
            initialSelectedIdeaUuid={initialSelectedIdeaUuid}
          />
        </Suspense>
      </div>
    </div>
  );
}
