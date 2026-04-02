// src/app/(dashboard)/projects/[uuid]/dashboard/page.tsx
// Server Component — Project Dashboard with Idea Tracker

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getServerAuthContext } from "@/lib/auth-server";
import { getProject } from "@/services/project.service";
import { ProjectSettingsModal } from "./project-settings-modal";
import { IdeaTracker } from "./idea-tracker";

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export default async function DashboardPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid } = await params;
  const t = await getTranslations();

  const project = await getProject(auth.companyUuid, projectUuid);
  if (!project) {
    redirect("/projects");
  }

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
        <IdeaTracker projectUuid={projectUuid} currentUserUuid={auth.actorUuid} />
      </div>
    </div>
  );
}
