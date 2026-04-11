// src/app/(dashboard)/projects/[uuid]/proposals/new/page.tsx
// Server Component - Create New Proposal

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getServerAuthContext } from "@/lib/auth-server";
import { projectExists } from "@/services/project.service";
import { listIdeas } from "@/services/idea.service";
import { CreateProposalForm } from "./create-proposal-form";

interface PageProps {
  params: Promise<{ uuid: string }>;
  searchParams: Promise<{ ideaUuid?: string }>;
}

export default async function NewProposalPage({ params, searchParams }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid } = await params;
  const { ideaUuid } = await searchParams;
  const t = await getTranslations();

  // Validate project exists
  const exists = await projectExists(auth.companyUuid, projectUuid);
  if (!exists) {
    redirect("/projects");
  }

  // Get user's claimed Ideas (only assignees can create Proposals)
  const { ideas } = await listIdeas({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 100,
    assignedToMe: true,
    actorUuid: auth.actorUuid,
    actorType: auth.type,
  });

  // All ideas with resolved elaboration are available (ideas can be reused across proposals)
  const availableIdeas = ideas;

  return (
    <div className="p-8">
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-[#2C2C2C]">
          {t("proposals.createProposal")}
        </h1>
        <CreateProposalForm
          projectUuid={projectUuid}
          availableIdeas={availableIdeas}
          preselectedIdeaUuid={ideaUuid}
        />
      </div>
    </div>
  );
}
