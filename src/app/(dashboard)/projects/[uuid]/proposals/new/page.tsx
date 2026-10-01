// src/app/(dashboard)/projects/[uuid]/proposals/new/page.tsx
// Server Component - Create New Proposal

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { requireProjectPageAccess } from "../../access-guard";
import { listIdeas } from "@/services/idea.service";
import { CreateProposalForm } from "./create-proposal-form";

interface PageProps {
  params: Promise<{ uuid: string }>;
  searchParams: Promise<{ ideaUuid?: string }>;
}

export default async function NewProposalPage({ params, searchParams }: PageProps) {
  const { uuid: projectUuid } = await params;
  const { ideaUuid } = await searchParams;
  const t = await getTranslations();

  // Access gate: unauthenticated → /login, no project access → 404
  const { auth, accessLevel } = await requireProjectPageAccess(projectUuid);
  // Viewers cannot create proposals (the server rejects it too) — send them back.
  if (accessLevel === "viewer") redirect(`/projects/${projectUuid}/proposals`);

  // Get user's claimed Ideas (only assignees can create Proposals)
  const { ideas } = await listIdeas({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 100,
    assignedToMe: true,
    actorUuid: auth.actorUuid,
    actorType: auth.type,
    ownerUuid: auth.ownerUuid,
  });

  // All ideas with resolved elaboration are available (ideas can be reused across proposals)
  const availableIdeas = ideas;

  return (
    <div className="p-8">
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
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
