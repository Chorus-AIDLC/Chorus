// src/app/(dashboard)/projects/[uuid]/proposals/page.tsx
// Server Component - Proposal Kanban Board

import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getServerAuthContext } from "@/lib/auth-server";
import { listProposals } from "@/services/proposal.service";
import { projectExists } from "@/services/project.service";
import { ProposalKanban } from "./proposal-kanban";

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export default async function ProposalsPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid } = await params;
  const t = await getTranslations();

  const exists = await projectExists(auth.companyUuid, projectUuid, auth);
  if (!exists) {
    redirect("/projects");
  }

  const { proposals } = await listProposals({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 1000,
  });

  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  return (
    <div className="flex h-full flex-col p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("proposals.pageTitle")}</h1>
          <p className="mt-1 text-[13px] text-[#6B6B6B]">
            {t("proposals.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <Badge className="bg-[#C67A52] text-white border-transparent px-2.5 py-1 text-xs font-medium">
              {pendingCount} {t("proposals.pendingReview")}
            </Badge>
          )}
          <Button asChild className="bg-[#C67A52] hover:bg-[#B56A42] text-white">
            <Link href={`/projects/${projectUuid}/proposals/new`}>
              <Plus className="mr-2 h-4 w-4" />
              {t("proposals.createProposal")}
            </Link>
          </Button>
        </div>
      </div>

      {/* Kanban Board */}
      <ProposalKanban projectUuid={projectUuid} proposals={proposals} />
    </div>
  );
}
